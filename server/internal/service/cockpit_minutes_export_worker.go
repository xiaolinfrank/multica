package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/cockpitnas"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// CockpitMinutesExportWorker uses a durable lease and a no-overwrite exporter.
// A filesystem syscall can outlive ctx or its lease. It never gets an unbounded
// detached goroutine; another attempt converges on the same immutable bytes,
// while the expired token cannot settle a newer or deleted operation row.
type CockpitMinutesExportWorker struct {
	queries  *db.Queries
	exporter cockpitnas.Exporter
	bus      *events.Bus
}

func NewCockpitMinutesExportWorker(q *db.Queries, exporter cockpitnas.Exporter, bus *events.Bus) *CockpitMinutesExportWorker {
	return &CockpitMinutesExportWorker{queries: q, exporter: exporter, bus: bus}
}

func (w *CockpitMinutesExportWorker) Run(ctx context.Context) {
	if w == nil || w.queries == nil || w.exporter == nil {
		return
	}
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		for i := 0; i < 10 && ctx.Err() == nil; i++ {
			worked, err := w.ProcessNext(ctx)
			if err != nil && ctx.Err() == nil {
				slog.Warn("cockpit NAS export worker failed", "error", err)
			}
			if err != nil || !worked {
				break
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (w *CockpitMinutesExportWorker) ProcessNext(ctx context.Context) (bool, error) {
	if w == nil || w.queries == nil || w.exporter == nil {
		return false, errors.New("cockpit NAS export worker is not configured")
	}
	rootIDs := w.exporter.RootIDs()
	if len(rootIDs) == 0 {
		return false, nil
	}
	row, err := w.queries.ClaimCockpitMinutesExport(ctx, rootIDs)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("claim minutes export: %w", err)
	}
	publishCockpitMinutesExportChanged(w.bus, row, "nas_export_updated")
	if row.Status == "needs_attention" {
		return true, nil
	}
	version, err := w.queries.GetCockpitMinutesVersion(ctx, db.GetCockpitMinutesVersionParams{WorkspaceID: row.WorkspaceID, MeetingID: row.MeetingID, ID: row.VersionID})
	if errors.Is(err, pgx.ErrNoRows) {
		return true, w.fail(ctx, row, "source_unavailable", "The published minutes version is no longer available.", false)
	}
	if err != nil {
		return true, w.fail(ctx, row, "database_unavailable", "Could not read the published minutes version.", true)
	}
	if !version.PublishedAt.Valid || version.Decision != "approved" || version.VersionNumber != row.VersionNumber || version.SourceIssueID != row.SourceIssueID || version.ContentHash != row.ContentHash || minutesContentHash(version.Content) != row.ContentHash {
		return true, w.fail(ctx, row, "source_conflict", "The operation no longer matches the approved published content.", false)
	}
	dest, err := w.exporter.Resolve(util.UUIDToString(row.WorkspaceID), row.Directory, util.UUIDToString(row.VersionID), row.VersionNumber)
	if err != nil {
		return true, w.failExport(ctx, row, err)
	}
	if dest != cockpitMinutesExportDestination(row) {
		return true, w.fail(ctx, row, "destination_changed", "The configured destination changed; this export retains its original target.", false)
	}
	if ctx.Err() != nil {
		// Leave the lease for recovery; never start a write during shutdown.
		return true, ctx.Err()
	}
	result, err := w.exporter.Write(ctx, cockpitnas.Request{
		WorkspaceID: util.UUIDToString(row.WorkspaceID), VersionID: util.UUIDToString(row.VersionID),
		OperationID: util.UUIDToString(row.ID), LeaseToken: util.UUIDToString(row.LeaseToken),
		Content: version.Content, ContentHash: row.ContentHash, Destination: dest,
	})
	if err != nil {
		return true, w.failExport(ctx, row, err)
	}
	if result.Path != row.TargetPath || result.ContentHash != row.ContentHash || result.Size != int64(len([]byte(version.Content))) {
		return true, w.fail(ctx, row, "result_conflict", "The written result did not match the requested destination and content.", false)
	}
	completed, err := w.queries.CompleteCockpitMinutesExport(ctx, db.CompleteCockpitMinutesExportParams{
		ID: row.ID, WorkspaceID: row.WorkspaceID, LeaseToken: row.LeaseToken, SizeBytes: result.Size,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		// Expired/replaced lease or workspace deletion. A completed external
		// write may remain, but cannot recreate or settle the deleted ledger.
		return true, nil
	}
	if err != nil {
		return true, err
	}
	publishCockpitMinutesExportChanged(w.bus, completed, "nas_export_updated")
	return true, nil
}

func (w *CockpitMinutesExportWorker) failExport(ctx context.Context, row db.CockpitMinutesExport, err error) error {
	var typed *cockpitnas.Error
	if errors.As(err, &typed) {
		return w.fail(ctx, row, typed.Code, typed.Message, typed.Retryable)
	}
	// Unexpected adapter errors do not expose arbitrary filesystem details.
	return w.fail(ctx, row, "export_unavailable", "The NAS export could not be completed.", true)
}

func (w *CockpitMinutesExportWorker) fail(ctx context.Context, row db.CockpitMinutesExport, code, message string, retryable bool) error {
	backoff := 5 * time.Second
	for i := int32(1); i < row.CycleAttempts && backoff < 5*time.Minute; i++ {
		backoff *= 2
	}
	if backoff > 5*time.Minute {
		backoff = 5 * time.Minute
	}
	updated, err := w.queries.FailCockpitMinutesExport(ctx, db.FailCockpitMinutesExportParams{
		ID: row.ID, WorkspaceID: row.WorkspaceID, LeaseToken: row.LeaseToken,
		ErrorCode: code, ErrorMessage: message, Retryable: retryable, Backoff: pgInterval(backoff),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err == nil {
		publishCockpitMinutesExportChanged(w.bus, updated, "nas_export_updated")
	}
	return err
}
