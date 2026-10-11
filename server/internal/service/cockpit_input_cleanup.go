package service

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// DeleteCockpitInputsForWorkspace runs inside the existing workspace teardown
// transaction, before artifact sources are removed. Owned object intents remain
// sanitized and retryable so an upload finishing after deletion is still owned.
func DeleteCockpitInputsForWorkspace(ctx context.Context, q *db.Queries, workspaceID pgtype.UUID) error {
	if err := q.SetCockpitInputTeardownWorkspace(ctx, util.UUIDToString(workspaceID)); err != nil {
		return err
	}
	if _, err := q.RetireCockpitInputWorkspaceTransfers(ctx, workspaceID); err != nil {
		return err
	}
	for _, remove := range []func(context.Context, pgtype.UUID) error{
		q.DeleteCockpitInputWorkspaceReferences,
		q.DeleteCockpitInputWorkspaceManifestItems,
		q.DeleteCockpitInputWorkspaceManifests,
		q.DeleteCockpitInputWorkspaceManifestVersions,
		q.DeleteCockpitInputWorkspaceVersions,
		q.DeleteCockpitInputWorkspaceHeaders,
	} {
		if err := remove(ctx, workspaceID); err != nil {
			return err
		}
	}
	return nil
}
