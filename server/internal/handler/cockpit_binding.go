package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type cockpitNodeBindingPatch struct {
	project, module       pgtype.UUID
	projectSet, moduleSet bool
}

func parseCockpitNodeBinding(w http.ResponseWriter, project, module *string, raw map[string]json.RawMessage) (cockpitNodeBindingPatch, bool) {
	var patch cockpitNodeBindingPatch
	_, patch.projectSet = raw["project_id"]
	_, patch.moduleSet = raw["module_id"]
	for _, field := range []struct {
		name  string
		value *string
		out   *pgtype.UUID
	}{
		{"project_id", project, &patch.project},
		{"module_id", module, &patch.module},
	} {
		if field.value == nil || strings.TrimSpace(*field.value) == "" {
			continue
		}
		id, ok := parseUUIDOrBadRequest(w, strings.TrimSpace(*field.value), field.name)
		if !ok {
			return patch, false
		}
		*field.out = id
	}
	return patch, true
}

func parseCockpitImportBindings(w http.ResponseWriter, req *CockpitImportRequest) bool {
	req.nodeBindings = make([]cockpitNodeBindingPatch, len(req.Nodes))
	for i, node := range req.Nodes {
		raw := map[string]json.RawMessage{}
		if node.ProjectID != nil {
			raw["project_id"] = nil
		}
		if node.ModuleID != nil {
			raw["module_id"] = nil
		}
		patch, ok := parseCockpitNodeBinding(w, node.ProjectID, node.ModuleID, raw)
		if !ok {
			return false
		}
		req.nodeBindings[i] = patch
	}
	return true
}

// Resolve the module's actual project inside the same transaction as the node
// mutation. All binding writes and referenced-resource deletes hold the board
// lock, so a successful lookup cannot become a dangling binding before commit.
func resolveCockpitNodeBinding(ctx context.Context, q *db.Queries, workspaceID pgtype.UUID, current db.CockpitNode, patch cockpitNodeBindingPatch) (pgtype.UUID, pgtype.UUID, *cockpitImportError) {
	project, module := current.ProjectID, current.ModuleID
	if patch.projectSet {
		project = patch.project
	}
	if patch.moduleSet {
		module = patch.module
	}
	if module.Valid {
		row, err := q.GetModuleInWorkspace(ctx, db.GetModuleInWorkspaceParams{ID: module, WorkspaceID: workspaceID})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return project, module, &cockpitImportError{http.StatusBadRequest, "module not found in this workspace"}
			}
			return project, module, &cockpitImportError{http.StatusInternalServerError, "failed to resolve module binding"}
		}
		if patch.moduleSet && !patch.projectSet {
			project = row.ProjectID
		}
		if !project.Valid || project != row.ProjectID {
			return project, module, &cockpitImportError{http.StatusBadRequest, "module binding must use the module's project_id; clear both fields to unbind"}
		}
	}
	if project.Valid {
		if _, err := q.GetProjectForCockpitBinding(ctx, db.GetProjectForCockpitBindingParams{ID: project, WorkspaceID: workspaceID}); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return project, module, &cockpitImportError{http.StatusBadRequest, "project not found in this workspace"}
			}
			return project, module, &cockpitImportError{http.StatusInternalServerError, "failed to resolve project binding"}
		}
	}
	// Match project deletion's project-before-module resource lock order. This
	// also covers the first cockpit being created while a resource is deleted.
	if module.Valid {
		row, err := q.GetModuleForCockpitBinding(ctx, db.GetModuleForCockpitBindingParams{ID: module, WorkspaceID: workspaceID})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return project, module, &cockpitImportError{http.StatusBadRequest, "module no longer exists in this workspace"}
			}
			return project, module, &cockpitImportError{http.StatusInternalServerError, "failed to lock module binding"}
		}
		if row.ProjectID != project {
			return project, module, &cockpitImportError{http.StatusBadRequest, "module binding no longer matches its project"}
		}
	}
	return project, module, nil
}

// cockpitInheritedBinding follows identities, never display depth, names or
// codes. Unbound grouping rows are transparent to the ownership hierarchy.
func cockpitInheritedBinding(node db.CockpitNode, byID map[pgtype.UUID]db.CockpitNode) (pgtype.UUID, pgtype.UUID, error) {
	path := []db.CockpitNode{node}
	seen := map[pgtype.UUID]bool{node.ID: true}
	for node.ParentID.Valid {
		parent, ok := byID[node.ParentID]
		if !ok {
			return pgtype.UUID{}, pgtype.UUID{}, fmt.Errorf("binding ancestry contains a missing parent")
		}
		if seen[parent.ID] {
			return pgtype.UUID{}, pgtype.UUID{}, fmt.Errorf("binding ancestry contains a cycle")
		}
		seen[parent.ID] = true
		path = append(path, parent)
		node = parent
	}
	var project, module pgtype.UUID
	for i := len(path) - 1; i >= 0; i-- {
		n := path[i]
		if !n.ProjectID.Valid && !n.ModuleID.Valid {
			continue
		}
		if !n.ProjectID.Valid {
			return project, module, fmt.Errorf("a module binding requires its project_id")
		}
		if module.Valid {
			return project, module, fmt.Errorf("project or module bindings cannot be nested below a module binding")
		}
		if project.Valid && project != n.ProjectID {
			return project, module, fmt.Errorf("binding conflicts with an ancestor's project")
		}
		project, module = n.ProjectID, n.ModuleID
	}
	return project, module, nil
}

func validateCockpitBindingTree(nodes []db.CockpitNode) error {
	byID := make(map[pgtype.UUID]db.CockpitNode, len(nodes))
	for _, node := range nodes {
		byID[node.ID] = node
	}
	for _, node := range nodes {
		// Preserve unrelated legacy, unbound trees. Every bound descendant is
		// checked, including through an unbound node that was just reparented.
		if !node.ProjectID.Valid && !node.ModuleID.Valid {
			continue
		}
		if _, _, err := cockpitInheritedBinding(node, byID); err != nil {
			return fmt.Errorf("node %s: %w", node.Code, err)
		}
	}
	return nil
}

func checkCockpitBindingTree(ctx context.Context, q *db.Queries, cockpitID pgtype.UUID) *cockpitImportError {
	nodes, err := q.ListCockpitNodes(ctx, cockpitID)
	if err != nil {
		return &cockpitImportError{http.StatusInternalServerError, "failed to validate cockpit bindings"}
	}
	if err := validateCockpitBindingTree(nodes); err != nil {
		return &cockpitImportError{http.StatusBadRequest, err.Error()}
	}
	return nil
}

func lockCockpitBindings(ctx context.Context, q *db.Queries, workspaceID pgtype.UUID) error {
	_, err := q.LockCockpitForWorkspaceChanges(ctx, workspaceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	return err
}
