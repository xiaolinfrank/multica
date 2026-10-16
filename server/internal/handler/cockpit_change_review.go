package handler

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type CockpitChangeReviewPreview struct {
	WorkspaceID  string                       `json:"workspace_id"`
	Change       CockpitPendingChangeResponse `json:"change"`
	CurrentValue string                       `json:"current_value"`
	Conflict     bool                         `json:"conflict"`
	ReviewToken  string                       `json:"review_token"`
	Context      service.CockpitSurfaceScope  `json:"context"`
}

// The token pins the proposal and the field being reviewed. Unrelated fields
// may change without invalidating a reviewed batch targeting the same node.
type cockpitChangeAncestry struct {
	ID, ParentID, ProjectID, ModuleID pgtype.UUID
}

var errCockpitChangeContextInvalid = errors.New("plan ancestry or binding is incomplete")

type cockpitChangeContext struct {
	Ancestry []cockpitChangeAncestry
	Scope    service.CockpitSurfaceScope
}

func cockpitChangeReviewContext(ctx context.Context, q *db.Queries, node db.CockpitNode) (cockpitChangeContext, error) {
	var out cockpitChangeContext
	rows, err := q.ListCockpitSurfaceAncestors(ctx, db.ListCockpitSurfaceAncestorsParams{WorkspaceID: node.WorkspaceID, NodeID: node.ID})
	if err != nil {
		return out, err
	}
	if len(rows) == 0 || rows[len(rows)-1].CockpitNode.ParentID.Valid {
		return out, errCockpitChangeContextInvalid
	}
	out.Ancestry = make([]cockpitChangeAncestry, 0, len(rows))
	byID := make(map[pgtype.UUID]db.CockpitNode, len(rows))
	for _, row := range rows {
		n := row.CockpitNode
		out.Ancestry = append(out.Ancestry, cockpitChangeAncestry{n.ID, n.ParentID, n.ProjectID, n.ModuleID})
		byID[n.ID] = n
	}
	project, module, err := cockpitInheritedBinding(node, byID)
	if err != nil {
		return out, errCockpitChangeContextInvalid
	}
	out.Scope.ProjectID = uuidToPtr(project)
	out.Scope.ModuleID = uuidToPtr(module)
	if project.Valid {
		record, e := q.GetCockpitOverviewProject(ctx, db.GetCockpitOverviewProjectParams{WorkspaceID: node.WorkspaceID, ID: project})
		if errors.Is(e, pgx.ErrNoRows) {
			return out, errCockpitChangeContextInvalid
		}
		if e != nil {
			return out, e
		}
		out.Scope.ProjectTitle = record.Title
	}
	if module.Valid {
		record, e := q.GetModuleInWorkspace(ctx, db.GetModuleInWorkspaceParams{WorkspaceID: node.WorkspaceID, ID: module})
		if errors.Is(e, pgx.ErrNoRows) {
			return out, errCockpitChangeContextInvalid
		}
		if e != nil {
			return out, e
		}
		if record.ProjectID != project {
			return out, errCockpitChangeContextInvalid
		}
		out.Scope.ModuleTitle = record.Title
	}
	return out, nil
}

func cockpitChangeReviewToken(change db.CockpitPendingChange, node db.CockpitNode, context cockpitChangeContext) string {
	b, _ := json.Marshal(struct {
		Change                                         db.CockpitPendingChange
		Context                                        cockpitChangeContext
		NodeID, Code, Name, ProjectID, ModuleID, Value string
	}{change, context, uuidToString(node.ID), node.Code, node.Name, uuidToString(node.ProjectID), uuidToString(node.ModuleID), cockpitNodeFieldValue(node, change.Field)})
	return fmt.Sprintf(`"%x"`, sha256.Sum256(b))
}

func lockCockpitChangeWrites(ctx context.Context, q *db.Queries, cc cockpitContext) error {
	if _, err := q.LockWorkspaceForChatSessionCreate(ctx, cc.workspaceID); err != nil {
		return err
	}
	if _, err := q.LockCockpitCreationMember(ctx, db.LockCockpitCreationMemberParams{WorkspaceID: cc.workspaceID, UserID: cc.member.UserID}); err != nil {
		return err
	}
	boardID, err := q.LockCockpitForWorkspaceChanges(ctx, cc.workspaceID)
	if err != nil {
		return err
	}
	if boardID != cc.cockpit.ID {
		return pgx.ErrNoRows
	}
	return nil
}

func (h *Handler) GetCockpitChangePreview(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpitReference(w, r)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "changeId"), "change id")
	if !ok {
		return
	}
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, 500, "failed to read review preview")
		return
	}
	defer tx.Rollback(r.Context())
	if _, err = tx.Exec(r.Context(), "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"); err != nil {
		writeError(w, 500, "failed to read review preview")
		return
	}
	q := h.Queries.WithTx(tx)
	change, err := q.GetCockpitPendingChange(r.Context(), db.GetCockpitPendingChangeParams{WorkspaceID: cc.workspaceID, ID: id})
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, 404, "cockpit change not found")
		return
	}
	if err != nil {
		writeError(w, 500, "failed to read review preview")
		return
	}
	if change.Status != "pending" {
		writeError(w, 409, "this change has already been decided")
		return
	}
	node, err := q.GetCockpitNode(r.Context(), db.GetCockpitNodeParams{WorkspaceID: cc.workspaceID, ID: change.NodeID})
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, 409, "the node this change targets no longer exists")
		return
	}
	if err != nil {
		writeError(w, 500, "failed to read review preview")
		return
	}
	context, err := cockpitChangeReviewContext(r.Context(), q, node)
	if errors.Is(err, errCockpitChangeContextInvalid) {
		writeError(w, http.StatusConflict, "plan context could not be confirmed; repair the plan structure before reviewing")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read plan context")
		return
	}
	value := cockpitNodeFieldValue(node, change.Field)
	changeResp := pendingChangeToResponse(change, node.Code, node.Name)
	changeResp.SourceIssue = h.cockpitChangeSourceIssue(r.Context(), change.SourceTaskID, h.getIssuePrefix(r.Context(), cc.workspaceID))
	out := CockpitChangeReviewPreview{WorkspaceID: uuidToString(cc.workspaceID), Change: changeResp, CurrentValue: value, Conflict: value != change.OldValue, ReviewToken: cockpitChangeReviewToken(change, node, context), Context: context.Scope}
	if err = tx.Commit(r.Context()); err != nil {
		writeError(w, 500, "failed to read review preview")
		return
	}
	w.Header().Set("ETag", out.ReviewToken)
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, out)
}
