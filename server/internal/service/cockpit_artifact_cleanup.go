package service

import (
	"context"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"path"
	"strings"
	"time"
)

// ProcessNextCockpitArtifactObjectCleanup operates solely on a durable object
// intent. The workspace can already be gone. Unfinished I/O intents remain
// retained instead of falsely claiming an upload was cancelled or cleaned up.
func (s *IssueService) ProcessNextCockpitArtifactObjectCleanup(ctx context.Context) (bool, error) {
	if s.CockpitArtifactStorage == nil {
		return false, nil
	}
	token := dbid.NewV7()
	r, err := s.Queries.ClaimCockpitArtifactObjectCleanup(ctx, token)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	expected := fmt.Sprintf("workspaces/%s/artifact-versions/%s/%s%s", util.UUIDToString(r.WorkspaceID), util.UUIDToString(r.VersionID), util.UUIDToString(r.ID), path.Ext(r.StorageKey))
	var deleteErr error
	if r.StorageKey != expected || path.Clean(r.StorageKey) != r.StorageKey || strings.ContainsAny(r.StorageKey, "\\\x00\r\n") {
		deleteErr = errors.New("refusing artifact cleanup outside its durable version attempt")
	} else {
		ioctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		deleteErr = s.CockpitArtifactStorage.DeleteObject(ioctx, r.StorageKey)
		cancel()
	}
	settle, done := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer done()
	if deleteErr != nil {
		_, err = s.Queries.FailCockpitArtifactObjectCleanup(settle, db.FailCockpitArtifactObjectCleanupParams{ID: r.ID, CleanupToken: token, CleanupError: deleteErr.Error()})
		return true, err
	}
	_, err = s.Queries.CompleteCockpitArtifactObjectCleanup(settle, db.CompleteCockpitArtifactObjectCleanupParams{ID: r.ID, CleanupToken: token})
	return true, err
}
