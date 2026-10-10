package service

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// ReadCockpitArtifactFile only returns a scoped, fixed file descriptor. Storage
// verification happens after this read, outside any business write transaction.
func (s *IssueService) ReadCockpitArtifactFile(ctx context.Context, workspaceID, artifactID, versionID pgtype.UUID) (CockpitArtifactFile, error) {
	v, err := s.Queries.ReadCockpitArtifactFile(ctx, db.ReadCockpitArtifactFileParams{WorkspaceID: workspaceID, ArtifactID: artifactID, ID: versionID})
	if err != nil {
		return CockpitArtifactFile{}, cockpitWorkflowError(err)
	}
	return CockpitArtifactFile{WorkspaceID: util.UUIDToString(v.WorkspaceID), ArtifactID: util.UUIDToString(v.ArtifactID), VersionID: util.UUIDToString(v.ID),
		StorageKey: v.StorageKey.String, ContentHash: v.ContentHash.String, Filename: v.Filename, ContentType: v.ContentType, SizeBytes: v.SizeBytes.Int64, VersionRevision: v.Revision}, nil
}
