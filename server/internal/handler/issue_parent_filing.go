package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
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
	return applyIssueParentFilingWithQueries(ctx, h.Queries, params, prev, rawFields)
}

// The locked mutation reuses this resolver after refreshing unchanged fields.
// Otherwise an implicit new-parent scope would be replaced by the old scope.
func applyIssueParentFilingWithQueries(ctx context.Context, q *db.Queries, params *db.UpdateIssueParams, prev db.Issue, rawFields map[string]json.RawMessage) (int, string, string) {
	if !params.ParentIssueID.Valid {
		return 0, "", ""
	}
	adopting := params.ParentIssueID != prev.ParentIssueID
	moving := params.ProjectID != prev.ProjectID || params.ModuleID != prev.ModuleID
	if !adopting && !moving {
		return 0, "", ""
	}
	parent, err := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{
		ID:          params.ParentIssueID,
		WorkspaceID: prev.WorkspaceID,
	})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return http.StatusInternalServerError, "parent_validation_failed", "failed to validate the parent issue"
	}
	if errors.Is(err, pgx.ErrNoRows) || !parent.ID.Valid {
		if adopting {
			return http.StatusBadRequest, "parent_unavailable", "the selected parent issue is no longer available in this workspace"
		}
		// An already missing legacy parent does not prevent unrelated edits.
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

// publishIssueFilingChanges emits only the fields changed by the committed
// subtree write. Issue events already support partial, versioned field patches;
// no description or other unchanged body is loaded for this notification.
func (h *Handler) publishIssueFilingChanges(rows []db.RefileIssueSubtreeRow, workspaceID, actorType, actorID string) {
	for _, child := range rows {
		h.publish(protocol.EventIssueUpdated, workspaceID, actorType, actorID, map[string]any{
			"issue":           map[string]any{"id": uuidToString(child.ID), "workspace_id": uuidToString(child.WorkspaceID), "project_id": uuidToPtr(child.ProjectID), "module_id": uuidToPtr(child.ModuleID), "revision": child.Revision, "updated_at": child.UpdatedAt.Time},
			"project_changed": true, "module_changed": true,
		})
	}
}

func issueHierarchyFieldsTouched(fields map[string]json.RawMessage) bool {
	for _, name := range []string{"parent_issue_id", "project_id", "module_id"} {
		if _, ok := fields[name]; ok {
			return true
		}
	}
	return false
}

// issueFilingChanged reports whether an update moved the issue between
// projects or modules — the trigger for carrying its subtree along.
func issueFilingChanged(prev, next db.Issue) bool {
	return prev.ProjectID != next.ProjectID || prev.ModuleID != next.ModuleID
}

// Carries the same boundary error when the authoritative check is inside a tx.
type issueParentFilingError struct {
	status        int
	code, message string
}

func (e *issueParentFilingError) Error() string { return e.message }
