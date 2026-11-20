package handler

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// deleteCockpitSubtree removes a structural row and everything under it: the
// plan tree has no cascading deletes in the schema, so this walks the subtree
// deepest-first and clears each row's dependents exactly like the single-node
// delete does. Issues lose only their filing (§2.3): they stay in their project
// and module, and the caller detaches the module afterwards.
//
// Returns the removed rows so the caller can publish one event per node.
func deleteCockpitSubtree(ctx context.Context, q *db.Queries, workspaceID, rootID pgtype.UUID) ([]db.CockpitNode, error) {
	root, err := q.GetCockpitNode(ctx, db.GetCockpitNodeParams{WorkspaceID: workspaceID, ID: rootID})
	if err != nil {
		return nil, err
	}
	nodes, err := q.ListCockpitNodes(ctx, root.CockpitID)
	if err != nil {
		return nil, err
	}
	children := make(map[pgtype.UUID][]db.CockpitNode, len(nodes))
	for _, node := range nodes {
		if node.ParentID.Valid {
			children[node.ParentID] = append(children[node.ParentID], node)
		}
	}
	var order []db.CockpitNode
	var walk func(node db.CockpitNode)
	walk = func(node db.CockpitNode) {
		for _, child := range children[node.ID] {
			walk(child)
		}
		order = append(order, node)
	}
	walk(root)
	for _, node := range order {
		if _, err := q.ClearIssuesFiledAtNode(ctx, db.ClearIssuesFiledAtNodeParams{WorkspaceID: workspaceID, WorkItemID: node.ID}); err != nil {
			return nil, err
		}
		if err := q.DeleteCockpitPaymentsByNode(ctx, db.DeleteCockpitPaymentsByNodeParams{NodeID: node.ID, WorkspaceID: workspaceID}); err != nil {
			return nil, err
		}
		if err := q.DeleteCockpitNodeIssuesByNode(ctx, db.DeleteCockpitNodeIssuesByNodeParams{NodeID: node.ID, WorkspaceID: workspaceID}); err != nil {
			return nil, err
		}
		if err := q.DeleteCockpitMeetingNodesByNode(ctx, db.DeleteCockpitMeetingNodesByNodeParams{NodeID: node.ID, WorkspaceID: workspaceID}); err != nil {
			return nil, err
		}
		if _, err := q.SystemWithdrawCockpitPendingChangesByNode(ctx, db.SystemWithdrawCockpitPendingChangesByNodeParams{NodeID: node.ID, WorkspaceID: workspaceID, DecisionNote: "node deleted"}); err != nil {
			return nil, err
		}
		if err := q.DeleteCockpitNode(ctx, db.DeleteCockpitNodeParams{ID: node.ID, WorkspaceID: workspaceID}); err != nil {
			return nil, err
		}
	}
	return order, nil
}

// publishCockpitNodesDeleted tells the board that structural rows went away.
// The module/project delete paths have no cockpit context of their own, so the
// event is published directly: one frame for the whole subtree.
func (h *Handler) publishCockpitNodesDeleted(workspaceID, actorID string, nodes []db.CockpitNode) {
	if len(nodes) == 0 || h.Bus == nil {
		return
	}
	ids := make([]string, 0, len(nodes))
	for _, node := range nodes {
		ids = append(ids, uuidToString(node.ID))
	}
	h.publish(protocol.EventCockpitChanged, workspaceID, "member", actorID, map[string]any{
		"scope":  "node",
		"action": "deleted",
		"entity": map[string]any{"ids": ids, "count": len(ids)},
	})
}

// cockpitSubtreeForBinding finds the structural row that binds a project or a
// module. A module's row is the L2 that binds it; a project's is the L1.
func cockpitSubtreeForBinding(ctx context.Context, q *db.Queries, workspaceID, cockpitID, projectID, moduleID pgtype.UUID) (pgtype.UUID, error) {
	id, err := q.GetCockpitNodeBindingConflict(ctx, db.GetCockpitNodeBindingConflictParams{
		WorkspaceID: workspaceID, CockpitID: cockpitID, ProjectID: projectID, ModuleID: moduleID,
	})
	if err != nil {
		return pgtype.UUID{}, err
	}
	return id, nil
}
