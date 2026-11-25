package handler

import (
	"net/http"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

func reqInWorkspace(method, path, ws string, body any) *http.Request {
	req := newRequest(method, path, body)
	req.Header.Set("X-Workspace-ID", ws)
	return req
}

func TestProjectAndModuleResponsesIncludeCockpitCodes(t *testing.T) {
	ws := dbfx.Workspace(t, "Code Echo Workspace", "code-echo-"+moduleSuffix(), nil)
	dbfx.Member(t, ws, testUserID, "owner")
	boardID := dbfx.Insert(t, "cockpit", testutil.Cols{
		"workspace_id":       ws,
		"title":              "Code Board",
		"plan_reconciled_at": "2026-11-25T00:00:00Z",
	})

	// Creating a project on a reconciled board mints its L1 skeleton row and
	// immediately returns the assigned code.
	var createdProject ProjectResponse
	testutil.Call(t, testHandler.CreateProject, reqInWorkspace(
		http.MethodPost, "/api/projects", ws, map[string]any{"title": "高质量数据集"},
	)).Want(http.StatusCreated).JSON(&createdProject)
	if createdProject.Code == nil || *createdProject.Code != "01" {
		t.Fatalf("created project code = %v, want 01", createdProject.Code)
	}

	// GetProject and ListProjects echo the same code.
	var gotProject ProjectResponse
	testutil.Call(t, testHandler.GetProject, withURLParam(
		reqInWorkspace(http.MethodGet, "/api/projects/"+createdProject.ID, ws, nil), "id", createdProject.ID,
	)).Want(http.StatusOK).JSON(&gotProject)
	if gotProject.Code == nil || *gotProject.Code != "01" {
		t.Fatalf("get project code = %v, want 01", gotProject.Code)
	}

	var listedProjects struct {
		Projects []ProjectResponse `json:"projects"`
	}
	testutil.Call(t, testHandler.ListProjects, reqInWorkspace(
		http.MethodGet, "/api/projects", ws, nil,
	)).Want(http.StatusOK).JSON(&listedProjects)
	if len(listedProjects.Projects) != 1 || listedProjects.Projects[0].Code == nil || *listedProjects.Projects[0].Code != "01" {
		t.Fatalf("list projects = %+v", listedProjects.Projects)
	}

	// SearchProjects finds by code and echoes the code.
	var searchProjects struct {
		Projects []SearchProjectResponse `json:"projects"`
	}
	testutil.Call(t, testHandler.SearchProjects, reqInWorkspace(
		http.MethodGet, "/api/projects/search?q=01", ws, nil,
	)).Want(http.StatusOK).JSON(&searchProjects)
	if len(searchProjects.Projects) != 1 || searchProjects.Projects[0].ID != createdProject.ID || searchProjects.Projects[0].Code == nil || *searchProjects.Projects[0].Code != "01" {
		t.Fatalf("search projects by code = %+v", searchProjects.Projects)
	}

	// Creating a module mints its L2 skeleton row and returns its code.
	var createdModule struct {
		Module ModuleResponse `json:"module"`
	}
	testutil.Call(t, testHandler.CreateModule, reqInWorkspace(
		http.MethodPost, "/api/modules", ws, map[string]any{
			"project_id": createdProject.ID,
			"title":      "回顾性队列数据集",
		},
	)).Want(http.StatusCreated).JSON(&createdModule)
	if createdModule.Module.Code == nil || *createdModule.Module.Code != "01.01" {
		t.Fatalf("created module code = %v, want 01.01", createdModule.Module.Code)
	}

	// ListModules, GetModule, UpdateModule all echo the module code.
	var listedModules struct {
		Modules []ModuleResponse `json:"modules"`
	}
	testutil.Call(t, testHandler.ListModules, reqInWorkspace(
		http.MethodGet, "/api/modules?project_id="+createdProject.ID, ws, nil,
	)).Want(http.StatusOK).JSON(&listedModules)
	if len(listedModules.Modules) != 1 || listedModules.Modules[0].Code == nil || *listedModules.Modules[0].Code != "01.01" {
		t.Fatalf("list modules = %+v", listedModules.Modules)
	}

	var updatedModule struct {
		Module ModuleResponse `json:"module"`
	}
	testutil.Call(t, testHandler.UpdateModule, withURLParam(
		reqInWorkspace(http.MethodPut, "/api/modules/"+createdModule.Module.ID, ws, map[string]any{"title": "回顾性队列（更新）"}),
		"id", createdModule.Module.ID,
	)).Want(http.StatusOK).JSON(&updatedModule)
	if updatedModule.Module.Code == nil || *updatedModule.Module.Code != "01.01" {
		t.Fatalf("updated module code = %v, want 01.01", updatedModule.Module.Code)
	}

	_ = boardID
}
