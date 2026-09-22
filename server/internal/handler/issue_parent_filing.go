package handler

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/multica-ai/multica/server/pkg/protocol"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// errCodeChildModuleMismatch marks the refusal to leave a sub-issue filed
// somewhere other than its parent. The UI branches on it to offer the one way
// forward — detaching the issue from its parent in the same write — instead of
// toasting an English sentence.
const errCodeChildModuleMismatch = "child_module_mismatch"

const childModuleMismatchMessage = "a sub-issue must stay in its parent's module"

// applyIssueParentFiling enforces, on the resolved update params, that an issue
// with a parent stays filed exactly where that parent is: same project, same
// module. A sub-issue's module is not an independent property — it is the
// parent's, which is what makes "move the parent" able to carry the subtree
// (see refileIssueSubtree) and what makes a module group in the table a
// complete picture of the work under it.
//
// Two directions meet here:
//
//   - Attaching the issue to a DIFFERENT parent re-files it under that parent.
//     The module it used to sit in belonged to its old place in the tree, so a
//     write that only names the new parent adopts the new parent's filing.
//   - Re-filing an issue that keeps its parent is refused. The only way through
//     is to detach in the same write (`parent_issue_id: null`), which the UI
//     confirms before sending.
//
// A write that does not move the issue is left alone, so a sub-issue that
// already disagrees with its parent — data written before this rule existed —
// stays editable in every other respect.
func (h *Handler) applyIssueParentFiling(
	ctx context.Context,
	params *db.UpdateIssueParams,
	prev db.Issue,
	rawFields map[string]json.RawMessage,
) (int, string, string) {
	if !params.ParentIssueID.Valid {
		return 0, "", ""
	}
	adopting := params.ParentIssueID != prev.ParentIssueID
	moving := params.ProjectID != prev.ProjectID || params.ModuleID != prev.ModuleID
	if !adopting && !moving {
		return 0, "", ""
	}
	parent, err := h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{
		ID:          params.ParentIssueID,
		WorkspaceID: prev.WorkspaceID,
	})
	if err != nil || !parent.ID.Valid {
		// The caller validated a parent it is setting; reaching here means the
		// parent this issue already had has since been deleted, and there is
		// nothing left to keep the child aligned with.
		return 0, "", ""
	}
	_, namedModule := rawFields["module_id"]
	_, namedProject := rawFields["project_id"]
	if adopting && !namedModule && !namedProject {
		params.ProjectID = parent.ProjectID
		params.ModuleID = parent.ModuleID
		return 0, "", ""
	}
	if params.ProjectID != parent.ProjectID || params.ModuleID != parent.ModuleID {
		return http.StatusBadRequest, errCodeChildModuleMismatch, childModuleMismatchMessage
	}
	return 0, "", ""
}

// refileIssueSubtree moves every descendant of a just-updated issue into the
// project and module that issue now sits in, and broadcasts each row it
// changed. Without it a parent moving to another module would leave its
// children behind in a module their parent no longer belongs to.
//
// Per-row `issue:updated` mirrors the batch endpoint, so clients patch their
// caches through the path they already have. The two "changed" flags are
// reported together because the query returns only rows that differed in one
// of them and does not carry which — the cost of the wider flag is a refetch
// the client would have made anyway on the other.
func (h *Handler) refileIssueSubtree(
	ctx context.Context,
	issue db.Issue,
	workspaceID, actorType, actorID string,
) {
	moved, err := h.Queries.RefileIssueSubtree(ctx, db.RefileIssueSubtreeParams{
		ParentIssueID: issue.ID,
		WorkspaceID:   issue.WorkspaceID,
		ProjectID:     issue.ProjectID,
		ModuleID:      issue.ModuleID,
	})
	if err != nil {
		slog.Error("refile issue subtree",
			"issue_id", uuidToString(issue.ID), "workspace_id", workspaceID, "error", err)
		return
	}
	if len(moved) == 0 {
		return
	}
	prefix := h.getIssuePrefix(ctx, issue.WorkspaceID)
	for _, child := range moved {
		resp := issueToResponse(child, prefix)
		h.fillStatusCategory(ctx, child.WorkspaceID, &resp)
		h.publish(protocol.EventIssueUpdated, workspaceID, actorType, actorID, map[string]any{
			"issue":           resp,
			"project_changed": true,
			"module_changed":  true,
		})
	}
}

// issueFilingChanged reports whether an update moved the issue between
// projects or modules — the trigger for carrying its subtree along.
func issueFilingChanged(prev, next db.Issue) bool {
	return prev.ProjectID != next.ProjectID || prev.ModuleID != next.ModuleID
}
