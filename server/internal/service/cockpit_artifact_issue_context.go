package service

import (
	"context"
	"encoding/json"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"strings"
)

func (s *IssueService) ListCockpitIssueArtifactContexts(ctx context.Context, ws, issue, actor pgtype.UUID, cursor string, size int32) (CockpitIssueArtifactContextPage, error) {
	size, err := planningPageSize(size)
	if err != nil {
		return CockpitIssueArtifactContextPage{}, err
	}
	scope := planningHash([]any{"issue-artifact-context", ws, issue, size})
	key, err := readOverviewCursor(cursor, scope)
	if err != nil {
		return CockpitIssueArtifactContextPage{}, err
	}
	if key != "" {
		parts := strings.Split(key, ":")
		if len(parts) != 2 || (parts[0] != "artifact" && parts[0] != "artifact_version" && parts[0] != "acceptance_request") {
			return CockpitIssueArtifactContextPage{}, ErrCockpitWorkflowInput
		}
		if _, err = util.ParseUUID(parts[1]); err != nil {
			return CockpitIssueArtifactContextPage{}, ErrCockpitWorkflowInput
		}
	}
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return CockpitIssueArtifactContextPage{}, err
	}
	defer tx.Rollback(ctx)
	if err = cockpitWorkflowMember(ctx, q, ws, actor); err != nil {
		return CockpitIssueArtifactContextPage{}, err
	}
	if _, err = q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: ws, ID: issue}); err != nil {
		return CockpitIssueArtifactContextPage{}, cockpitWorkflowError(err)
	}
	payload, err := q.ListCockpitIssueArtifactContexts(ctx, db.ListCockpitIssueArtifactContextsParams{WorkspaceID: ws, IssueID: issue, CursorKey: key, PageLimit: size + 1})
	if err != nil {
		return CockpitIssueArtifactContextPage{}, err
	}
	var raw struct {
		FormalReview *CockpitIssueFormalReview `json:"formal_review"`
		Items        []struct {
			CockpitIssueArtifactContext
			SortKey string `json:"sort_key"`
		}
		Total int64
	}
	if err = json.Unmarshal(payload, &raw); err != nil {
		return CockpitIssueArtifactContextPage{}, err
	}
	out := CockpitIssueArtifactContextPage{WorkspaceID: util.UUIDToString(ws), IssueID: util.UUIDToString(issue), Items: []CockpitIssueArtifactContext{}, Total: raw.Total, FormalReview: raw.FormalReview}
	if len(raw.Items) > int(size) {
		raw.Items = raw.Items[:size]
		out.NextCursor = makeOverviewCursor(scope, raw.Items[len(raw.Items)-1].SortKey)
	}
	for _, r := range raw.Items {
		out.Items = append(out.Items, r.CockpitIssueArtifactContext)
	}
	return out, tx.Commit(ctx)
}
