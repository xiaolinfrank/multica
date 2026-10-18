package handler

import (
	"fmt"
	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/testutil"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
)

func callWorkflowHistory(t *testing.T, fn http.HandlerFunc, method, ws, meeting, path string, body any, params ...string) *testutil.Response {
	t.Helper()
	request := cockpitRequest(method, path, ws, body)
	kv := append([]string{"meetingId", meeting}, params...)
	return testutil.Call(t, cockpitHandler(fn), testutil.WithURLParams(request, kv...))
}
func initializeCompactWorkflow(t *testing.T) (string, CockpitMeetingResponse, CockpitWorkflowCompactResponse) {
	t.Helper()
	ws, meeting := newCockpitWorkflowHTTPFixture(t)
	var out CockpitWorkflowCompactResponse
	callWorkflowHistory(t, testHandler.EnableCockpitMeetingWorkflow, "POST", ws, meeting.ID, "/workflow?response=compact", map[string]any{"reviewer_id": testUserID}).Want(200).JSON(&out)
	if out.Representation != "compact" || out.Receipt.Action != "enabled" || !out.Workflow.Enabled {
		t.Fatalf("initial compact contract: %+v", out)
	}
	callWorkflowHistory(t, testHandler.UpdateCockpitMeetingReadiness, "PATCH", ws, meeting.ID, "/workflow?response=compact", map[string]any{"expected_revision": out.Workflow.Revision, "ended": true, "materials_ready": true}).Want(200).JSON(&out)
	callWorkflowHistory(t, testHandler.ReleaseCockpitMeetingMinutes, "POST", ws, meeting.ID, "/release?response=compact", map[string]any{"expected_revision": out.Workflow.Revision}).Want(200).JSON(&out)
	return ws, meeting, out
}
func TestCockpitHistoryBoundedVersionsAndExactOldSubmission(t *testing.T) {
	ws, meeting, state := initializeCompactWorkflow(t)
	var first map[string]any
	var firstID, publishedID string
	for i := 1; i <= 28; i++ {
		command := map[string]any{"expected_revision": state.Workflow.Revision, "submission_key": uuid.NewString(), "content": strings.TrimSpace(fmt.Sprintf("BODY-VERSION-%d\n", i) + strings.Repeat("evidence ", 4096))}
		callWorkflowHistory(t, testHandler.SubmitCockpitMeetingMinutes, "POST", ws, meeting.ID, "/versions?response=compact", command).Want(200).JSON(&state)
		if state.Receipt.Action != "submitted" || state.Receipt.Version == nil || state.Receipt.Version.VersionNumber != int32(i) || state.Workflow.HistoryCounts.Versions != int64(i) {
			t.Fatalf("submission identity: %+v", state)
		}
		if i == 1 {
			first = command
			firstID = state.Receipt.Version.ID
		}
		if i == 28 {
			break
		}
		id := state.Receipt.Version.ID
		callWorkflowHistory(t, testHandler.ReviewCockpitMeetingMinutes, "POST", ws, meeting.ID, "/review?response=compact", map[string]any{"expected_revision": state.Workflow.Revision, "decision": "approved"}, "versionId", id).Want(200).JSON(&state)
		if i == 27 {
			callWorkflowHistory(t, testHandler.PublishCockpitMeetingMinutes, "POST", ws, meeting.ID, "/publish?response=compact", map[string]any{"expected_revision": state.Workflow.Revision}, "versionId", id).Want(200).JSON(&state)
			publishedID = id
		}
	}
	var summary CockpitWorkflowSummaryResponse
	result := callWorkflowHistory(t, testHandler.GetCockpitWorkflowSummary, "GET", ws, meeting.ID, "/summary", nil).Want(200).JSON(&summary)
	if summary.CurrentVersion == nil || summary.PublishedVersion == nil || summary.CurrentVersion.VersionNumber != 28 || summary.PublishedVersion.ID != publishedID || summary.HistoryCounts.Versions != 28 || !summary.CanReview || strings.Contains(result.Text(), "BODY-VERSION-") || strings.Contains(result.Text(), `"content":`) {
		t.Fatalf("summary loaded history/body or lost pins: %s", result.Text())
	}
	// A compact read or old-key receipt must never materialize the old histories.
	for _, name := range []string{"ListCockpitMinutesVersions", "ListCockpitReviewerHandoffs", "ListCockpitMinutesExports", "ListCockpitWorkflowIssues"} {
		h := *testHandler
		h.TxStarter = meetingQueryFailureStarter{base: h.TxStarter, name: name}
		callWorkflowHistory(t, h.GetCockpitWorkflowSummary, "GET", ws, meeting.ID, "/summary", nil).Want(200)
		response := callWorkflowHistory(t, h.SubmitCockpitMeetingMinutes, "POST", ws, meeting.ID, "/versions?response=compact", first).Want(200).JSON(&state)
		if state.Receipt.Version == nil || state.Receipt.Version.ID != firstID || state.Workflow.CurrentVersion.VersionNumber != 28 || state.Receipt.Version.Content != first["content"] || strings.Count(response.Text(), `"content":`) != 1 {
			t.Fatal("receipt inferred from current pin/history")
		}
	}
	var page CockpitMinutesVersionPage
	result = callWorkflowHistory(t, testHandler.ListCockpitMinutesVersionHistory, "GET", ws, meeting.ID, "/versions?page_size=25", nil).Want(200).JSON(&page)
	if page.Total != 28 || len(page.Items) != 25 || page.NextCursor == nil || strings.Contains(result.Text(), `"content":`) || strings.Contains(result.Text(), "BODY-VERSION-") {
		t.Fatal("metadata page is not bounded")
	}
	cursor := *page.NextCursor
	callWorkflowHistory(t, testHandler.ListCockpitMinutesVersionHistory, "GET", ws, meeting.ID, "/versions?page_size=25&cursor="+url.QueryEscape(cursor), nil).Want(200).JSON(&page)
	if len(page.Items) != 3 || page.Items[2].ID != firstID || page.NextCursor != nil {
		t.Fatalf("history continuation: %+v", page)
	}
	callWorkflowHistory(t, testHandler.ListCockpitMinutesVersionHistory, "GET", ws, meeting.ID, "/versions?page_size=10&cursor="+url.QueryEscape(cursor), nil).Want(400)
	callWorkflowHistory(t, testHandler.ListCockpitReviewerHandoffHistory, "GET", ws, meeting.ID, "/handoffs?page_size=25&cursor="+url.QueryEscape(cursor), nil).Want(400)
	var detail CockpitMinutesVersionDetail
	callWorkflowHistory(t, testHandler.GetCockpitMinutesVersionDetail, "GET", ws, meeting.ID, "/version", nil, "versionId", firstID).Want(200).JSON(&detail)
	if detail.Version.Content != first["content"] || detail.CanReview || detail.CanPublish || detail.WorkspaceID != ws || detail.MeetingID != meeting.ID {
		t.Fatal("historical body scope/authority changed")
	}
	var legacy CockpitMeetingWorkflowResponse
	callWorkflowHistory(t, testHandler.GetCockpitMeetingWorkflow, "GET", ws, meeting.ID, "/workflow", nil).Want(200).JSON(&legacy)
	if len(legacy.Versions) != 28 || legacy.Versions[27].Content != first["content"] {
		t.Fatal("default legacy response was silently truncated")
	}
}
func TestCockpitHistoryHandoffReceiptsAndRequiredRoles(t *testing.T) {
	ws, meeting, state := initializeCompactWorkflow(t)
	callWorkflowHistory(t, testHandler.SubmitCockpitMeetingMinutes, "POST", ws, meeting.ID, "/versions?response=compact", map[string]any{"expected_revision": state.Workflow.Revision, "submission_key": uuid.NewString(), "content": "Fixed reviewer evidence"}).Want(200).JSON(&state)
	originalIssue := state.Receipt.Version.ReviewIssue.ID
	version := state.Receipt.Version.ID
	other := dbfx.User(t, "History reviewer", "history-"+uuid.NewString()+"@test.example")
	dbfx.Member(t, ws, other, "member")
	var first map[string]any
	var firstHandoffID string
	for i := 0; i < 27; i++ {
		target := other
		if i%2 == 1 {
			target = testUserID
		}
		command := map[string]any{"expected_revision": state.Workflow.Revision, "handoff_key": uuid.NewString(), "reviewer_id": target, "reason": fmt.Sprintf("Transfer %d", i)}
		callWorkflowHistory(t, testHandler.ChangeCockpitMeetingReviewer, "POST", ws, meeting.ID, "/reviewer?response=compact", command).Want(200).JSON(&state)
		if state.Receipt.Handoff == nil || state.Receipt.Handoff.VersionNumber == nil || *state.Receipt.Handoff.VersionNumber != 1 {
			t.Fatal("handoff receipt metadata missing")
		}
		if i == 0 {
			first = command
			firstHandoffID = state.Receipt.Handoff.ID
		}
	}
	callWorkflowHistory(t, testHandler.ChangeCockpitMeetingReviewer, "POST", ws, meeting.ID, "/reviewer?response=compact", first).Want(200).JSON(&state)
	if state.Receipt.Handoff.ID != firstHandoffID || state.Workflow.HistoryCounts.ReviewerHandoffs != 27 || state.Receipt.Version.ID != version {
		t.Fatal("old handoff replay lost its receipt")
	}
	var page CockpitReviewerHandoffPage
	callWorkflowHistory(t, testHandler.ListCockpitReviewerHandoffHistory, "GET", ws, meeting.ID, "/handoffs?page_size=25", nil).Want(200).JSON(&page)
	if len(page.Items) != 25 || page.NextCursor == nil || page.Total != 27 {
		t.Fatalf("handoff page: %+v", page)
	}
	callWorkflowHistory(t, testHandler.ListCockpitReviewerHandoffHistory, "GET", ws, meeting.ID, "/handoffs?page_size=25&cursor="+url.QueryEscape(*page.NextCursor), nil).Want(200).JSON(&page)
	if len(page.Items) != 2 || page.Items[1].ID != firstHandoffID || page.Items[1].ToReviewerName != "History reviewer" {
		t.Fatal("historical handoff display/ordering lost")
	}
	found := false
	for _, link := range getBoard(t, ws).MeetingIssues {
		if link.IssueID == originalIssue {
			found = true
			if len(link.RequiredRoles) != 1 || link.RequiredRoles[0] != "review" {
				t.Fatalf("retired review lost mandatory purpose: %+v", link)
			}
		}
	}
	if !found {
		t.Fatal("retired review link missing")
	}
	setMeetingRoles(t, ws, meeting.ID, originalIssue, map[string]any{"roles": []string{"reference"}}).Want(409)
}
func TestCockpitHistoryNASPinAndFilteredMetadata(t *testing.T) {
	ws, meeting, _, rootID, directory, legacy := nasHTTPFixture(t)
	version := legacy.Versions[0].ID
	var state CockpitWorkflowCompactResponse
	callWorkflowHistory(t, testHandler.PublishCockpitMeetingMinutes, "POST", ws, meeting.ID, "/publish?response=compact", map[string]any{"expected_revision": legacy.Revision, "nas_export": map[string]any{"root_id": rootID, "directory": directory}}, "versionId", version).Want(200).JSON(&state)
	if state.Receipt.NASExport == nil || state.Workflow.PublishedNASExport == nil || state.Workflow.PublishedNASExport.ID != state.Receipt.NASExport.ID || state.Workflow.HistoryCounts.NASActive != 1 {
		t.Fatalf("published destination pin missing: %+v", state)
	}
	job := *state.Receipt.NASExport
	dbfx.Exec(t, "UPDATE cockpit_minutes_export SET status='needs_attention',revision=revision+1,last_error_code='offline' WHERE id=$1", job.ID)
	callWorkflowHistory(t, testHandler.RetryCockpitMinutesExport, "POST", ws, meeting.ID, "/retry?response=compact", map[string]any{"expected_revision": job.Revision + 1}, "exportId", job.ID).Want(200).JSON(&state)
	if state.Receipt.NASExport == nil || state.Receipt.NASExport.ID != job.ID || state.Receipt.NASExport.Status != "queued" || state.Receipt.NASExport.SourceVersion.ContentHash != job.ContentHash {
		t.Fatal("export retry source receipt missing")
	}
	// Historical destinations can outnumber a page. The configured destination
	// must still pin its original job, not whichever export is newest.
	for i := 0; i < 26; i++ {
		root := filepath.Dir(directory)
		archived := filepath.Join(root, fmt.Sprintf("archive-%d", i))
		relative := filepath.Join(fmt.Sprintf("archive-%d", i), "已发布纪要", "minutes-v0001-"+version+".md")
		dbfx.Insert(t, "cockpit_minutes_export", testutil.Cols{
			"id": uuid.NewString(), "workspace_id": ws, "meeting_id": meeting.ID, "version_id": version, "version_number": 1,
			"source_issue_id": job.SourceIssueID, "root_id": rootID, "root_path": root, "directory": archived, "relative_path": relative,
			"target_path": filepath.Join(root, relative), "content_hash": job.ContentHash, "created_by": testUserID, "status": "needs_attention",
		})
	}
	var summary CockpitWorkflowSummaryResponse
	callWorkflowHistory(t, testHandler.GetCockpitWorkflowSummary, "GET", ws, meeting.ID, "/summary", nil).Want(200).JSON(&summary)
	if summary.HistoryCounts.NASExports != 27 || summary.HistoryCounts.NASActive != 1 || summary.PublishedNASExport == nil || summary.PublishedNASExport.ID != job.ID {
		t.Fatalf("summary confused a newer historical destination with its pinned export: %+v", summary.HistoryCounts)
	}
	var all CockpitNASExportPage
	callWorkflowHistory(t, testHandler.ListCockpitNASExportHistory, "GET", ws, meeting.ID, "/exports?page_size=25", nil).Want(200).JSON(&all)
	if all.Total != 27 || len(all.Items) != 25 || all.NextCursor == nil {
		t.Fatalf("NAS page is unbounded: %d/%d", len(all.Items), all.Total)
	}
	cursor := *all.NextCursor
	seen := map[string]bool{}
	for _, entry := range all.Items {
		seen[entry.ID] = true
	}
	callWorkflowHistory(t, testHandler.ListCockpitNASExportHistory, "GET", ws, meeting.ID, "/exports?page_size=25&cursor="+url.QueryEscape(cursor), nil).Want(200).JSON(&all)
	for _, entry := range all.Items {
		if seen[entry.ID] {
			t.Fatal("NAS cursor repeated an operation")
		}
		seen[entry.ID] = true
	}
	if len(all.Items) != 2 || len(seen) != 27 || !seen[job.ID] || all.NextCursor != nil {
		t.Fatal("NAS history continuation lost records")
	}
	callWorkflowHistory(t, testHandler.ListCockpitNASExportHistory, "GET", ws, meeting.ID, "/exports?page_size=25&status=active&cursor="+url.QueryEscape(cursor), nil).Want(400)
	var page CockpitNASExportPage
	result := callWorkflowHistory(t, testHandler.ListCockpitNASExportHistory, "GET", ws, meeting.ID, "/exports?version_id="+version+"&status=active&page_size=1", nil).Want(200).JSON(&page)
	if page.Total != 1 || len(page.Items) != 1 || page.Items[0].SourceVersion.ID != version || strings.Contains(result.Text(), `"content":`) || page.Status != "active" || page.VersionID == nil {
		t.Fatalf("filtered NAS source metadata: %s", result.Text())
	}
	callWorkflowHistory(t, testHandler.ListCockpitNASExportHistory, "GET", ws, meeting.ID, "/exports?version_id="+uuid.NewString(), nil).Want(404)
	callWorkflowHistory(t, testHandler.ListCockpitNASExportHistory, "GET", ws, meeting.ID, "/exports?status=imaginary", nil).Want(400)
}
func TestCockpitHistoryScopeAndInvalidRepresentationDoNotWrite(t *testing.T) {
	ws, meeting := newCockpitWorkflowHTTPFixture(t)
	var summary CockpitWorkflowSummaryResponse
	callWorkflowHistory(t, testHandler.GetCockpitWorkflowSummary, "GET", ws, meeting.ID, "/summary", nil).Want(200).JSON(&summary)
	if summary.Enabled || summary.CurrentVersion != nil || summary.HistoryCounts.Versions != 0 {
		t.Fatal("empty summary invented workflow")
	}
	callWorkflowHistory(t, testHandler.EnableCockpitMeetingWorkflow, "POST", ws, meeting.ID, "/workflow?response=unexpected", map[string]any{"reviewer_id": testUserID}).Want(400)
	if dbfx.Count(t, "SELECT count(*) FROM cockpit_meeting_issue WHERE workspace_id=$1 AND 'minutes'=ANY(roles)", ws) != 0 || dbfx.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", ws) != 0 {
		t.Fatal("invalid response mode still performed business command")
	}
	callWorkflowHistory(t, testHandler.ListCockpitMinutesVersionHistory, "GET", ws, meeting.ID, "/versions?page_size=101", nil).Want(400)
	foreign := cockpitFixture(t, "Other history workspace")
	callWorkflowHistory(t, testHandler.GetCockpitWorkflowSummary, "GET", foreign, meeting.ID, "/summary", nil).Want(404)
	if dbfx.Count(t, "SELECT count(*) FROM cockpit WHERE workspace_id=$1", foreign) != 0 {
		t.Fatal("focused read created a board")
	}
	callWorkflowHistory(t, testHandler.GetCockpitMinutesVersionDetail, "GET", ws, meeting.ID, "/version", nil, "versionId", uuid.NewString()).Want(404)
}
