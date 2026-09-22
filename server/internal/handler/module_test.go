package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/testutil"
)

// Module API tests. The issue-side module behaviors (create scoping, update
// presence semantics, move clearing, list filters, table grouping) live at the
// bottom of this file next to their handlers' concerns.

// moduleSuffix makes per-test emails/slugs unique so reruns never collide with
// leftover rows (the schema has no cascades to clean them).
func moduleSuffix() string {
	return uuid.NewString()[:8]
}

// moduleTestSeed builds one project with two modules and returns their ids.
func moduleTestSeed(t *testing.T) (projectID, moduleA, moduleB string) {
	t.Helper()
	projectID = dbfx.Project(t, "Module test project")
	moduleA = dbfx.Module(t, projectID, "Module A", testutil.Cols{"position": 1.0})
	moduleB = dbfx.Module(t, projectID, "Module B", testutil.Cols{"position": 2.0})
	return projectID, moduleA, moduleB
}

func TestModuleCreateListGetUpdateDelete(t *testing.T) {
	projectID, _, _ := moduleTestSeed(t)

	// Create appends after the seeded pair (MAX(position)+1) and trims title.
	var created struct {
		Module ModuleResponse `json:"module"`
	}
	testutil.Call(t, testHandler.CreateModule, newRequest(http.MethodPost, "/api/modules", map[string]any{
		"project_id":  projectID,
		"title":       "  Gamma  ",
		"description": "third module",
	})).Want(http.StatusCreated).JSON(&created)
	if created.Module.Title != "Gamma" {
		t.Fatalf("title = %q, want trimmed Gamma", created.Module.Title)
	}
	if created.Module.ProjectID != projectID || created.Module.WorkspaceID != testWorkspaceID {
		t.Fatalf("module scoped wrong: %+v", created.Module)
	}
	if created.Module.Position != 3 {
		t.Fatalf("appended position = %v, want 3", created.Module.Position)
	}
	if created.Module.Description == nil || *created.Module.Description != "third module" {
		t.Fatalf("description = %v, want third module", created.Module.Description)
	}

	// Get returns the single-module envelope with counts.
	issueInModule := dbfx.Issue(t, "Module issue", testutil.Cols{
		"project_id": projectID,
		"module_id":  created.Module.ID,
	})
	dbfx.Issue(t, "Done module issue", testutil.Cols{
		"project_id": projectID,
		"module_id":  created.Module.ID,
		"status":     "done",
	})
	var got struct {
		Module ModuleResponse `json:"module"`
	}
	testutil.Call(t, testHandler.GetModule, withURLParam(
		newRequest(http.MethodGet, "/api/modules/"+created.Module.ID, nil), "id", created.Module.ID,
	)).Want(http.StatusOK).JSON(&got)
	if got.Module.IssueCount != 2 || got.Module.DoneCount != 1 {
		t.Fatalf("counts = %d/%d, want 2/1", got.Module.IssueCount, got.Module.DoneCount)
	}

	// List filters by project and batch-enriches counts.
	var listed struct {
		Modules []ModuleResponse `json:"modules"`
		Total   int              `json:"total"`
	}
	testutil.Call(t, testHandler.ListModules, newRequest(http.MethodGet, "/api/modules?project_id="+projectID, nil)).
		Want(http.StatusOK).JSON(&listed)
	if listed.Total != 3 || len(listed.Modules) != 3 {
		t.Fatalf("list = %+v", listed)
	}
	if listed.Modules[2].IssueCount != 2 || listed.Modules[2].DoneCount != 1 {
		t.Fatalf("batched counts wrong: %+v", listed.Modules[2])
	}

	// Update: absent keys keep, present null clears (description only).
	testutil.Call(t, testHandler.UpdateModule, withURLParam(
		newRequest(http.MethodPut, "/api/modules/"+created.Module.ID, map[string]any{"title": "Gamma renamed"}),
		"id", created.Module.ID,
	)).Want(http.StatusOK).JSON(&got)
	if got.Module.Title != "Gamma renamed" || got.Module.Description == nil || *got.Module.Description != "third module" {
		t.Fatalf("absent description must keep: %+v", got.Module)
	}
	testutil.Call(t, testHandler.UpdateModule, withURLParam(
		newRequest(http.MethodPut, "/api/modules/"+created.Module.ID, map[string]any{"description": nil}),
		"id", created.Module.ID,
	)).Want(http.StatusOK).JSON(&got)
	if got.Module.Description != nil {
		t.Fatalf("explicit null must clear description: %+v", got.Module)
	}
	testutil.Call(t, testHandler.UpdateModule, withURLParam(
		newRequest(http.MethodPut, "/api/modules/"+created.Module.ID, map[string]any{"position": 9.5}),
		"id", created.Module.ID,
	)).Want(http.StatusOK).JSON(&got)
	if got.Module.Position != 9.5 {
		t.Fatalf("position = %v, want 9.5", got.Module.Position)
	}

	// Delete detaches issues (module_id NULL, revision bumped) and removes the row.
	var revisionBefore int64
	dbfx.QueryRow(t, `SELECT revision FROM issue WHERE id = $1`, issueInModule).Scan(&revisionBefore)
	testutil.Call(t, testHandler.DeleteModule, withURLParam(
		newRequest(http.MethodDelete, "/api/modules/"+created.Module.ID, nil), "id", created.Module.ID,
	)).Want(http.StatusNoContent)
	var moduleIDAfter, projectIDAfter string
	var revisionAfter int64
	dbfx.QueryRow(t, `SELECT COALESCE(module_id::text, ''), project_id::text, revision FROM issue WHERE id = $1`, issueInModule).
		Scan(&moduleIDAfter, &projectIDAfter, &revisionAfter)
	if moduleIDAfter != "" || projectIDAfter != projectID {
		t.Fatalf("issue after module delete: module=%q project=%q", moduleIDAfter, projectIDAfter)
	}
	if revisionAfter <= revisionBefore {
		t.Fatalf("revision = %d, want > %d so clients refetch the detached row", revisionAfter, revisionBefore)
	}
	var remaining int
	dbfx.QueryRow(t, `SELECT COUNT(*) FROM module WHERE id = $1`, created.Module.ID).Scan(&remaining)
	if remaining != 0 {
		t.Fatal("module row survived delete")
	}
}

func TestCreateModuleValidation(t *testing.T) {
	projectID, _, _ := moduleTestSeed(t)

	for name, title := range map[string]string{
		"empty":    "",
		"blank":    "   ",
		"too long": strings.Repeat("模", 201),
	} {
		w := httptest.NewRecorder()
		testHandler.CreateModule(w, newRequest(http.MethodPost, "/api/modules", map[string]any{
			"project_id": projectID,
			"title":      title,
		}))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s title: expected 400, got %d: %s", name, w.Code, w.Body.String())
		}
	}

	// A project from another workspace is rejected, not silently adopted.
	foreignWS := dbfx.Workspace(t, "Module foreign workspace", "module-foreign-"+moduleSuffix(), nil)
	foreignProject := dbfx.Insert(t, "project", testutil.Cols{
		"workspace_id": foreignWS,
		"title":        "Foreign project",
	})
	w := httptest.NewRecorder()
	testHandler.CreateModule(w, newRequest(http.MethodPost, "/api/modules", map[string]any{
		"project_id": foreignProject,
		"title":      "Cross boundary module",
	}))
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "project not found in this workspace") {
		t.Fatalf("expected 400 boundary error, got %d: %s", w.Code, w.Body.String())
	}

	w = httptest.NewRecorder()
	testHandler.CreateModule(w, newRequest(http.MethodPost, "/api/modules", map[string]any{
		"project_id": "not-a-uuid",
		"title":      "Bad uuid module",
	}))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid project uuid, got %d", w.Code)
	}
}

// Modules briefly carried a `collab_path` ("人机协作空间路径") of their own before
// the value was scoped back to the project alone: a module lives inside its
// project on disk as well as on the platform, so its folder is found by name
// under the project's directory and a stored second path would only be
// something that can drift out of sync with the folder it names.
//
// A desktop client pinned to the older build still posts the key. This test
// pins what the server does with it: IGNORE — no 400, no echo. Rejecting it
// would break an installed client on an endpoint that is otherwise compatible,
// and echoing it would let that client keep showing a field the server no
// longer honours. Both decoders here take the body with plain encoding/json (no
// DisallowUnknownFields), which is what makes the key inert.
//
// "Not persisted" is asserted through the response rather than the column on
// purpose. It is already structural — CreateModuleParams / UpdateModuleParams
// have no such field and the generated statements name their columns — and
// `module.collab_path` exists only in databases that ran this migration's
// earlier two-column form. Reading it here would make the test pass on those
// and error on a database built from the migration as it now stands.
func TestModuleAPIIgnoresCollabPath(t *testing.T) {
	projectID, _, _ := moduleTestSeed(t)

	const legacyPath = "/Volumes/人机协作空间/AI医药联合创新平台/01高质量数据集"

	created := testutil.Call(t, testHandler.CreateModule, newRequest(http.MethodPost, "/api/modules", map[string]any{
		"project_id":  projectID,
		"title":       "Legacy client module",
		"description": "posted by a client that still knows the field",
		"collab_path": legacyPath,
	})).Want(http.StatusCreated)

	var createdModule struct {
		Module ModuleResponse `json:"module"`
	}
	created.JSON(&createdModule)
	moduleID := createdModule.Module.ID
	dbfx.Cleanup(t, `DELETE FROM module WHERE id = $1`, moduleID)

	// The rest of the body still applies — the unknown key must not cost the
	// module its title or description.
	if createdModule.Module.Title != "Legacy client module" {
		t.Errorf("title = %q, want the posted title", createdModule.Module.Title)
	}
	if createdModule.Module.Description == nil || *createdModule.Module.Description != "posted by a client that still knows the field" {
		t.Errorf("description = %v, want the posted description", createdModule.Module.Description)
	}
	wantNoCollabPath(t, "create", created.Text(), legacyPath)

	updated := testutil.Call(t, testHandler.UpdateModule, withURLParam(
		newRequest(http.MethodPut, "/api/modules/"+moduleID, map[string]any{
			"title":       "Legacy client module renamed",
			"collab_path": legacyPath,
		}), "id", moduleID)).Want(http.StatusOK)

	var updatedModule struct {
		Module ModuleResponse `json:"module"`
	}
	updated.JSON(&updatedModule)
	if updatedModule.Module.Title != "Legacy client module renamed" {
		t.Errorf("title = %q, want the update to have applied", updatedModule.Module.Title)
	}
	wantNoCollabPath(t, "update", updated.Text(), legacyPath)

	// And the GET a client polls after either write.
	fetched := testutil.Call(t, testHandler.GetModule, withURLParam(
		newRequest(http.MethodGet, "/api/modules/"+moduleID, nil), "id", moduleID)).Want(http.StatusOK)
	wantNoCollabPath(t, "get", fetched.Text(), legacyPath)

	// A relative value is the one the removed validator used to 400 on. It must
	// now be just as inert as an absolute one: the field is gone, so there is
	// nothing left to validate and nothing to reject.
	rejectedBefore := testutil.Call(t, testHandler.UpdateModule, withURLParam(
		newRequest(http.MethodPut, "/api/modules/"+moduleID, map[string]any{
			"collab_path": "deliverables/final",
		}), "id", moduleID)).Want(http.StatusOK)
	wantNoCollabPath(t, "relative value", rejectedBefore.Text(), "deliverables/final")
	if strings.Contains(rejectedBefore.Text(), "absolute path") {
		t.Errorf("update still validates a field the module no longer has: %s", rejectedBefore.Text())
	}
}

// wantNoCollabPath asserts a module payload neither carries a collab_path key
// nor echoes the value that was posted. The key check is what matters: a field
// re-added to ModuleResponse would decode into nothing the typed assertions
// above look at, so only the raw body can see it.
func wantNoCollabPath(t *testing.T, label, body, posted string) {
	t.Helper()
	if strings.Contains(body, "collab_path") {
		t.Errorf("%s: module payload carries a collab_path key: %s", label, body)
	}
	if strings.Contains(body, posted) {
		t.Errorf("%s: module payload echoes the posted path %q: %s", label, posted, body)
	}
}

func TestDeleteModuleRoleGate(t *testing.T) {
	projectID, moduleA, _ := moduleTestSeed(t)
	member := modulePermissionTestMember(t, "member")

	w := httptest.NewRecorder()
	testHandler.DeleteModule(w, withURLParam(
		newRequestAs(member, http.MethodDelete, "/api/modules/"+moduleA, nil), "id", moduleA))
	if w.Code != http.StatusForbidden {
		t.Fatalf("plain member delete: expected 403, got %d: %s", w.Code, w.Body.String())
	}
	var exists int
	dbfx.QueryRow(t, `SELECT COUNT(*) FROM module WHERE id = $1`, moduleA).Scan(&exists)
	if exists != 1 {
		t.Fatal("module deleted despite plain member request")
	}

	admin := modulePermissionTestMember(t, "admin")
	w = httptest.NewRecorder()
	testHandler.DeleteModule(w, withURLParam(
		newRequestAs(admin, http.MethodDelete, "/api/modules/"+moduleA, nil), "id", moduleA))
	if w.Code != http.StatusNoContent {
		t.Fatalf("admin delete: expected 204, got %d: %s", w.Code, w.Body.String())
	}
	_ = projectID
}

func modulePermissionTestMember(t *testing.T, role string) string {
	t.Helper()
	email := "module-delete-" + role + "-" + moduleSuffix() + "@multica.test"
	user := dbfx.User(t, "Module Delete "+role, email)
	dbfx.Member(t, testWorkspaceID, user, role)
	return user
}

func TestReorderModules(t *testing.T) {
	projectID, moduleA, moduleB := moduleTestSeed(t)
	moduleC := dbfx.Module(t, projectID, "Module C")

	var out struct {
		Modules []ModuleResponse `json:"modules"`
	}
	testutil.Call(t, testHandler.ReorderModules, newRequest(http.MethodPut, "/api/modules/reorder", map[string]any{
		"module_ids": []string{moduleC, moduleA, moduleB},
	})).Want(http.StatusOK).JSON(&out)
	if len(out.Modules) != 3 {
		t.Fatalf("reorder returned %d modules, want 3", len(out.Modules))
	}
	for i, want := range []string{moduleC, moduleA, moduleB} {
		if out.Modules[i].ID != want {
			t.Fatalf("position %d = %s, want %s", i, out.Modules[i].ID, want)
		}
		if out.Modules[i].Position != float64(i) {
			t.Fatalf("position value = %v, want %d", out.Modules[i].Position, i)
		}
	}

	// All ids must exist in the workspace.
	missing := "00000000-0000-0000-0000-000000000000"
	testutil.Call(t, testHandler.ReorderModules, newRequest(http.MethodPut, "/api/modules/reorder", map[string]any{
		"module_ids": []string{moduleA, missing},
	})).Want(http.StatusNotFound)

	// Ids must share one project.
	otherProject := dbfx.Project(t, "Reorder other project")
	otherModule := dbfx.Module(t, otherProject, "Other project module")
	testutil.Call(t, testHandler.ReorderModules, newRequest(http.MethodPut, "/api/modules/reorder", map[string]any{
		"module_ids": []string{moduleA, otherModule},
	})).Want(http.StatusBadRequest)

	// The payload must cover the project's whole module set: a partial list
	// would interleave the unsubmitted rows onto the rewritten 0..n-1 ladder.
	w := httptest.NewRecorder()
	testHandler.ReorderModules(w, newRequest(http.MethodPut, "/api/modules/reorder", map[string]any{
		"module_ids": []string{moduleA},
	}))
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "module_ids must cover every module of the project") {
		t.Fatalf("expected 400 partial-set error, got %d: %s", w.Code, w.Body.String())
	}

	// Duplicate and empty payloads are rejected.
	testutil.Call(t, testHandler.ReorderModules, newRequest(http.MethodPut, "/api/modules/reorder", map[string]any{
		"module_ids": []string{moduleA, moduleA},
	})).Want(http.StatusBadRequest)
	testutil.Call(t, testHandler.ReorderModules, newRequest(http.MethodPut, "/api/modules/reorder", map[string]any{
		"module_ids": []string{},
	})).Want(http.StatusBadRequest)
}

// ---- issue-side module behaviors -------------------------------------------

func TestCreateIssueModuleScoping(t *testing.T) {
	projectID, moduleA, _ := moduleTestSeed(t)
	otherProject := dbfx.Project(t, "Module other project")
	foreignWS := dbfx.Workspace(t, "Issue module foreign ws", "issue-module-foreign-"+moduleSuffix(), nil)
	foreignModule := dbfx.Insert(t, "module", testutil.Cols{
		"workspace_id": foreignWS,
		"project_id":   dbfx.Insert(t, "project", testutil.Cols{"workspace_id": foreignWS, "title": "Foreign ws project"}),
		"title":        "Foreign module",
	})

	// No project_id: the module's project is adopted.
	var created IssueResponse
	testutil.Call(t, testHandler.CreateIssue, newRequest(http.MethodPost, "/api/issues", map[string]any{
		"title":     "Inherits module project",
		"module_id": moduleA,
	})).Want(http.StatusCreated).JSON(&created)
	if created.ModuleID == nil || *created.ModuleID != moduleA {
		t.Fatalf("module_id = %v, want %s", created.ModuleID, moduleA)
	}
	if created.ProjectID == nil || *created.ProjectID != projectID {
		t.Fatalf("project_id = %v, want inherited %s", created.ProjectID, projectID)
	}

	// Disagreing project/module pair is rejected whole.
	w := httptest.NewRecorder()
	testHandler.CreateIssue(w, newRequest(http.MethodPost, "/api/issues", map[string]any{
		"title":      "Mismatched module",
		"project_id": otherProject,
		"module_id":  moduleA,
	}))
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "module does not belong to project") {
		t.Fatalf("expected 400 mismatch error, got %d: %s", w.Code, w.Body.String())
	}

	// Cross-workspace module is rejected.
	w = httptest.NewRecorder()
	testHandler.CreateIssue(w, newRequest(http.MethodPost, "/api/issues", map[string]any{
		"title":     "Foreign module",
		"module_id": foreignModule,
	}))
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "module not found in this workspace") {
		t.Fatalf("expected 400 boundary error, got %d: %s", w.Code, w.Body.String())
	}

	// Sub-issues inherit the parent's project but NOT its module.
	parentID := created.ID
	var child IssueResponse
	testutil.Call(t, testHandler.CreateIssue, newRequest(http.MethodPost, "/api/issues", map[string]any{
		"title":           "Child of module issue",
		"parent_issue_id": parentID,
	})).Want(http.StatusCreated).JSON(&child)
	if child.ProjectID == nil || *child.ProjectID != projectID {
		t.Fatalf("child project = %v, want %s", child.ProjectID, projectID)
	}
	if child.ModuleID != nil {
		t.Fatalf("child module = %v, want nil (sub-issues never inherit the module)", child.ModuleID)
	}
}

func TestUpdateIssueModulePresenceSemantics(t *testing.T) {
	projectID, moduleA, _ := moduleTestSeed(t)
	otherProject := dbfx.Project(t, "Update module other project")
	otherModule := dbfx.Module(t, otherProject, "Other project module")
	issueID := dbfx.Issue(t, "Update module presence", testutil.Cols{"project_id": projectID})

	update := func(body map[string]any) IssueResponse {
		t.Helper()
		var out IssueResponse
		testutil.Call(t, testHandler.UpdateIssue, withURLParam(
			newRequest(http.MethodPut, "/api/issues/"+issueID, body), "id", issueID)).
			Want(http.StatusOK).JSON(&out)
		return out
	}
	storedModule := func() string {
		t.Helper()
		var moduleID string
		dbfx.QueryRow(t, `SELECT COALESCE(module_id::text, '') FROM issue WHERE id = $1`, issueID).Scan(&moduleID)
		return moduleID
	}

	// Value sets.
	update(map[string]any{"module_id": moduleA})
	if storedModule() != moduleA {
		t.Fatalf("stored module = %q, want %s", storedModule(), moduleA)
	}
	// Absent keeps an unrelated field change from clearing it.
	update(map[string]any{"priority": "high"})
	if storedModule() != moduleA {
		t.Fatalf("absent module_id must keep %s, got %q", moduleA, storedModule())
	}
	// Explicit null clears.
	update(map[string]any{"module_id": nil})
	if storedModule() != "" {
		t.Fatalf("explicit null must clear, got %q", storedModule())
	}
	// A module from another project is rejected while the issue stays put.
	w := httptest.NewRecorder()
	testHandler.UpdateIssue(w, withURLParam(
		newRequest(http.MethodPut, "/api/issues/"+issueID, map[string]any{"module_id": otherModule}), "id", issueID))
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "module does not belong to project") {
		t.Fatalf("expected 400 mismatch error, got %d: %s", w.Code, w.Body.String())
	}
	// A foreign-workspace module is rejected.
	w = httptest.NewRecorder()
	testHandler.UpdateIssue(w, withURLParam(
		newRequest(http.MethodPut, "/api/issues/"+issueID, map[string]any{"module_id": "00000000-0000-0000-0000-000000000001"}), "id", issueID))
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "module not found in this workspace") {
		t.Fatalf("expected 400 boundary error, got %d: %s", w.Code, w.Body.String())
	}
	// A project change without a module clears it (old module, old project).
	update(map[string]any{"module_id": moduleA})
	update(map[string]any{"project_id": otherProject})
	if storedModule() != "" {
		t.Fatalf("project move must clear module, got %q", storedModule())
	}
	// An echoed, unchanged project_id is not a move: the module survives the
	// echo. Board drags and batch clients re-submit the field they did not
	// change, so presence alone must never read as a move.
	update(map[string]any{"module_id": otherModule})
	update(map[string]any{"project_id": otherProject})
	if storedModule() != otherModule {
		t.Fatalf("project echo must keep module %s, got %q", otherModule, storedModule())
	}
	// The echo must also survive the atomic description path, where the
	// locked-row refresh could otherwise restore-clear the module.
	update(map[string]any{"project_id": otherProject, "description": "echoed with description"})
	if storedModule() != otherModule {
		t.Fatalf("project echo through the atomic path must keep module %s, got %q", otherModule, storedModule())
	}
	// Batch: an echoed project_id over issues already in the target project
	// keeps their modules, same change-based rule as the single update.
	testutil.Call(t, testHandler.BatchUpdateIssues, newRequest(http.MethodPost, "/api/issues/batch-update", map[string]any{
		"issue_ids": []string{issueID},
		"updates":   map[string]any{"project_id": otherProject},
	})).Want(http.StatusOK)
	if storedModule() != otherModule {
		t.Fatalf("batch project echo must keep module %s, got %q", otherModule, storedModule())
	}
	// Batch: a module from a different project than the target issue is
	// rejected whole, like the single-update guard.
	w = httptest.NewRecorder()
	testHandler.BatchUpdateIssues(w, newRequest(http.MethodPost, "/api/issues/batch-update", map[string]any{
		"issue_ids": []string{issueID},
		"updates":   map[string]any{"module_id": moduleA},
	}))
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "module does not belong to project") {
		t.Fatalf("expected 400 batch module/project mismatch, got %d: %s", w.Code, w.Body.String())
	}
	// Batch: a co-submitted project_id + module_id pair that disagrees is
	// rejected before any issue is touched.
	w = httptest.NewRecorder()
	testHandler.BatchUpdateIssues(w, newRequest(http.MethodPost, "/api/issues/batch-update", map[string]any{
		"issue_ids": []string{issueID},
		"updates":   map[string]any{"project_id": projectID, "module_id": otherModule},
	}))
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "module does not belong to project") {
		t.Fatalf("expected 400 batch co-submitted mismatch, got %d: %s", w.Code, w.Body.String())
	}
}

func TestMoveIssueModuleHandling(t *testing.T) {
	projectID, moduleA, _ := moduleTestSeed(t)
	otherProject := dbfx.Project(t, "Move module other project")
	otherModule := dbfx.Module(t, otherProject, "Move target module")

	before := dbfx.Issue(t, "Move anchor before", testutil.Cols{"position": 10.0})
	after := dbfx.Issue(t, "Move anchor after", testutil.Cols{"position": 20.0})
	moved := dbfx.Issue(t, "Moved module issue", testutil.Cols{
		"project_id": projectID,
		"module_id":  moduleA,
		"position":   15.0,
	})

	move := func(body map[string]any) *testutil.Response {
		t.Helper()
		full := map[string]any{"before_id": before, "after_id": after}
		for k, v := range body {
			full[k] = v
		}
		return testutil.Call(t, testHandler.MoveIssue, withURLParam(
			newRequest(http.MethodPost, "/api/issues/"+moved+"/move", full), "id", moved))
	}
	stored := func() (string, string) {
		t.Helper()
		var moduleID, projectID string
		dbfx.QueryRow(t, `SELECT COALESCE(module_id::text, ''), COALESCE(project_id::text, '') FROM issue WHERE id = $1`, moved).
			Scan(&moduleID, &projectID)
		return moduleID, projectID
	}

	// Cross-project move without a module clears it.
	move(map[string]any{"project_id": otherProject}).Want(http.StatusOK)
	moduleID, projectIDAfter := stored()
	if moduleID != "" || projectIDAfter != otherProject {
		t.Fatalf("after cross-project move: module=%q project=%q", moduleID, projectIDAfter)
	}

	// An explicit module for the target project lands with the move.
	dbfx.Exec(t, `UPDATE issue SET module_id = $2 WHERE id = $1`, moved, moduleA)
	move(map[string]any{"project_id": otherProject, "module_id": otherModule}).Want(http.StatusOK)
	moduleID, _ = stored()
	if moduleID != otherModule {
		t.Fatalf("explicit target module = %q, want %s", moduleID, otherModule)
	}

	// A module belonging to a different project than the target is rejected.
	move(map[string]any{"project_id": projectID, "module_id": otherModule}).Want(http.StatusBadRequest)
}

func TestListIssuesModuleFilter(t *testing.T) {
	projectID, moduleA, moduleB := moduleTestSeed(t)
	inA := dbfx.Issue(t, "Module filter A", testutil.Cols{"project_id": projectID, "module_id": moduleA})
	inB := dbfx.Issue(t, "Module filter B", testutil.Cols{"project_id": projectID, "module_id": moduleB})
	noModule := dbfx.Issue(t, "Module filter none", testutil.Cols{"project_id": projectID})

	list := func(query string) map[string]bool {
		t.Helper()
		var out struct {
			Issues []IssueResponse `json:"issues"`
		}
		testutil.Call(t, testHandler.ListIssues, newRequest(http.MethodGet, "/api/issues"+query, nil)).
			Want(http.StatusOK).JSON(&out)
		got := map[string]bool{}
		for _, issue := range out.Issues {
			got[issue.ID] = true
		}
		return got
	}

	if got := list("?module_id=" + moduleA); !got[inA] || got[inB] || got[noModule] {
		t.Fatalf("module_id filter returned %v", got)
	}
	if got := list("?module_id=" + moduleA + "&include_no_module=1"); !got[inA] || !got[noModule] || got[inB] {
		t.Fatalf("module_id + include_no_module returned %v", got)
	}
	if got := list("?module_ids=" + moduleA + "," + moduleB); !got[inA] || !got[inB] || got[noModule] {
		t.Fatalf("module_ids filter returned %v", got)
	}
}

func TestListGroupedIssuesModuleFilter(t *testing.T) {
	projectID, moduleA, moduleB := moduleTestSeed(t)
	inA := dbfx.Issue(t, "Grouped module A", testutil.Cols{"project_id": projectID, "module_id": moduleA})
	inB := dbfx.Issue(t, "Grouped module B", testutil.Cols{"project_id": projectID, "module_id": moduleB})
	noModule := dbfx.Issue(t, "Grouped module none", testutil.Cols{"project_id": projectID})

	// The client's listGroupedIssues sends the SINGULAR module_id; the grouped
	// builder once read only module_ids and silently dropped it.
	list := func(query string) map[string]bool {
		t.Helper()
		var out GroupedIssuesResponse
		testutil.Call(t, testHandler.ListGroupedIssues, newRequest(http.MethodGet, "/api/issues/grouped"+query, nil)).
			Want(http.StatusOK).JSON(&out)
		got := map[string]bool{}
		for _, group := range out.Groups {
			for _, issue := range group.Issues {
				got[issue.ID] = true
			}
		}
		return got
	}

	if got := list("?module_id=" + moduleA); !got[inA] || got[inB] || got[noModule] {
		t.Fatalf("grouped module_id filter returned %v", got)
	}
	if got := list("?module_id=" + moduleA + "&include_no_module=true"); !got[inA] || !got[noModule] || got[inB] {
		t.Fatalf("grouped module_id + include_no_module returned %v", got)
	}
	if got := list("?module_ids=" + moduleA + "," + moduleB); !got[inA] || !got[inB] || got[noModule] {
		t.Fatalf("grouped module_ids filter returned %v", got)
	}
}

func TestIssueTableModuleGroupingIncludeEmpty(t *testing.T) {
	projectID, moduleA, moduleB := moduleTestSeed(t)
	dbfx.Issue(t, "Filed under A", testutil.Cols{"project_id": projectID, "module_id": moduleA})
	// A second project's module must not ride along into this project's groups.
	otherProject := dbfx.Project(t, "Other module project")
	otherModule := dbfx.Module(t, otherProject, "Other module", testutil.Cols{"position": 1.0})

	spec := issueTableQuerySpec{
		Scope: issueTableScope{Kind: "project", ProjectID: projectID},
		Sort:  issueTableSortRequest{Field: "title", Direction: "asc"},
	}
	groupsFor := func(t *testing.T, query issueTableQuerySpec, group issueTableGroupSpec) (map[string]int64, int64) {
		t.Helper()
		var response issueTableGroupsResponse
		testutil.Call(t, testHandler.ListIssueTableGroups, newRequest(http.MethodPost, "/api/issues/table/groups", issueTableGroupsRequest{
			Query: query,
			Group: group,
		})).Want(http.StatusOK).JSON(&response)
		counts := map[string]int64{}
		for _, descriptor := range response.Groups {
			counts[descriptor.Key] = descriptor.Count
		}
		return counts, response.Total
	}

	counts, total := groupsFor(t, spec, issueTableGroupSpec{Kind: "module", IncludeEmpty: true})
	// Total counts issues, so the empty module must not inflate it.
	if total != 1 {
		t.Fatalf("total = %d, want the one issue: %v", total, counts)
	}
	if counts["module:"+moduleA] != 1 {
		t.Fatalf("module A count = %d, want 1: %v", counts["module:"+moduleA], counts)
	}
	if count, ok := counts["module:"+moduleB]; !ok || count != 0 {
		t.Fatalf("empty module B missing or counted: %v", counts)
	}
	if _, ok := counts["module:"+otherModule]; ok {
		t.Fatalf("another project's module leaked in: %v", counts)
	}
	// The unfiled bucket is not a module, so it stays absent while empty.
	if _, ok := counts["module:none"]; ok {
		t.Fatalf("no-module group appeared without issues: %v", counts)
	}

	// The module strip narrows the catalog with it.
	narrowed := spec
	narrowed.Filters.ModuleIDs = []string{moduleA}
	counts, _ = groupsFor(t, narrowed, issueTableGroupSpec{Kind: "module", IncludeEmpty: true})
	if _, ok := counts["module:"+moduleB]; ok {
		t.Fatalf("module filtered out of the query still listed: %v", counts)
	}

	// Asking for the unfiled bucket alone can name no module.
	unfiled := spec
	unfiled.Filters.IncludeNoModule = true
	counts, _ = groupsFor(t, unfiled, issueTableGroupSpec{Kind: "module", IncludeEmpty: true})
	if len(counts) != 0 {
		t.Fatalf("no-module filter listed modules: %v", counts)
	}

	// Without the flag the endpoint answers exactly as before.
	counts, _ = groupsFor(t, spec, issueTableGroupSpec{Kind: "module"})
	if len(counts) != 1 || counts["module:"+moduleA] != 1 {
		t.Fatalf("plain module grouping changed: %v", counts)
	}
}

func TestIssueTableModuleCatalogBindsGroupCursorIdentity(t *testing.T) {
	plain := issueTableGroupIdentity(issueTableGroupSpec{Kind: "module"})
	catalog := issueTableGroupIdentity(issueTableGroupSpec{Kind: "module", IncludeEmpty: true})
	if plain == catalog {
		t.Fatalf("module cursors share an identity across the catalog flag: %q", catalog)
	}
	if plain != "group:module" {
		t.Fatalf("plain module identity changed to %q, invalidating cursors in flight", plain)
	}
	// The flag is meaningless for the kinds that do not read the module table.
	if got := issueTableGroupIdentity(issueTableGroupSpec{Kind: "project", IncludeEmpty: true}); got != "group:project" {
		t.Fatalf("project identity changed to %q", got)
	}
}

func TestIssueTableModuleGrouping(t *testing.T) {
	projectID, moduleA, _ := moduleTestSeed(t)
	inA := dbfx.Issue(t, "Table module grouped", testutil.Cols{"project_id": projectID, "module_id": moduleA})
	unfiled := dbfx.Issue(t, "Table module none", testutil.Cols{"project_id": projectID})

	spec := issueTableQuerySpec{
		Scope:   issueTableScope{Kind: "project", ProjectID: projectID},
		Filters: issueTableFiltersRequest{},
		Sort:    issueTableSortRequest{Field: "title", Direction: "asc"},
	}
	var groups issueTableGroupsResponse
	testutil.Call(t, testHandler.ListIssueTableGroups, newRequest(http.MethodPost, "/api/issues/table/groups", issueTableGroupsRequest{
		Query: spec,
		Group: issueTableGroupSpec{Kind: "module"},
	})).Want(http.StatusOK).JSON(&groups)

	byKey := map[string]issueTableGroupDescriptorResponse{}
	for _, group := range groups.Groups {
		byKey[group.Key] = group
	}
	if group, ok := byKey["module:"+moduleA]; !ok || group.Count != 1 || group.Value.ModuleID == nil || *group.Value.ModuleID != moduleA || group.Value.Kind != "module" {
		t.Fatalf("module group missing or wrong: %+v", group)
	}
	if group, ok := byKey["module:none"]; !ok || group.Count != 1 || group.Value.ModuleID != nil {
		t.Fatalf("no-module group missing or wrong: %+v", group)
	}
	if len(groups.Groups) != 2 {
		t.Fatalf("expected exactly two groups, got %+v", groups.Groups)
	}

	// filters.module_ids / include_no_module compile through the same window.
	filtered := spec
	filtered.Filters.ModuleIDs = []string{moduleA}
	filtered.Filters.IncludeNoModule = true
	var rows issueTableRowsResponse
	testutil.Call(t, testHandler.ListIssueTableRows, newRequest(http.MethodPost, "/api/issues/table/rows", issueTableRowsRequest{
		Query: filtered,
		Group: issueTableGroupSpec{Kind: "none"},
	})).Want(http.StatusOK).JSON(&rows)
	got := map[string]bool{}
	for _, row := range rows.Rows {
		got[row.Issue.ID] = true
	}
	if !got[inA] || !got[unfiled] || len(rows.Rows) != 2 {
		t.Fatalf("module_ids + include_no_module rows = %v", got)
	}

	// Module is accepted as a compound primary alongside project.
	var compound issueTableGroupsResponse
	testutil.Call(t, testHandler.ListIssueTableGroups, newRequest(http.MethodPost, "/api/issues/table/groups", issueTableGroupsRequest{
		Query: spec,
		Group: issueTableGroupSpec{Kind: "compound", Primary: "module", Secondary: "status"},
	})).Want(http.StatusOK).JSON(&compound)
	if len(compound.Groups) == 0 {
		t.Fatal("compound module grouping returned no groups")
	}
}
