package service

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"strings"
	"time"
)

type CockpitArtifactReferenceExistsError struct{ ExistingReferenceID string }

func (e *CockpitArtifactReferenceExistsError) Error() string {
	return "this fixed version already has that active reference"
}
func (e *CockpitArtifactReferenceExistsError) Unwrap() error { return ErrCockpitWorkflowConflict }
func referenceView(id, artifact, version, key, node, meeting, by, removedBy pgtype.UUID, label, purpose string, created, removed pgtype.Timestamptz) CockpitArtifactReference {
	return CockpitArtifactReference{ID: util.UUIDToString(id), ArtifactID: util.UUIDToString(artifact), VersionID: util.UUIDToString(version), ReferenceKey: util.UUIDToString(key), NodeID: planningUUID(node), MeetingID: planningUUID(meeting), TargetLabel: label, Purpose: purpose, CreatedBy: util.UUIDToString(by), CreatedAt: created.Time.UTC().Format(time.RFC3339Nano), RemovedBy: planningUUID(removedBy), RemovedAt: timestamp(removed)}
}
func nodeReferenceView(r db.CockpitArtifactNodeReference) CockpitArtifactReference {
	return referenceView(r.ID, r.ArtifactID, r.VersionID, r.ReferenceKey, r.NodeID, pgtype.UUID{}, r.CreatedBy, r.RemovedBy, r.TargetLabel, r.Purpose, r.CreatedAt, r.RemovedAt)
}
func meetingReferenceView(r db.CockpitArtifactMeetingReference) CockpitArtifactReference {
	return referenceView(r.ID, r.ArtifactID, r.VersionID, r.ReferenceKey, pgtype.UUID{}, r.MeetingID, r.CreatedBy, r.RemovedBy, r.TargetLabel, r.Purpose, r.CreatedAt, r.RemovedAt)
}
func enrichArtifactReferences(ctx context.Context, q *db.Queries, ws pgtype.UUID, items []CockpitArtifactReference) error {
	ids := make([]pgtype.UUID, 0, len(items))
	for _, i := range items {
		id, e := util.ParseUUID(i.VersionID)
		if e != nil {
			return e
		}
		ids = append(ids, id)
	}
	rows, err := q.ListCockpitArtifactVersionMetadataByIDs(ctx, db.ListCockpitArtifactVersionMetadataByIDsParams{WorkspaceID: ws, VersionIds: ids})
	if err != nil {
		return err
	}
	byID := map[string]db.ListCockpitArtifactVersionMetadataByIDsRow{}
	for _, r := range rows {
		byID[util.UUIDToString(r.ID)] = r
	}
	for i := range items {
		v, ok := byID[items[i].VersionID]
		if !ok || util.UUIDToString(v.ArtifactID) != items[i].ArtifactID || !v.ContentHash.Valid {
			return artifactConflict("a fixed reference has lost its version")
		}
		items[i].VersionNumber = v.VersionNumber
		items[i].ContentHash = v.ContentHash.String
	}
	return nil
}
func (s *IssueService) CreateCockpitArtifactReference(ctx context.Context, p CockpitArtifactReferenceCommand, kind string) (CockpitArtifactReferenceResponse, error) {
	if !p.Human {
		return CockpitArtifactReferenceResponse{}, ErrCockpitWorkflowForbidden
	}
	if kind != "node" && kind != "meeting" {
		return CockpitArtifactReferenceResponse{}, ErrCockpitWorkflowInput
	}
	if !p.ReferenceKey.Valid || !p.VersionID.Valid || kind == "node" && (!p.NodeID.Valid || p.MeetingID.Valid) || kind == "meeting" && (!p.MeetingID.Valid || p.NodeID.Valid) {
		return CockpitArtifactReferenceResponse{}, ErrCockpitWorkflowInput
	}
	switch p.Purpose {
	case "input", "output", "evidence", "reference":
	default:
		return CockpitArtifactReferenceResponse{}, ErrCockpitWorkflowInput
	}
	hash := planningHash([]any{p.ActorID, p.ArtifactID, p.VersionID, p.ReferenceKey, p.NodeID, p.MeetingID, p.Purpose, kind})
	tx, q, a, m, err := s.beginArtifact(ctx, p.CockpitArtifactCommand)
	if err != nil {
		return CockpitArtifactReferenceResponse{}, err
	}
	defer tx.Rollback(ctx)

	var item CockpitArtifactReference
	var found bool
	if kind == "node" {
		r, e := q.GetCockpitArtifactNodeReferenceByKey(ctx, db.GetCockpitArtifactNodeReferenceByKeyParams{WorkspaceID: p.WorkspaceID, ReferenceKey: p.ReferenceKey})
		if e == nil {
			if r.ArtifactID != a.ID || r.RequestHash != hash || r.CreatedBy != p.ActorID {
				return CockpitArtifactReferenceResponse{}, ErrCockpitWorkflowConflict
			}
			item = nodeReferenceView(r)
			found = true
		} else if !errors.Is(e, pgx.ErrNoRows) {
			return CockpitArtifactReferenceResponse{}, e
		}
	} else {
		r, e := q.GetCockpitArtifactMeetingReferenceByKey(ctx, db.GetCockpitArtifactMeetingReferenceByKeyParams{WorkspaceID: p.WorkspaceID, ReferenceKey: p.ReferenceKey})
		if e == nil {
			if r.ArtifactID != a.ID || r.RequestHash != hash || r.CreatedBy != p.ActorID {
				return CockpitArtifactReferenceResponse{}, ErrCockpitWorkflowConflict
			}
			item = meetingReferenceView(r)
			found = true
		} else if !errors.Is(e, pgx.ErrNoRows) {
			return CockpitArtifactReferenceResponse{}, e
		}
	}
	if !found {
		if !artifactManager(a, p.ActorID, m.Role, p.Human) {
			return CockpitArtifactReferenceResponse{}, ErrCockpitWorkflowForbidden
		}
		if a.ArchivedAt.Valid {
			return CockpitArtifactReferenceResponse{}, artifactConflict("restore the artifact before adding a reference")
		}
		rows, e := q.ListCockpitArtifactVersionMetadataByIDs(ctx, db.ListCockpitArtifactVersionMetadataByIDsParams{WorkspaceID: p.WorkspaceID, VersionIds: []pgtype.UUID{p.VersionID}})
		if e != nil {
			return CockpitArtifactReferenceResponse{}, e
		}
		if len(rows) != 1 || rows[0].ArtifactID != a.ID {
			return CockpitArtifactReferenceResponse{}, ErrCockpitWorkflowNotFound
		}
		if rows[0].CaptureStatus != "ready" || !rows[0].ContentHash.Valid {
			return CockpitArtifactReferenceResponse{}, artifactConflict("only a fixed, captured version can be referenced")
		}
		if kind == "node" {
			node, _, _, e := requireExecutionLeaf(ctx, q, p.WorkspaceID, p.NodeID)
			if e != nil {
				return CockpitArtifactReferenceResponse{}, e
			}
			old, e := q.GetActiveCockpitArtifactNodeReference(ctx, db.GetActiveCockpitArtifactNodeReferenceParams{WorkspaceID: p.WorkspaceID, VersionID: p.VersionID, NodeID: p.NodeID, Purpose: p.Purpose})
			if e == nil {
				return CockpitArtifactReferenceResponse{}, &CockpitArtifactReferenceExistsError{util.UUIDToString(old.ID)}
			}
			if !errors.Is(e, pgx.ErrNoRows) {
				return CockpitArtifactReferenceResponse{}, e
			}
			r, e := q.CreateCockpitArtifactNodeReference(ctx, db.CreateCockpitArtifactNodeReferenceParams{ID: dbid.NewV7(), WorkspaceID: p.WorkspaceID, ArtifactID: p.ArtifactID, VersionID: p.VersionID, NodeID: p.NodeID, TargetLabel: node.Name, Purpose: p.Purpose, ReferenceKey: p.ReferenceKey, RequestHash: hash, CreatedBy: p.ActorID})
			if e != nil {
				return CockpitArtifactReferenceResponse{}, e
			}
			item = nodeReferenceView(r)
		} else {
			meeting, e := q.GetCockpitMeeting(ctx, db.GetCockpitMeetingParams{WorkspaceID: p.WorkspaceID, ID: p.MeetingID})
			if e != nil {
				return CockpitArtifactReferenceResponse{}, cockpitWorkflowError(e)
			}
			old, e := q.GetActiveCockpitArtifactMeetingReference(ctx, db.GetActiveCockpitArtifactMeetingReferenceParams{WorkspaceID: p.WorkspaceID, VersionID: p.VersionID, MeetingID: p.MeetingID, Purpose: p.Purpose})
			if e == nil {
				return CockpitArtifactReferenceResponse{}, &CockpitArtifactReferenceExistsError{util.UUIDToString(old.ID)}
			}
			if !errors.Is(e, pgx.ErrNoRows) {
				return CockpitArtifactReferenceResponse{}, e
			}
			r, e := q.CreateCockpitArtifactMeetingReference(ctx, db.CreateCockpitArtifactMeetingReferenceParams{ID: dbid.NewV7(), WorkspaceID: p.WorkspaceID, ArtifactID: p.ArtifactID, VersionID: p.VersionID, MeetingID: p.MeetingID, TargetLabel: meeting.Title, Purpose: p.Purpose, ReferenceKey: p.ReferenceKey, RequestHash: hash, CreatedBy: p.ActorID})
			if e != nil {
				return CockpitArtifactReferenceResponse{}, e
			}
			item = meetingReferenceView(r)
		}
	}
	items := []CockpitArtifactReference{item}
	if err = enrichArtifactReferences(ctx, q, p.WorkspaceID, items); err != nil {
		return CockpitArtifactReferenceResponse{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return CockpitArtifactReferenceResponse{}, err
	}
	if !found {
		s.artifactChanged(a, p.ActorID)
	}
	return CockpitArtifactReferenceResponse{WorkspaceID: util.UUIDToString(p.WorkspaceID), Reference: items[0]}, nil
}
func (s *IssueService) RemoveCockpitArtifactReference(ctx context.Context, p CockpitArtifactReferenceCommand, kind string) (CockpitArtifactReferenceResponse, error) {
	if !p.Human {
		return CockpitArtifactReferenceResponse{}, ErrCockpitWorkflowForbidden
	}
	tx, q, a, m, err := s.beginArtifact(ctx, p.CockpitArtifactCommand)
	if err != nil {
		return CockpitArtifactReferenceResponse{}, err
	}
	defer tx.Rollback(ctx)
	if !artifactManager(a, p.ActorID, m.Role, p.Human) {
		return CockpitArtifactReferenceResponse{}, ErrCockpitWorkflowForbidden
	}
	var item CockpitArtifactReference
	switch kind {
	case "node":
		r, e := q.RemoveCockpitArtifactNodeReference(ctx, db.RemoveCockpitArtifactNodeReferenceParams{WorkspaceID: p.WorkspaceID, ArtifactID: p.ArtifactID, ID: p.ReferenceID, RemovedBy: p.ActorID})
		if e != nil {
			return CockpitArtifactReferenceResponse{}, cockpitWorkflowError(e)
		}
		item = nodeReferenceView(r)
	case "meeting":
		r, e := q.RemoveCockpitArtifactMeetingReference(ctx, db.RemoveCockpitArtifactMeetingReferenceParams{WorkspaceID: p.WorkspaceID, ArtifactID: p.ArtifactID, ID: p.ReferenceID, RemovedBy: p.ActorID})
		if e != nil {
			return CockpitArtifactReferenceResponse{}, cockpitWorkflowError(e)
		}
		item = meetingReferenceView(r)
	default:
		return CockpitArtifactReferenceResponse{}, ErrCockpitWorkflowInput
	}
	items := []CockpitArtifactReference{item}
	if err = enrichArtifactReferences(ctx, q, p.WorkspaceID, items); err != nil {
		return CockpitArtifactReferenceResponse{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return CockpitArtifactReferenceResponse{}, err
	}
	s.artifactChanged(a, p.ActorID)
	return CockpitArtifactReferenceResponse{WorkspaceID: util.UUIDToString(p.WorkspaceID), Reference: items[0]}, nil
}
func (s *IssueService) ListCockpitArtifactReferences(ctx context.Context, p CockpitArtifactRead, kind string) (CockpitArtifactReferencePage, error) {
	size, err := planningPageSize(p.PageSize)
	if err != nil {
		return CockpitArtifactReferencePage{}, err
	}
	scope := planningHash([]any{"artifact-references", p.WorkspaceID, p.ArtifactID, kind, size})
	after, _, err := decodePlanningCursor(p.Cursor, scope)
	if err != nil {
		return CockpitArtifactReferencePage{}, err
	}
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return CockpitArtifactReferencePage{}, err
	}
	defer tx.Rollback(ctx)
	if _, err = artifactReadMember(ctx, q, p); err != nil {
		return CockpitArtifactReferencePage{}, err
	}
	if _, err = q.GetCockpitArtifact(ctx, db.GetCockpitArtifactParams{WorkspaceID: p.WorkspaceID, ID: p.ArtifactID}); err != nil {
		return CockpitArtifactReferencePage{}, cockpitWorkflowError(err)
	}
	out := CockpitArtifactReferencePage{WorkspaceID: util.UUIDToString(p.WorkspaceID), ArtifactID: util.UUIDToString(p.ArtifactID), Items: []CockpitArtifactReference{}}
	switch kind {
	case "node":
		rows, e := q.ListCockpitArtifactNodeReferences(ctx, db.ListCockpitArtifactNodeReferencesParams{WorkspaceID: p.WorkspaceID, ArtifactID: p.ArtifactID, AfterID: after, PageLimit: size + 1})
		if e != nil {
			return out, e
		}
		for _, r := range rows {
			out.Items = append(out.Items, nodeReferenceView(r))
		}
		out.Total, err = q.CountCockpitArtifactNodeReferences(ctx, db.CountCockpitArtifactNodeReferencesParams{WorkspaceID: p.WorkspaceID, ArtifactID: p.ArtifactID})
	case "meeting":
		rows, e := q.ListCockpitArtifactMeetingReferences(ctx, db.ListCockpitArtifactMeetingReferencesParams{WorkspaceID: p.WorkspaceID, ArtifactID: p.ArtifactID, AfterID: after, PageLimit: size + 1})
		if e != nil {
			return out, e
		}
		for _, r := range rows {
			out.Items = append(out.Items, meetingReferenceView(r))
		}
		out.Total, err = q.CountCockpitArtifactMeetingReferences(ctx, db.CountCockpitArtifactMeetingReferencesParams{WorkspaceID: p.WorkspaceID, ArtifactID: p.ArtifactID})
	default:
		return out, ErrCockpitWorkflowInput
	}
	if err != nil {
		return out, err
	}
	if len(out.Items) > int(size) {
		out.Items = out.Items[:size]
		id, _ := util.ParseUUID(out.Items[len(out.Items)-1].ID)
		out.NextCursor = encodePlanningCursor(scope, id, 0)
	}
	if err = enrichArtifactReferences(ctx, q, p.WorkspaceID, out.Items); err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}
func (s *IssueService) ListCockpitMeetingArtifactReferences(ctx context.Context, p CockpitMeetingArtifactReferencesRead) (CockpitMeetingArtifactReferencesPage, error) {
	size, err := planningPageSize(p.PageSize)
	if err != nil {
		return CockpitMeetingArtifactReferencesPage{}, err
	}
	scope := planningHash([]any{"meeting-artifacts", p.WorkspaceID, p.MeetingID, p.IncludeRemoved, size})
	after, _, err := decodePlanningCursor(p.Cursor, scope)
	if err != nil {
		return CockpitMeetingArtifactReferencesPage{}, err
	}
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return CockpitMeetingArtifactReferencesPage{}, err
	}
	defer tx.Rollback(ctx)
	if _, err = artifactReadMember(ctx, q, CockpitArtifactRead{WorkspaceID: p.WorkspaceID, ActorID: p.ActorID}); err != nil {
		return CockpitMeetingArtifactReferencesPage{}, err
	}
	if _, err = q.GetCockpitMeeting(ctx, db.GetCockpitMeetingParams{WorkspaceID: p.WorkspaceID, ID: p.MeetingID}); err != nil {
		return CockpitMeetingArtifactReferencesPage{}, cockpitWorkflowError(err)
	}
	rows, err := q.ListCockpitMeetingArtifactReferences(ctx, db.ListCockpitMeetingArtifactReferencesParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, IncludeRemoved: p.IncludeRemoved, AfterID: after, PageLimit: size + 1})
	if err != nil {
		return CockpitMeetingArtifactReferencesPage{}, err
	}
	total, err := q.CountCockpitMeetingArtifactReferences(ctx, db.CountCockpitMeetingArtifactReferencesParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, Column3: p.IncludeRemoved})
	if err != nil {
		return CockpitMeetingArtifactReferencesPage{}, err
	}
	out := CockpitMeetingArtifactReferencesPage{WorkspaceID: util.UUIDToString(p.WorkspaceID), MeetingID: util.UUIDToString(p.MeetingID), IncludeRemoved: p.IncludeRemoved, Items: []CockpitMeetingArtifactReference{}, Total: total}
	if len(rows) > int(size) {
		rows = rows[:size]
		out.NextCursor = encodePlanningCursor(scope, rows[len(rows)-1].ID, 0)
	}
	for _, r := range rows {
		ref := referenceView(r.ID, r.ArtifactID, r.VersionID, r.ReferenceKey, pgtype.UUID{}, r.MeetingID, r.CreatedBy, r.RemovedBy, r.TargetLabel, r.Purpose, r.CreatedAt, r.RemovedAt)
		ref.VersionNumber = r.VersionNumber
		ref.ContentHash = r.ContentHash.String
		out.Items = append(out.Items, CockpitMeetingArtifactReference{CockpitArtifactReference: ref, ArtifactTitle: r.ArtifactTitle})
	}
	return out, tx.Commit(ctx)
}
func (s *IssueService) ListCockpitArtifactSourceAttachments(ctx context.Context, p CockpitArtifactRead) (CockpitArtifactSourceAttachmentPage, error) {
	p.Query = strings.TrimSpace(p.Query)
	if len(p.Query) > 512 {
		return CockpitArtifactSourceAttachmentPage{}, artifactInput("search is limited to 512 bytes")
	}
	size, err := planningPageSize(p.PageSize)
	if err != nil {
		return CockpitArtifactSourceAttachmentPage{}, err
	}
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return CockpitArtifactSourceAttachmentPage{}, err
	}
	defer tx.Rollback(ctx)
	if _, err = artifactReadMember(ctx, q, p); err != nil {
		return CockpitArtifactSourceAttachmentPage{}, err
	}
	a, err := q.GetCockpitArtifact(ctx, db.GetCockpitArtifactParams{WorkspaceID: p.WorkspaceID, ID: p.ArtifactID})
	if err != nil {
		return CockpitArtifactSourceAttachmentPage{}, cockpitWorkflowError(err)
	}
	scope := planningHash([]any{"artifact-attachments", p.WorkspaceID, p.ArtifactID, a.AuthorizedProducerIssueID, p.Query, size})
	after, _, err := decodePlanningCursor(p.Cursor, scope)
	if err != nil {
		return CockpitArtifactSourceAttachmentPage{}, err
	}
	rows, err := q.ListCockpitArtifactSourceAttachments(ctx, db.ListCockpitArtifactSourceAttachmentsParams{WorkspaceID: p.WorkspaceID, IssueID: a.AuthorizedProducerIssueID, Query: p.Query, AfterID: after, PageLimit: size + 1})
	if err != nil {
		return CockpitArtifactSourceAttachmentPage{}, err
	}
	counts, err := q.CountCockpitArtifactSourceAttachments(ctx, db.CountCockpitArtifactSourceAttachmentsParams{WorkspaceID: p.WorkspaceID, IssueID: a.AuthorizedProducerIssueID, Query: p.Query})
	if err != nil {
		return CockpitArtifactSourceAttachmentPage{}, err
	}
	out := CockpitArtifactSourceAttachmentPage{WorkspaceID: util.UUIDToString(p.WorkspaceID), ArtifactID: util.UUIDToString(p.ArtifactID), ProducerIssueID: util.UUIDToString(a.AuthorizedProducerIssueID), Query: p.Query, Items: []CockpitArtifactSourceAttachment{}, Total: counts.Total, FilteredTotal: counts.FilteredTotal}
	if len(rows) > int(size) {
		rows = rows[:size]
		out.NextCursor = encodePlanningCursor(scope, rows[len(rows)-1].ID, 0)
	}
	for _, r := range rows {
		out.Items = append(out.Items, CockpitArtifactSourceAttachment{ID: util.UUIDToString(r.ID), SourceIssueID: util.UUIDToString(r.IssueID), Filename: r.Filename, ContentType: r.ContentType, SizeBytes: r.SizeBytes, CreatedAt: r.CreatedAt.Time.UTC().Format(time.RFC3339Nano)})
	}
	return out, tx.Commit(ctx)
}
