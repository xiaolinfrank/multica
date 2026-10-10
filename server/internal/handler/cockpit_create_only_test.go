package handler

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/cockpitnas"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestCockpitCreateOnlyHTTPExplicitModeAndVerifiedCompactReceipt(t *testing.T) {
	ws, meeting, files, rootID, directory, state := nasHTTPFixture(t, cockpitnas.ModeCreateOnly)
	version := state.Versions[0]
	if state.NASDestination == nil || state.NASDestination.WriteMode != cockpitnas.ModeCreateOnly {
		t.Fatal("preview did not disclose the configured mode")
	}
	for _, mode := range []string{"", "atomic", "unknown"} {
		target := map[string]any{"root_id": rootID, "directory": directory}
		if mode != "" {
			target["write_mode"] = mode
		}
		callCockpitWorkflow(t, testHandler.PublishCockpitMeetingMinutes, "POST", ws, meeting.ID, "", version.ID,
			map[string]any{"expected_revision": state.Revision, "nas_export": target}).Want(400)
	}
	if dbfx.Count(t, "SELECT count(*) FROM cockpit_minutes_export WHERE workspace_id=$1", ws) != 0 {
		t.Fatal("invalid mode left an export intent")
	}
	var compact CockpitWorkflowCompactResponse
	callWorkflowHistory(t, testHandler.PublishCockpitMeetingMinutes, "POST", ws, meeting.ID, "/publish?response=compact",
		map[string]any{"expected_revision": state.Revision, "nas_export": map[string]any{"root_id": rootID, "directory": directory, "write_mode": "create_only"}}, "versionId", version.ID).Want(200).JSON(&compact)
	job := compact.Receipt.NASExport
	if job == nil || job.WriteMode != "create_only" || job.VerifiedPath != nil || job.Status != "queued" {
		t.Fatalf("incorrect compact acknowledgement: %+v", compact.Receipt)
	}
	worker := service.NewCockpitMinutesExportWorker(testHandler.Queries, files, nil)
	if worked, err := worker.ProcessNext(context.Background()); err != nil || !worked {
		t.Fatalf("worker: %t %v", worked, err)
	}
	var summary CockpitWorkflowSummaryResponse
	callWorkflowHistory(t, testHandler.GetCockpitWorkflowSummary, "GET", ws, meeting.ID, "/summary", nil).Want(200).JSON(&summary)
	copy := summary.PublishedNASExport
	if copy == nil || copy.ID != job.ID || copy.Status != "succeeded" || copy.VerifiedPath == nil || copy.ReceiptPath == nil || copy.ReceiptHash == nil || copy.VerifiedAttemptID == nil || *copy.VerifiedPath == copy.TargetPath {
		t.Fatalf("unverified path was exposed as a completed copy: %+v", copy)
	}
	content, err := os.ReadFile(*copy.VerifiedPath)
	if err != nil || string(content) != version.Content {
		t.Fatalf("wrong fixed bytes: %v", err)
	}
	receipt, err := os.ReadFile(*copy.ReceiptPath)
	if err != nil || fmt.Sprintf("%x", sha256.Sum256(receipt)) != *copy.ReceiptHash {
		t.Fatalf("missing completion record: %v", err)
	}
	var attempts service.CockpitMinutesExportAttemptPage
	callWorkflowHistory(t, testHandler.ListCockpitNASExportAttempts, "GET", ws, meeting.ID, "/attempts", nil, "exportId", job.ID).Want(200).JSON(&attempts)
	if attempts.WorkspaceID != ws || attempts.ExportID != job.ID || attempts.Total != 1 || attempts.Items[0].ID != *copy.VerifiedAttemptID || attempts.Items[0].Status != "verified" {
		t.Fatalf("attempt context was lost: %+v", attempts)
	}
	testutil.Call(t, testHandler.DeleteWorkspace, testutil.WithURLParams(cockpitRequest(http.MethodDelete, "/workspace", ws, nil), "id", ws)).Want(204)
	if dbfx.Count(t, "SELECT count(*) FROM cockpit_minutes_export_attempt WHERE workspace_id=$1", ws) != 0 {
		t.Fatal("attempts outlived workspace deletion")
	}
	if _, err := os.Stat(*copy.VerifiedPath); err != nil {
		t.Fatal("workspace deletion removed an external copy")
	}
}

func TestCockpitCreateOnlyHTTPAttemptPagesDoNotReadBodiesOrOtherScopes(t *testing.T) {
	ws, meeting, _, rootID, directory, state := nasHTTPFixture(t, cockpitnas.ModeCreateOnly)
	version := state.Versions[0]
	callCockpitWorkflow(t, testHandler.PublishCockpitMeetingMinutes, "POST", ws, meeting.ID, "", version.ID,
		map[string]any{"expected_revision": state.Revision, "nas_export": map[string]any{"root_id": rootID, "directory": directory, "write_mode": "create_only"}}).Want(200).JSON(&state)
	job := state.NASExports[0]
	for number := 1; number <= 31; number++ {
		dbfx.Insert(t, "cockpit_minutes_export_attempt", testutil.Cols{"id": uuid.NewString(), "workspace_id": ws, "meeting_id": meeting.ID, "export_id": job.ID,
			"attempt_number": number, "target_path": fmt.Sprintf("/fixture/%d/minutes.md", number), "receipt_path": fmt.Sprintf("/fixture/%d/complete.json", number), "content_hash": version.ContentHash})
	}
	var page service.CockpitMinutesExportAttemptPage
	response := callWorkflowHistory(t, testHandler.ListCockpitNASExportAttempts, "GET", ws, meeting.ID, "/attempts?page_size=25", nil, "exportId", job.ID).Want(200).JSON(&page)
	if strings.Contains(response.Text(), `"content":`) {
		t.Fatal("attempt history included minutes bodies")
	}
	if len(page.Items) != 25 || page.Total != 31 || page.NextCursor == nil || page.Items[0].AttemptNumber != 31 {
		t.Fatalf("unbounded attempt history: %+v", page)
	}
	cursor := *page.NextCursor
	callWorkflowHistory(t, testHandler.ListCockpitNASExportAttempts, "GET", ws, meeting.ID, "/attempts?page_size=25&cursor="+url.QueryEscape(cursor), nil, "exportId", job.ID).Want(200).JSON(&page)
	if len(page.Items) != 6 || page.Items[0].AttemptNumber != 6 || page.NextCursor != nil {
		t.Fatal("history continuation skipped or duplicated attempts")
	}
	callWorkflowHistory(t, testHandler.ListCockpitNASExportAttempts, "GET", ws, meeting.ID, "/attempts?page_size=1&cursor="+url.QueryEscape(cursor), nil, "exportId", job.ID).Want(400)
	callWorkflowHistory(t, testHandler.ListCockpitNASExportAttempts, "GET", ws, meeting.ID, "/attempts?page_size=101", nil, "exportId", job.ID).Want(400)
	callWorkflowHistory(t, testHandler.ListCockpitNASExportAttempts, "GET", ws, meeting.ID, "/attempts", nil, "exportId", "invalid").Want(400)
	callWorkflowHistory(t, testHandler.ListCockpitNASExportAttempts, "GET", ws, meeting.ID, "/attempts", nil, "exportId", uuid.NewString()).Want(404)
	foreign := cockpitFixture(t, "Other NAS attempt scope")
	callWorkflowHistory(t, testHandler.ListCockpitNASExportAttempts, "GET", foreign, meeting.ID, "/attempts", nil, "exportId", job.ID).Want(404)
}
