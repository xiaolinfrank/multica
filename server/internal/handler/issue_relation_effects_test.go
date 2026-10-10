package handler

import (
	"net/http"
	"testing"

	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestIssueRelationEffectsParentAdoptionHonorsScopeGuards(t *testing.T) {
	f := newArtifactHTTPFixture(t)
	f.create(t)
	projectB := dbfx.Project(t, "Other filing", testutil.Cols{"workspace_id": f.ws})
	moduleB := dbfx.Module(t, projectB, "Other module", testutil.Cols{"workspace_id": f.ws})
	parentB := dbfx.Issue(t, "Parent in other filing", testutil.Cols{"workspace_id": f.ws, "project_id": projectB, "module_id": moduleB})
	sameParent := dbfx.Issue(t, "Same filing parent", testutil.Cols{"workspace_id": f.ws, "project_id": f.project, "module_id": f.module})
	ordinary := dbfx.Issue(t, "Ordinary batch adoptee", testutil.Cols{"workspace_id": f.ws, "project_id": f.project, "module_id": f.module})
	withDescription := dbfx.Issue(t, "Atomic document adoptee", testutil.Cols{"workspace_id": f.ws, "project_id": f.project, "module_id": f.module})
	var batch testIssueBatchReply
	f.call(t, f.h.BatchUpdateIssues, http.MethodPost, "/batch-update", map[string]any{"issue_ids": []string{ordinary}, "updates": map[string]any{"parent_issue_id": parentB, "suppress_run": true}}).Want(200).JSON(&batch)
	if batch.Updated != 1 || batch.Results[0].Outcome != "applied" {
		t.Fatal(batch)
	}
	var row IssueResponse
	f.call(t, f.h.UpdateIssue, http.MethodPut, "/issues", map[string]any{"parent_issue_id": parentB, "description": "Keep the entered document", "suppress_run": true}, "id", withDescription).Want(200).JSON(&row)
	for _, id := range []string{ordinary, withDescription} {
		var parent, project, module string
		dbfx.QueryRow(t, "SELECT parent_issue_id,project_id,module_id FROM issue WHERE id=$1", id).Scan(&parent, &project, &module)
		if parent != parentB || project != projectB || module != moduleB {
			t.Fatalf("locked refresh discarded parent filing: %s %s %s", parent, project, module)
		}
	}
	// A retained source may acquire a parent in the same scope; there is no blanket parent lock.
	f.call(t, f.h.UpdateIssue, http.MethodPut, "/issues", map[string]any{"parent_issue_id": sameParent, "description": "Same-scope source clarification", "suppress_run": true}, "id", f.source).Want(200)
	for _, method := range []string{"single", "batch"} {
		t.Run(method, func(t *testing.T) {
			body := map[string]any{"parent_issue_id": parentB, "description": "Must not escape retained scope", "suppress_run": true}
			if method == "single" {
				f.call(t, f.h.UpdateIssue, http.MethodPut, "/issues", body, "id", f.source).Want(409)
			} else {
				f.call(t, f.h.BatchUpdateIssues, http.MethodPost, "/batch-update", map[string]any{"issue_ids": []string{f.source}, "updates": body}).Want(409)
			}
			var parent, project, module, description string
			dbfx.QueryRow(t, "SELECT parent_issue_id,project_id,module_id,description FROM issue WHERE id=$1", f.source).Scan(&parent, &project, &module, &description)
			if parent != sameParent || project != f.project || module != f.module || description != "Same-scope source clarification" {
				t.Fatal("implicit re-filing bypassed fixed source retention or partially saved the document")
			}
		})
	}
	f.call(t, f.h.UpdateIssue, http.MethodPut, "/issues", map[string]any{"parent_issue_id": nil, "stage": nil, "suppress_run": true}, "id", f.source).Want(200)
	var stillScoped int
	dbfx.QueryRow(t, "SELECT count(*) FROM issue WHERE id=$1 AND parent_issue_id IS NULL AND project_id=$2 AND module_id=$3", f.source, f.project, f.module).Scan(&stillScoped)
	if stillScoped != 1 {
		t.Fatal("detaching unexpectedly cleared retained filing")
	}
}

func TestIssueRelationEffectsDuplicateUsesActualClosedCategory(t *testing.T) {
	f := newArtifactHTTPFixture(t)
	artifact := f.create(t)
	version := f.submit(t, artifact)
	reviewID := version.Version.Version.ReviewIssue.ID
	original := dbfx.Issue(t, "Original item", testutil.Cols{"workspace_id": f.ws})
	// Omitting explicit status must not bypass the actual cancelled/closed effect.
	f.call(t, f.h.UpdateIssue, http.MethodPut, "/issues", map[string]any{"duplicate_of_issue_id": original, "suppress_run": true}, "id", reviewID).Want(409)
	var status string
	var marked bool
	dbfx.QueryRow(t, "SELECT status,duplicate_of_issue_id IS NOT NULL FROM issue WHERE id=$1", reviewID).Scan(&status, &marked)
	if status != "todo" || marked {
		t.Fatal("implicit duplicate cancellation finished a formal pending review")
	}
	var result service.CockpitArtifactVersionCommandResponse
	f.call(t, f.h.ReviewCockpitArtifactVersion, http.MethodPost, "/review", map[string]any{"expected_revision": version.Version.Version.Revision, "decision": "changes_requested", "feedback": "Please revise"}, "artifactId", artifact.ID, "versionId", version.Version.Version.ID).Want(200).JSON(&result)
	f.call(t, f.h.UpdateIssue, http.MethodPut, "/issues", map[string]any{"duplicate_of_issue_id": original, "suppress_run": true}, "id", reviewID).Want(409)
	ordinary := dbfx.Issue(t, "Ordinary duplicate", testutil.Cols{"workspace_id": f.ws})
	f.call(t, f.h.UpdateIssue, http.MethodPut, "/issues", map[string]any{"duplicate_of_issue_id": original, "suppress_run": true}, "id", ordinary).Want(200)
	dbfx.QueryRow(t, "SELECT status,duplicate_of_issue_id IS NOT NULL FROM issue WHERE id=$1", ordinary).Scan(&status, &marked)
	if status != "cancelled" || !marked {
		t.Fatal("ordinary duplicate did not use cancelled state")
	}
	f.call(t, f.h.UpdateIssue, http.MethodPut, "/issues", map[string]any{"duplicate_of_issue_id": nil}, "id", ordinary).Want(400)
	f.call(t, f.h.UpdateIssue, http.MethodPut, "/issues", map[string]any{"status": "todo", "suppress_run": true}, "id", ordinary).Want(200)
	dbfx.QueryRow(t, "SELECT status,duplicate_of_issue_id IS NOT NULL FROM issue WHERE id=$1", ordinary).Scan(&status, &marked)
	if status != "todo" || marked {
		t.Fatal("explicit reopening did not remove duplicate mark")
	}
}
