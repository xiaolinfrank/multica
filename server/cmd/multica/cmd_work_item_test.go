package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/cli"
)

const (
	testPlanRootID   = "11111111-1111-1111-1111-111111111111"
	testPlanModuleID = "22222222-2222-2222-2222-222222222222"
	testPlanItemID   = "33333333-3333-3333-3333-333333333333"
)

// workItemResolverServer answers GET /api/cockpit with the three levels of one
// plan branch, so the resolver can prove it only accepts the third.
func workItemResolverServer(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/cockpit" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"nodes": []any{
				map[string]any{"id": testPlanRootID, "code": "01", "name": "项目"},
				map[string]any{"id": testPlanModuleID, "code": "01.01", "name": "模块", "parent_id": testPlanRootID},
				map[string]any{"id": testPlanItemID, "code": "01.01.01", "name": "工作项", "parent_id": testPlanModuleID},
			},
		})
	}))
}

func TestResolveWorkItemIDOnlyAcceptsThirdLevel(t *testing.T) {
	srv := workItemResolverServer(t)
	defer srv.Close()
	setCLITestServerEnv(t, srv.URL)
	client := cli.NewAPIClient(srv.URL, "ws-1", "test-token")
	ctx := context.Background()

	t.Run("third-level code", func(t *testing.T) {
		got, err := resolveWorkItemID(ctx, client, "01.01.01")
		if err != nil {
			t.Fatalf("resolveWorkItemID: %v", err)
		}
		if got.ID != testPlanItemID {
			t.Fatalf("id = %q, want %q", got.ID, testPlanItemID)
		}
	})

	t.Run("module-level code is refused with its level", func(t *testing.T) {
		_, err := resolveWorkItemID(ctx, client, "01.01")
		if err == nil {
			t.Fatal("expected an error for a module-level code")
		}
		if !strings.Contains(err.Error(), "module-level") {
			t.Fatalf("error = %q, want it to name the node's level", err)
		}
	})

	t.Run("project-level code is refused with its level", func(t *testing.T) {
		_, err := resolveWorkItemID(ctx, client, "01")
		if err == nil {
			t.Fatal("expected an error for a project-level code")
		}
		if !strings.Contains(err.Error(), "project-level") {
			t.Fatalf("error = %q, want it to name the node's level", err)
		}
	})

	t.Run("uuid prefix of a non-work-item node", func(t *testing.T) {
		_, err := resolveWorkItemID(ctx, client, "22222222")
		if err == nil || !strings.Contains(err.Error(), "no work item found") {
			t.Fatalf("error = %v, want a no-work-item-found error", err)
		}
	})

	t.Run("full uuid needs no level lookup", func(t *testing.T) {
		got, err := resolveWorkItemID(ctx, client, testPlanItemID)
		if err != nil {
			t.Fatalf("resolveWorkItemID: %v", err)
		}
		if got.ID != testPlanItemID {
			t.Fatalf("id = %q, want %q", got.ID, testPlanItemID)
		}
	})
}
