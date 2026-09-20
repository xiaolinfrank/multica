package handler

import (
	"net/http"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

// An issue claim is where the collaboration space stops being a database column
// and becomes something an agent acts on: the claim payload is what the daemon
// renders into the runtime brief. These tests pin what reaches that payload.
//
// Only the PROJECT carries a path. The module contributes identity — id, title,
// description — and the brief locates its work by folder name under the
// project's directory, so there is nothing module-shaped left for the claim to
// carry beyond who the module is.
//
// The module reference behind it is SOFT — issue.module_id and module.project_id
// are plain columns with no foreign key (the repo's no-FK rule) — so the claim
// resolver, not the schema, is what keeps a stale or mismatched reference from
// telling an agent it is working in a module it is not.

// claimModuleFields is the slice of the claim payload these tests read.
type claimModuleFields struct {
	IssueID            string `json:"issue_id"`
	ProjectID          string `json:"project_id"`
	ProjectTitle       string `json:"project_title"`
	ProjectDescription string `json:"project_description"`
	ProjectCollabPath  string `json:"project_collab_path"`
	ModuleID           string `json:"module_id"`
	ModuleTitle        string `json:"module_title"`
	ModuleDescription  string `json:"module_description"`
}

// claimIssueTask queues a task for issueID on the workspace's seeded agent and
// returns the claim payload, plus the raw response body for key-level checks a
// typed decode cannot make. One claim per test: the claimed task stays
// dispatched until the test's fixture cleanup removes it.
func claimIssueTask(t *testing.T, issueID, daemonID string) (claimModuleFields, string) {
	t.Helper()

	var agentID, runtimeID string
	dbfx.QueryRow(t,
		`SELECT id, runtime_id FROM agent WHERE workspace_id = $1 LIMIT 1`,
		testWorkspaceID,
	).Scan(&agentID, &runtimeID)
	dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "issue_id": issueID})

	req := newDaemonTokenRequest(http.MethodPost, "/api/daemon/runtimes/"+runtimeID+"/claim", nil,
		testWorkspaceID, daemonID)
	req = withURLParam(req, "runtimeId", runtimeID)
	w := testutil.Call(t, testHandler.ClaimTaskByRuntime, req).Want(http.StatusOK)

	var resp struct {
		Task *claimModuleFields `json:"task"`
	}
	w.JSON(&resp)
	if resp.Task == nil {
		t.Fatalf("expected a task in the claim response: %s", w.Text())
	}
	// The seeded runtime is shared, so prove we are asserting on our own task.
	if resp.Task.IssueID != issueID {
		t.Fatalf("claimed issue %q, want %q", resp.Task.IssueID, issueID)
	}
	return *resp.Task, w.Text()
}

const claimProjectCollabPath = "/Volumes/人机协作空间/AI医药联合创新平台"

// The whole point of the feature, end to end: an issue inside a module that
// belongs to a project naming a collaboration space produces a claim carrying
// the project's path plus the module identity the brief needs to say which
// module the work belongs to — and NO module path, because the module's folder
// is found by name under that one directory.
func TestClaimTask_IssueModuleContext_CarriesProjectCollabPath(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	projectID := dbfx.Project(t, "Claim collab project", testutil.Cols{
		"description":  "Deliverables are reviewed before release.",
		"collab_path":  claimProjectCollabPath,
		"workspace_id": testWorkspaceID,
	})
	moduleID := dbfx.Module(t, projectID, "01高质量数据集", testutil.Cols{
		"description": "回顾性队列数据集的清洗与标注规范。",
	})
	issueID := dbfx.Issue(t, "Claim carries the collaboration space", testutil.Cols{
		"project_id": projectID,
		"module_id":  moduleID,
	})

	task, body := claimIssueTask(t, issueID, "test-claim-module-collab")

	if task.ProjectID != projectID {
		t.Errorf("project_id = %q, want %q", task.ProjectID, projectID)
	}
	if task.ProjectCollabPath != claimProjectCollabPath {
		t.Errorf("project_collab_path = %q, want %q", task.ProjectCollabPath, claimProjectCollabPath)
	}
	if task.ModuleID != moduleID {
		t.Errorf("module_id = %q, want %q", task.ModuleID, moduleID)
	}
	if task.ModuleTitle != "01高质量数据集" {
		t.Errorf("module_title = %q, want the module's title", task.ModuleTitle)
	}
	if task.ModuleDescription != "回顾性队列数据集的清洗与标注规范。" {
		t.Errorf("module_description = %q, want the module's description", task.ModuleDescription)
	}
	// Key-level: a reinstated module path would decode into no field above and
	// leave the typed assertions green.
	wantNoModuleCollabPath(t, body)
}

// wantNoModuleCollabPath asserts the claim payload carries no module-scoped
// collaboration path under any spelling. The daemon mirrors this payload into
// its own Task struct and then into the brief, so a key that reappears here is
// a value the fleet would start rendering again.
func wantNoModuleCollabPath(t *testing.T, body string) {
	t.Helper()
	for _, key := range []string{"module_collab_path", "module_path", "module_directory"} {
		if strings.Contains(body, `"`+key+`"`) {
			t.Errorf("claim payload carries %q — the module has no path of its own: %s", key, body)
		}
	}
}

// module.project_id is an application-layer relation, and UpdateIssue clears
// module_id on a project change — but nothing in the schema enforces either.
// A module that survived pointing at a different project than the issue does
// would otherwise tell the agent its work belongs in a folder under a project
// it is not working in — and since the folder is resolved by name under the
// issue's own project directory, that is a deliverable filed under a module
// name that means something different there. Nobody gets an error; nobody finds
// the file.
//
// The project half of the context must still come through — dropping the
// module is a narrowing, not a claim failure.
func TestClaimTask_ModuleFromAnotherProject_IsDropped(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	issueProject := dbfx.Project(t, "Claim module mismatch issue project", testutil.Cols{
		"collab_path": claimProjectCollabPath,
	})
	const otherPath = "/Volumes/人机协作空间/另一个项目/成果"
	otherProject := dbfx.Project(t, "Claim module mismatch other project", testutil.Cols{
		"collab_path": otherPath,
	})
	strayModule := dbfx.Module(t, otherProject, "另一个项目的模块")
	// Written straight to the row: the API rejects this pairing, so the only
	// way to reach the state the cross-check defends against is to build it.
	issueID := dbfx.Issue(t, "Issue pointing at another project's module", testutil.Cols{
		"project_id": issueProject,
		"module_id":  strayModule,
	})

	task, _ := claimIssueTask(t, issueID, "test-claim-module-mismatch")

	if task.ModuleID != "" || task.ModuleTitle != "" || task.ModuleDescription != "" {
		t.Errorf("cross-project module reached the claim: id=%q title=%q description=%q",
			task.ModuleID, task.ModuleTitle, task.ModuleDescription)
	}
	if task.ProjectID != issueProject {
		t.Errorf("project_id = %q, want the issue's own project %q", task.ProjectID, issueProject)
	}
	if task.ProjectCollabPath != claimProjectCollabPath {
		t.Errorf("project_collab_path = %q, want the issue's own project path", task.ProjectCollabPath)
	}
	if task.ProjectCollabPath == otherPath {
		t.Error("claim carries a collaboration path from a project this issue is not in")
	}
}

// A module row that resolves to nothing in this workspace is the stale-reference
// case: deleted, or pointing across a tenant boundary. Same verdict as the
// mismatch — degrade to project context, never fail the claim. The module title
// is another tenant's content, so dropping it is a confidentiality guard as well
// as a correctness one.
func TestClaimTask_ModuleInForeignWorkspace_IsDropped(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	foreignWS := dbfx.Workspace(t, "Claim module foreign ws", "claim-module-foreign-"+moduleSuffix(), nil)
	foreignProject := dbfx.Insert(t, "project", testutil.Cols{
		"workspace_id": foreignWS,
		"title":        "Foreign claim project",
		"collab_path":  "/Volumes/人机协作空间/外部租户/不得泄露",
	})
	const foreignModuleTitle = "外部租户模块"
	foreignModule := dbfx.Insert(t, "module", testutil.Cols{
		"workspace_id": foreignWS,
		"project_id":   foreignProject,
		"title":        foreignModuleTitle,
	})

	localProject := dbfx.Project(t, "Claim foreign module local project", testutil.Cols{
		"collab_path": claimProjectCollabPath,
	})
	issueID := dbfx.Issue(t, "Issue pointing at a foreign workspace module", testutil.Cols{
		"project_id": localProject,
		"module_id":  foreignModule,
	})

	task, body := claimIssueTask(t, issueID, "test-claim-module-foreign")

	if task.ModuleID != "" || task.ModuleTitle != "" {
		t.Errorf("foreign-workspace module reached the claim: id=%q title=%q", task.ModuleID, task.ModuleTitle)
	}
	if strings.Contains(body, foreignModuleTitle) || strings.Contains(body, "不得泄露") {
		t.Errorf("claim leaked another tenant's content: %s", body)
	}
	if task.ProjectCollabPath != claimProjectCollabPath {
		t.Errorf("project_collab_path = %q, want the issue's own project path", task.ProjectCollabPath)
	}
}

// Most issues have no module. The claim must carry the project context and
// leave every module field empty — `omitempty` keeps them off the wire, and a
// daemon that sees an empty module renders no module paragraph and no folder
// line at all.
func TestClaimTask_IssueWithoutModule_CarriesEmptyModuleFields(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	projectID := dbfx.Project(t, "Claim no module project", testutil.Cols{
		"collab_path": claimProjectCollabPath,
	})
	issueID := dbfx.Issue(t, "Issue with no module at all", testutil.Cols{
		"project_id": projectID,
	})

	task, body := claimIssueTask(t, issueID, "test-claim-no-module")

	if task.ModuleID != "" || task.ModuleTitle != "" || task.ModuleDescription != "" {
		t.Errorf("module fields populated for an issue with no module: %+v", task)
	}
	if strings.Contains(body, `"module_id"`) || strings.Contains(body, `"module_title"`) {
		t.Errorf("empty module keys reached the wire despite omitempty: %s", body)
	}
	if task.ProjectCollabPath != claimProjectCollabPath {
		t.Errorf("project_collab_path = %q, want %q", task.ProjectCollabPath, claimProjectCollabPath)
	}
}

// A project with no collaboration space is the default, and it must stay empty
// on the wire rather than becoming an empty-string path the brief renders as a
// bullet pointing nowhere.
func TestClaimTask_ProjectWithoutCollabPath_SendsNoPath(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	projectID := dbfx.Project(t, "Claim project without a collab path")
	moduleID := dbfx.Module(t, projectID, "模块无路径")
	issueID := dbfx.Issue(t, "Issue whose project has no collaboration space", testutil.Cols{
		"project_id": projectID,
		"module_id":  moduleID,
	})

	task, body := claimIssueTask(t, issueID, "test-claim-no-collab-path")

	if task.ProjectCollabPath != "" {
		t.Errorf("project_collab_path = %q, want empty", task.ProjectCollabPath)
	}
	if strings.Contains(body, `"project_collab_path"`) {
		t.Errorf("empty project_collab_path reached the wire despite omitempty: %s", body)
	}
	// The module itself still reaches the agent: it is context in its own
	// right, independent of shared storage.
	if task.ModuleID != moduleID || task.ModuleTitle != "模块无路径" {
		t.Errorf("module context dropped along with the absent path: id=%q title=%q", task.ModuleID, task.ModuleTitle)
	}
	wantNoModuleCollabPath(t, body)
}
