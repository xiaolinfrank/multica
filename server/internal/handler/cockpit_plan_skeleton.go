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
// their issue's filing scope (project/module/status).
func (h *Handler) publishRefiledWorkItemIssue(r *http.Request, cc cockpitContext, row db.MoveFilingScopeRow) {
	h.publish(h.workItemChangedEvent(cc, row.ID, row.Number, row.Status, row.Revision, row.ProjectID, row.ModuleID, row.WorkItemID))
}

// workItemChangedEvent is the single payload shape for "your issue's filing
// moved because of a plan edit". Caches key off number, status and revision, so
// every producer must send them: the move and the work-item delete share this
// constructor.
func (h *Handler) workItemChangedEvent(cc cockpitContext, id pgtype.UUID, number int32, status string, revision int64, projectID, moduleID, workItemID pgtype.UUID) (string, string, string, string, any) {
	return protocol.EventIssueUpdated, uuidToString(cc.workspaceID), "member", uuidToString(cc.member.UserID), map[string]any{
		"issue": map[string]any{
			"id": uuidToString(id), "number": number, "status": status, "revision": revision,
			"project_id": uuidToPtr(projectID), "module_id": uuidToPtr(moduleID), "work_item_id": uuidToPtr(workItemID),
		},
		"work_item_changed": true,
	}
}
