package service

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func validateArtifactProducerAssignee(ctx context.Context, q *db.Queries, ws, actor pgtype.UUID, kind string, id pgtype.UUID) error {
	payload, err := q.ListCockpitAssigneeChoices(ctx, db.ListCockpitAssigneeChoicesParams{WorkspaceID: ws, Kind: "all", SelectedType: kind, SelectedID: id, RowLimit: 1})
	if err != nil {
		return err
	}
	// Underscored provider flags must not silently default to false.
	var exact struct {
		Items []struct {
			CockpitAssigneeChoice
			Archived        bool      `json:"archived"`
			LeaderMissing   bool      `json:"leader_missing"`
			LeaderArchived  bool      `json:"leader_archived"`
			PermissionAgent *db.Agent `json:"permission_agent"`
		}
	}
	if err = json.Unmarshal(payload, &exact); err != nil {
		return err
	}
	if len(exact.Items) != 1 {
		return artifactConflict("the selected executor is no longer available")
	}
	r := exact.Items[0]
	if r.Archived || r.LeaderMissing || r.LeaderArchived {
		return artifactConflict("the selected executor is archived or unavailable")
	}
	if kind == "member" {
		return artifactReviewer(ctx, q, ws, id)
	}
	if r.RuntimeBound == nil || !*r.RuntimeBound || r.PermissionAgent == nil || !cockpitAssignableAgentStatus(r.PermissionAgent.Status) {
		return artifactConflict("the selected executor needs an available bound runtime")
	}
	allowed, err := memberMayInvokeAgent(ctx, q, *r.PermissionAgent, actor, ws)
	if err != nil {
		return err
	}
	if !allowed {
		return fmt.Errorf("%w: the current actor cannot invoke this executor", ErrCockpitWorkflowForbidden)
	}
	return nil
}
