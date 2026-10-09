package service

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/cockpitnas"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type CockpitMinutesExportTarget struct {
	RootID, Directory string
}

type CockpitMinutesExportCommand struct {
	CockpitMinutesVersionCommand
	Target CockpitMinutesExportTarget
}

type CockpitMinutesExportRetry struct {
	WorkspaceID, MeetingID, ExportID, ActorID pgtype.UUID
	ExpectedRevision                          int64
}

// enqueueCockpitMinutesExport only resolves configuration and writes SQL. The
// caller holds the meeting/work-package locks and has authorized publication
// or export of this exact immutable version. There is never NAS I/O in this tx.
func (s *IssueService) enqueueCockpitMinutesExport(ctx context.Context, q *db.Queries, version db.CockpitMinutesVersion, actor pgtype.UUID, target CockpitMinutesExportTarget) (db.CockpitMinutesExport, error) {
	if s.CockpitNASExporter == nil {
		return db.CockpitMinutesExport{}, fmt.Errorf("%w: NAS export is not configured", ErrCockpitWorkflowInput)
	}
	target.RootID = strings.TrimSpace(target.RootID)
	target.Directory = strings.TrimSpace(target.Directory)
	if target.RootID == "" || target.Directory == "" {
		return db.CockpitMinutesExport{}, fmt.Errorf("%w: NAS root_id and directory are required", ErrCockpitWorkflowInput)
	}
	dest, err := s.CockpitNASExporter.Resolve(util.UUIDToString(version.WorkspaceID), target.Directory, util.UUIDToString(version.ID), version.VersionNumber)
	if err != nil {
		return db.CockpitMinutesExport{}, fmt.Errorf("%w: %v", ErrCockpitWorkflowInput, err)
	}
	if dest.RootID != target.RootID {
		return db.CockpitMinutesExport{}, fmt.Errorf("%w: NAS root does not match the configured destination", ErrCockpitWorkflowInput)
	}
	if version.Decision != "approved" || minutesContentHash(version.Content) != version.ContentHash {
		return db.CockpitMinutesExport{}, fmt.Errorf("%w: approved minutes content is inconsistent", ErrCockpitWorkflowConflict)
	}
	existing, err := q.GetCockpitMinutesExportDestination(ctx, db.GetCockpitMinutesExportDestinationParams{
		WorkspaceID: version.WorkspaceID, VersionID: version.ID, RootID: dest.RootID, RelativePath: dest.RelativePath,
	})
	if err == nil {
		if existing.MeetingID != version.MeetingID || existing.ContentHash != version.ContentHash || cockpitMinutesExportDestination(existing) != dest {
			return db.CockpitMinutesExport{}, fmt.Errorf("%w: existing export has a different pinned destination or content", ErrCockpitWorkflowConflict)
		}
		return existing, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return db.CockpitMinutesExport{}, err
	}
	// A new destination must still be the meeting's confirmed directory under
	// the caller's existing meeting lock. A prior natural-key match above is
	// an acknowledgement of the old pinned intent, not a new write elsewhere.
	meeting, err := q.GetCockpitMeeting(ctx, db.GetCockpitMeetingParams{WorkspaceID: version.WorkspaceID, ID: version.MeetingID})
	if err != nil {
		return db.CockpitMinutesExport{}, cockpitWorkflowError(err)
	}
	current, err := s.CockpitNASExporter.Resolve(util.UUIDToString(version.WorkspaceID), meeting.NasDir, util.UUIDToString(version.ID), version.VersionNumber)
	if err != nil || current != dest {
		return db.CockpitMinutesExport{}, fmt.Errorf("%w: the meeting NAS directory changed; refresh its destination before exporting", ErrCockpitWorkflowConflict)
	}
	return q.CreateCockpitMinutesExport(ctx, db.CreateCockpitMinutesExportParams{
		ID: dbid.NewV7(), WorkspaceID: version.WorkspaceID, MeetingID: version.MeetingID,
		VersionID: version.ID, VersionNumber: version.VersionNumber, SourceIssueID: version.SourceIssueID,
		RootID: dest.RootID, RootPath: dest.RootPath, Directory: dest.Directory,
		RelativePath: dest.RelativePath, TargetPath: dest.TargetPath, ContentHash: version.ContentHash, CreatedBy: actor,
	})
}

// ExportCockpitMeetingMinutes can mirror any previously published version;
// replacing the current version does not erase an earlier publication.
func (s *IssueService) ExportCockpitMeetingMinutes(ctx context.Context, p CockpitMinutesExportCommand) (db.CockpitMinutesExport, error) {
	tx, q, work, err := s.beginCockpitWorkflow(ctx, p.CockpitWorkPackageCommand)
	if err != nil {
		return db.CockpitMinutesExport{}, err
	}
	defer tx.Rollback(ctx)
	version, err := q.GetCockpitMinutesVersion(ctx, db.GetCockpitMinutesVersionParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: p.VersionID})
	if err != nil {
		return db.CockpitMinutesExport{}, cockpitWorkflowError(err)
	}
	if err := authorizeCockpitMinutesExport(ctx, q, work, version, p.ActorID); err != nil {
		return db.CockpitMinutesExport{}, err
	}
	row, err := s.enqueueCockpitMinutesExport(ctx, q, version, p.ActorID, p.Target)
	if err != nil {
		return db.CockpitMinutesExport{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return db.CockpitMinutesExport{}, err
	}
	publishCockpitMinutesExportChanged(s.Bus, row, "nas_export_queued")
	return row, nil
}

func authorizeCockpitMinutesExport(ctx context.Context, q *db.Queries, work db.CockpitMeetingWorkPackage, version db.CockpitMinutesVersion, actor pgtype.UUID) error {
	if version.ReviewerID != actor {
		if err := requireCockpitWorkflowManager(ctx, q, work, actor); err != nil {
			return err
		}
	}
	if !version.PublishedAt.Valid || version.Decision != "approved" {
		return fmt.Errorf("%w: only approved, previously published minutes can be exported", ErrCockpitWorkflowConflict)
	}
	return nil
}

// Retry does not retarget the operation or reset its lifetime attempt count.
// A stale revision is a conflict, even if another caller already retried it:
// without a command key there is no reliable basis to acknowledge that intent.
func (s *IssueService) RetryCockpitMinutesExport(ctx context.Context, p CockpitMinutesExportRetry) (db.CockpitMinutesExport, error) {
	if p.ExpectedRevision < 1 {
		return db.CockpitMinutesExport{}, fmt.Errorf("%w: export expected_revision must be positive", ErrCockpitWorkflowInput)
	}
	tx, q, work, err := s.beginCockpitWorkflow(ctx, CockpitWorkPackageCommand{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ActorID: p.ActorID})
	if err != nil {
		return db.CockpitMinutesExport{}, err
	}
	defer tx.Rollback(ctx)
	row, err := q.LockCockpitMinutesExport(ctx, db.LockCockpitMinutesExportParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: p.ExportID})
	if err != nil {
		return db.CockpitMinutesExport{}, cockpitWorkflowError(err)
	}
	version, err := q.GetCockpitMinutesVersion(ctx, db.GetCockpitMinutesVersionParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: row.VersionID})
	if err != nil {
		return db.CockpitMinutesExport{}, cockpitWorkflowError(err)
	}
	if err := authorizeCockpitMinutesExport(ctx, q, work, version, p.ActorID); err != nil {
		return db.CockpitMinutesExport{}, err
	}
	if row.Revision != p.ExpectedRevision {
		return db.CockpitMinutesExport{}, ErrCockpitWorkflowConflict
	}
	if row.Status == "queued" || row.Status == "running" || row.Status == "succeeded" {
		return row, nil
	}
	row, err = q.RetryCockpitMinutesExport(ctx, db.RetryCockpitMinutesExportParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: p.ExportID, Revision: p.ExpectedRevision})
	if err != nil {
		return db.CockpitMinutesExport{}, cockpitWorkflowError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return db.CockpitMinutesExport{}, err
	}
	publishCockpitMinutesExportChanged(s.Bus, row, "nas_export_retried")
	return row, nil
}

func minutesContentHash(content string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(content)))
}

func cockpitMinutesExportDestination(row db.CockpitMinutesExport) cockpitnas.Destination {
	return cockpitnas.Destination{RootID: row.RootID, RootPath: row.RootPath, Directory: row.Directory, RelativePath: row.RelativePath, TargetPath: row.TargetPath}
}

func publishCockpitMinutesExportChanged(bus *events.Bus, row db.CockpitMinutesExport, action string) {
	if bus == nil {
		return
	}
	bus.Publish(events.Event{Type: protocol.EventCockpitChanged, WorkspaceID: util.UUIDToString(row.WorkspaceID), ActorType: "system", Payload: map[string]any{
		"scope": "meeting_workflow", "action": action, "entity": map[string]any{"meeting_id": util.UUIDToString(row.MeetingID)},
	}})
}
