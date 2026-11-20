package handler

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5/pgtype"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// ensurePlanSkeleton keeps a freshly created project/module visible in the
// plan tree without a separate write path (implementation plan §2.3). It is
// best-effort: the same rows are added by the next plan read, and the create
// that called it has already committed, so a failure is logged rather than
// turned into an error for a write that succeeded.
func (h *Handler) ensurePlanSkeleton(ctx context.Context, workspaceID pgtype.UUID) {
	if h.IssueService == nil {
		return
	}
	if _, err := h.IssueService.EnsureCockpitPlanSkeleton(ctx, workspaceID); err != nil {
		slog.Warn("ensure plan skeleton failed", "workspace_id", uuidToString(workspaceID), "error", err)
	}
}

// publishRefiledWorkItemIssue tells issue subscribers that a plan edit moved
// their issue's filing scope (project/module/status), with the same payload
// shape the subtree refile uses.
func (h *Handler) publishRefiledWorkItemIssue(r *http.Request, cc cockpitContext, row db.MoveFilingScopeRow) {
	if h.Bus == nil {
		return
	}
	h.publish(protocol.EventIssueUpdated, uuidToString(cc.workspaceID), "member", uuidToString(cc.member.UserID), map[string]any{
		"issue": map[string]any{
			"id": uuidToString(row.ID), "number": row.Number, "status": row.Status,
			"revision": row.Revision, "project_id": uuidToPtr(row.ProjectID),
			"module_id": uuidToPtr(row.ModuleID), "work_item_id": uuidToPtr(row.WorkItemID),
		},
		"project_changed": true, "module_changed": true,
	})
}
