package handler

import (
	"net/http"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

// An issue claim is where the collaboration space stops being a database column
// and becomes something an agent acts on: the claim payload is what the daemon
// renders into the runtime brief. These tests pin what reaches that payload.
//
// The module reference behind it is SOFT — issue.module_id and module.project_id
// are plain columns with no foreign key (the repo's no-FK rule) — so the claim
// resolver, not the schema, is what keeps a stale or mismatched reference from
// handing an agent a directory belonging to work it is not doing.

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
	ModuleCollabPath   string `json:"module_collab_path"`
}

// claimIssueTask queues a task for issueID on the workspace's seeded agent and
// returns the claim payload. One claim per test: the claimed task stays
// dispatched until the test's fixture cleanup removes it.
func claimIssueTask(t *testing.T, issueID, daemonID string) claimModuleFields {
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
	return *resp.Task
}

const (
	claimProjectCollabPath = "/Volumes/人机协作空间/AI医药联合创新平台"
	claimModuleCollabPath  = "/Volumes/人机协作空间/AI医药联合创新平台/01高质量数据集/01.01回顾性队列数据集（JIA）"
)

// The whole point of the feature, end to end: an issue inside a module that
// names a collaboration space produces a claim carrying both paths plus the
// module identity the brief needs to say which module the work belongs to.
func TestClaimTask_IssueModuleContext_CarriesCollabPaths(t *testing.T) {
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
		"collab_path": claimModuleCollabPath,
	})
	issueID := dbfx.Issue(t, "Claim carries the collaboration space", testutil.Cols{
		"project_id": projectID,
		"module_id":  moduleID,
	})

	task := claimIssueTask(t, issueID, "test-claim-module-collab")

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
	if task.ModuleCollabPath != claimModuleCollabPath {
		t.Errorf("module_collab_path = %q, want %q", task.ModuleCollabPath, claimModuleCollabPath)
	}
}

// module.project_id is an application-layer relation, and UpdateIssue clears
// module_id on a project change — but nothing in the schema enforces either.
// A module that survived pointing at a different project than the issue does
// would otherwise hand the agent a directory belonging to another project's
// work, which is the one failure the collaboration space cannot recover from:
// the deliverable lands somewhere real, so nobody gets an error, and nobody
// finds the file.
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
	strayModule := dbfx.Module(t, otherProject, "另一个项目的模块", testutil.Cols{
		"collab_path": claimModuleCollabPath,
	})
	// Written straight to the row: the API rejects this pairing, so the only
	// way to reach the state the cross-check defends against is to build it.
	issueID := dbfx.Issue(t, "Issue pointing at another project's module", testutil.Cols{
		"project_id": issueProject,
		"module_id":  strayModule,
	})

	task := claimIssueTask(t, issueID, "test-claim-module-mismatch")

	if task.ModuleID != "" || task.ModuleTitle != "" || task.ModuleCollabPath != "" {
		t.Errorf("cross-project module reached the claim: id=%q title=%q path=%q",
			task.ModuleID, task.ModuleTitle, task.ModuleCollabPath)
	}
	if task.ModuleCollabPath == claimModuleCollabPath {
		t.Error("claim carries a collaboration path from a project this issue is not in")
	}
	if task.ProjectID != issueProject {
		t.Errorf("project_id = %q, want the issue's own project %q", task.ProjectID, issueProject)
	}
	if task.ProjectCollabPath != claimProjectCollabPath {
		t.Errorf("project_collab_path = %q, want the issue's own project path", task.ProjectCollabPath)
	}
}

// A module row that resolves to nothing in this workspace is the stale-reference
// case: deleted, or pointing across a tenant boundary. Same verdict as the
// mismatch — degrade to project context, never fail the claim.
func TestClaimTask_ModuleInForeignWorkspace_IsDropped(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	foreignWS := dbfx.Workspace(t, "Claim module foreign ws", "claim-module-foreign-"+moduleSuffix(), nil)
	foreignProject := dbfx.Insert(t, "project", testutil.Cols{
		"workspace_id": foreignWS,
		"title":        "Foreign claim project",
	})
	const foreignPath = "/Volumes/人机协作空间/外部租户/不得泄露"
	foreignModule := dbfx.Insert(t, "module", testutil.Cols{
		"workspace_id": foreignWS,
		"project_id":   foreignProject,
		"title":        "外部租户模块",
		"collab_path":  foreignPath,
	})

	localProject := dbfx.Project(t, "Claim foreign module local project", testutil.Cols{
		"collab_path": claimProjectCollabPath,
	})
	issueID := dbfx.Issue(t, "Issue pointing at a foreign workspace module", testutil.Cols{
		"project_id": localProject,
		"module_id":  foreignModule,
	})

	task := claimIssueTask(t, issueID, "test-claim-module-foreign")

	if task.ModuleID != "" || task.ModuleCollabPath != "" {
		t.Errorf("foreign-workspace module reached the claim: id=%q path=%q", task.ModuleID, task.ModuleCollabPath)
	}
	if task.ModuleCollabPath == foreignPath || task.ProjectCollabPath == foreignPath {
		t.Error("claim leaked another tenant's collaboration path")
	}
	if task.ProjectCollabPath != claimProjectCollabPath {
		t.Errorf("project_collab_path = %q, want the issue's own project path", task.ProjectCollabPath)
	}
}

// Most issues have no module. The claim must carry the project context and
// leave every module field empty — `omitempty` keeps them off the wire, and a
// daemon that sees an empty module renders no module paragraph at all.
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

	task := claimIssueTask(t, issueID, "test-claim-no-module")

	if task.ModuleID != "" || task.ModuleTitle != "" || task.ModuleDescription != "" || task.ModuleCollabPath != "" {
		t.Errorf("module fields populated for an issue with no module: %+v", task)
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

	task := claimIssueTask(t, issueID, "test-claim-no-collab-path")

	if task.ProjectCollabPath != "" || task.ModuleCollabPath != "" {
		t.Errorf("collab paths = (%q, %q), want both empty", task.ProjectCollabPath, task.ModuleCollabPath)
	}
	// The module itself still reaches the agent: it is context in its own
	// right, independent of shared storage.
	if task.ModuleID != moduleID || task.ModuleTitle != "模块无路径" {
		t.Errorf("module context dropped along with the absent path: id=%q title=%q", task.ModuleID, task.ModuleTitle)
	}
}
