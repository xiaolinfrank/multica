package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// errCodeChildModuleMismatch marks the refusal to leave a sub-issue filed
// somewhere other than its parent. The UI branches on it to offer the one way
// forward — detaching the issue from its parent in the same write — instead of
// toasting an English sentence.
const errCodeChildModuleMismatch = "child_module_mismatch"

const childModuleMismatchMessage = "a sub-issue must stay in its parent's module"

// errCodeChildWorkItemMismatch is the same refusal one level down: a sub-issue
// may not leave the work item its parent is filed under.
const errCodeChildWorkItemMismatch = "child_work_item_mismatch"

const childWorkItemMismatchMessage = "a sub-issue must stay in its parent's work item"

// applyIssueParentFiling enforces, on the resolved update params, that an issue
// with a parent stays filed exactly where that parent is: same project, same
// module, same work item. A sub-issue's module and work item are not
// independent properties — they are the parent's, which is what makes "move the
// parent" able to carry the subtree (see refileIssueSubtree) and what makes a
// module or work item group in the table a complete picture of the work under
// it.
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
	// The work item belongs in "moving": a child can leave its parent's work
	// item without touching project or module (a sibling node under the same
	// module, or an explicit clear), and that is exactly what I4 forbids.
	moving := params.ProjectID != prev.ProjectID ||
		params.ModuleID != prev.ModuleID ||
		params.WorkItemID != prev.WorkItemID
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
	_, namedWorkItem := rawFields["work_item_id"]
	if adopting && !namedModule && !namedProject && !namedWorkItem {
		params.ProjectID = parent.ProjectID
		params.ModuleID = parent.ModuleID
		params.WorkItemID = parent.WorkItemID
		return 0, "", ""
	}
	if params.ProjectID != parent.ProjectID || params.ModuleID != parent.ModuleID {
		return http.StatusBadRequest, errCodeChildModuleMismatch, childModuleMismatchMessage
	}
	if params.WorkItemID != parent.WorkItemID {
		return http.StatusBadRequest, errCodeChildWorkItemMismatch, childWorkItemMismatchMessage
	}
	return 0, "", ""
}

// publishIssueFilingChanges emits only the fields changed by the committed
// subtree write. Issue events already support partial, versioned field patches;
// no description or other unchanged body is loaded for this notification.
func (h *Handler) publishIssueFilingChanges(rows []db.RefileIssueSubtreeRow, workspaceID, actorType, actorID string) {
	for _, child := range rows {
		h.publish(protocol.EventIssueUpdated, workspaceID, actorType, actorID, map[string]any{
			"issue":           map[string]any{"id": uuidToString(child.ID), "workspace_id": uuidToString(child.WorkspaceID), "project_id": uuidToPtr(child.ProjectID), "module_id": uuidToPtr(child.ModuleID), "work_item_id": uuidToPtr(child.WorkItemID), "revision": child.Revision, "updated_at": child.UpdatedAt.Time},
			"project_changed": true, "module_changed": true, "work_item_changed": true,
		})
	}
}

func issueHierarchyFieldsTouched(fields map[string]json.RawMessage) bool {
	for _, name := range []string{"parent_issue_id", "project_id", "module_id", "work_item_id"} {
		if _, ok := fields[name]; ok {
			return true
		}
	}
	return false
}

// issueFilingChanged reports whether an update moved the issue between
// projects, modules or work items — the trigger for carrying its subtree along.
func issueFilingChanged(prev, next db.Issue) bool {
	return prev.ProjectID != next.ProjectID || prev.ModuleID != next.ModuleID || prev.WorkItemID != next.WorkItemID
}

// Carries the same boundary error when the authoritative check is inside a tx.
type issueParentFilingError struct {
	status        int
	code, message string
}

func (e *issueParentFilingError) Error() string { return e.message }

type issueFilingTarget struct {
	ProjectID  pgtype.UUID
	ModuleID   pgtype.UUID
	WorkItemID pgtype.UUID
}

type batchParentFilingConflict struct {
	IssueID       string `json:"issue_id"`
	ParentIssueID string `json:"parent_issue_id"`
	Code          string `json:"code"`
}

type batchParentFilingIssue struct {
	ID            pgtype.UUID
	ParentIssueID pgtype.UUID
	Current       issueFilingTarget
	Target        issueFilingTarget
}

func resolveBatchIssueTargetFiling(
	prev db.Issue,
	rawUpdates map[string]json.RawMessage,
	batchProjectID, batchModuleID, batchWorkItemID pgtype.UUID,
	batchModule db.Module,
	batchWorkItem db.GetCockpitWorkItemScopeRow,
) (issueFilingTarget, int, string) {
	target := issueFilingTarget{
		ProjectID:  prev.ProjectID,
		ModuleID:   prev.ModuleID,
		WorkItemID: prev.WorkItemID,
	}
	if _, ok := rawUpdates["project_id"]; ok {
		target.ProjectID = batchProjectID
	}
	if _, ok := rawUpdates["module_id"]; ok {
		if batchModuleID.Valid && batchModule.ProjectID != target.ProjectID {
			return issueFilingTarget{}, http.StatusBadRequest, "module does not belong to project"
		}
		target.ModuleID = batchModuleID
	} else if _, ok := rawUpdates["project_id"]; ok && target.ProjectID != prev.ProjectID {
		target.ModuleID = pgtype.UUID{Valid: false}
	}
	if _, ok := rawUpdates["work_item_id"]; ok {
		if batchWorkItemID.Valid {
			target.WorkItemID = batchWorkItemID
			target.ModuleID = batchWorkItem.ModuleID
			target.ProjectID = batchWorkItem.ProjectID
		} else {
			target.WorkItemID = pgtype.UUID{Valid: false}
		}
	} else if target.ModuleID != prev.ModuleID || target.ProjectID != prev.ProjectID {
		target.WorkItemID = pgtype.UUID{Valid: false}
	}
	return target, 0, ""
}

// checkBatchParentFilingConflicts validates before any issue is mutated that
// batch-updating ownership will not leave any sub-issue filed under a different
// project, module, or work item than its parent. If an ancestor is also moving
// to the same target ownership in the same batch, the subtree moves together
// without conflict.
func checkBatchParentFilingConflicts(
	items []batchParentFilingIssue,
	lookupParent func(id pgtype.UUID) (parentID pgtype.UUID, filing issueFilingTarget, ok bool, err error),
) ([]batchParentFilingConflict, error) {
	byID := make(map[pgtype.UUID]batchParentFilingIssue, len(items))
	for _, item := range items {
		byID[item.ID] = item
	}

	var conflicts []batchParentFilingConflict
	for _, item := range items {
		if !item.ParentIssueID.Valid || item.Target == item.Current {
			continue
		}
		visited := map[pgtype.UUID]bool{item.ID: true}
		cur := item.ParentIssueID
		coveredByBatchAncestor := false
		var immediateParentFiling issueFilingTarget
		immediateParentFound := false

		for cur.Valid && !visited[cur] {
			visited[cur] = true
			if anc, inBatch := byID[cur]; inBatch {
				if anc.Target == item.Target {
					coveredByBatchAncestor = true
				}
				break
			}
			nextParent, filing, ok, err := lookupParent(cur)
			if err != nil {
				return nil, err
			}
			if !ok {
				break
			}
			if cur == item.ParentIssueID {
				immediateParentFiling = filing
				immediateParentFound = true
			}
			cur = nextParent
		}

		if coveredByBatchAncestor || !immediateParentFound {
			continue
		}
		if item.Target.ProjectID != immediateParentFiling.ProjectID || item.Target.ModuleID != immediateParentFiling.ModuleID {
			conflicts = append(conflicts, batchParentFilingConflict{
				IssueID:       util.UUIDToString(item.ID),
				ParentIssueID: util.UUIDToString(item.ParentIssueID),
				Code:          errCodeChildModuleMismatch,
			})
		} else if item.Target.WorkItemID != immediateParentFiling.WorkItemID {
			conflicts = append(conflicts, batchParentFilingConflict{
				IssueID:       util.UUIDToString(item.ID),
				ParentIssueID: util.UUIDToString(item.ParentIssueID),
				Code:          errCodeChildWorkItemMismatch,
			})
		}
	}
	return conflicts, nil
}

// orderBatchIssueIDsParentsFirst stably orders batch issue IDs so any ancestor
// present in the batch is updated before its descendants. That lets the parent
// move carry the subtree first instead of failing the child against the
// parent's pre-batch filing.
func orderBatchIssueIDsParentsFirst(
	ids []string,
	items []batchParentFilingIssue,
	lookupParent func(id pgtype.UUID) (pgtype.UUID, bool),
) []string {
	if len(ids) <= 1 {
		return ids
	}
	byID := make(map[pgtype.UUID]batchParentFilingIssue, len(items))
	for _, item := range items {
		byID[item.ID] = item
	}
	depthByID := make(map[string]int, len(ids))
	for _, raw := range ids {
		uid, err := util.ParseUUID(raw)
		if err != nil {
			continue
		}
		item, ok := byID[uid]
		if !ok || !item.ParentIssueID.Valid {
			continue
		}
		depth := 0
		visited := map[pgtype.UUID]bool{uid: true}
		cur := item.ParentIssueID
		for cur.Valid && !visited[cur] {
			visited[cur] = true
			if anc, inBatch := byID[cur]; inBatch {
				depth++
				cur = anc.ParentIssueID
				continue
			}
			nextParent, found := lookupParent(cur)
			if !found {
				break
			}
			cur = nextParent
		}
		depthByID[raw] = depth
	}

	ordered := append([]string(nil), ids...)
	sort.SliceStable(ordered, func(i, j int) bool {
		return depthByID[ordered[i]] < depthByID[ordered[j]]
	})
	return ordered
}
