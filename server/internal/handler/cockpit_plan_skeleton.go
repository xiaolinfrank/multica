package handler

import (
	"context"
	"log/slog"

	"github.com/jackc/pgx/v5/pgtype"
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
