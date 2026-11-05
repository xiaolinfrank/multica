package handler

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/workspacecontext"
)

func TestCreateWorkspaceCollaborationContext(t *testing.T) {
	custom := "  Preserve this user's own workspace rules.\n"
	for _, tc := range []struct {
		name  string
		input any
		want  string
	}{
		{"omitted", nil, workspacecontext.V1},
		{"blank", " \t\n", workspacecontext.V1},
		{"custom", custom, custom},
	} {
		t.Run(tc.name, func(t *testing.T) {
			slug := "context-test-" + uuid.NewString()
			body := map[string]any{"name": "Context test", "slug": slug}
			if tc.input != nil {
				body["context"] = tc.input
			}
			var out WorkspaceResponse
			testutil.Call(t, testHandler.CreateWorkspace, newRequest(http.MethodPost, "/api/workspaces", body)).Want(http.StatusCreated).JSON(&out)
			dbfx.Cleanup(t, "DELETE FROM workspace WHERE id=$1", out.ID)
			dbfx.Cleanup(t, "DELETE FROM member WHERE workspace_id=$1", out.ID)
			dbfx.Cleanup(t, "DELETE FROM issue_status WHERE workspace_id=$1", out.ID)
			var persisted string
			dbfx.QueryRow(t, "SELECT context FROM workspace WHERE id=$1", out.ID).Scan(&persisted)
			if out.Context == nil || *out.Context != tc.want || persisted != tc.want {
				t.Fatal("create response or persisted workspace context differs from expected default/custom value")
			}
		})
	}
}
