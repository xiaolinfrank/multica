package handler

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

type artifactHTTPFixture struct {
	h                                 *Handler
	ws, node, source, project, module string
}

func newArtifactHTTPFixture(t *testing.T) artifactHTTPFixture {
	t.Helper()
	ws := cockpitMeetingFixture(t, "Artifact HTTP")
	project := dbfx.Project(t, "Delivery", testutil.Cols{"workspace_id": ws})
	module := dbfx.Module(t, project, "Implementation", testutil.Cols{"workspace_id": ws})
	root := createNode(t, ws, map[string]any{"code": "artifact-project", "name": "Project", "project_id": project})
	group := createNode(t, ws, map[string]any{"code": "artifact-module", "name": "Module", "parent_id": root.ID, "module_id": module})
	node := createNode(t, ws, map[string]any{"code": "artifact-delivery", "name": "Deliver interface", "parent_id": group.ID})
	source := dbfx.Issue(t, "Produce report", testutil.Cols{"workspace_id": ws, "project_id": project, "module_id": module, "creator_id": testUserID, "assignee_type": "member", "assignee_id": testUserID})
	// Fixture inserts bypass canonical numbering; subsequent HTTP commands do not.
	dbfx.Exec(t, "UPDATE workspace SET issue_counter=(SELECT COALESCE(MAX(number),0) FROM issue WHERE workspace_id=$1) WHERE id=$1", ws)
	t.Cleanup(func() {
		for _, table := range []string{"cockpit_acceptance_reviewer_handoff", "cockpit_acceptance_evidence", "cockpit_acceptance_request_criterion", "cockpit_acceptance_request", "cockpit_acceptance_criterion", "cockpit_acceptance_definition", "cockpit_artifact_meeting_reference", "cockpit_artifact_node_reference", "cockpit_artifact_producer_assignment", "cockpit_artifact_reviewer_handoff", "cockpit_artifact_capture_attempt", "cockpit_artifact_capture", "cockpit_artifact_version", "cockpit_artifact", "cockpit_issue_primary", "cockpit_node_issue"} {
			dbfx.Exec(t, "DELETE FROM "+table+" WHERE workspace_id=$1", ws)
		}
		for _, table := range []string{"activity_log", "issue_subscriber", "inbox_item"} {
			dbfx.Exec(t, "DELETE FROM "+table+" WHERE issue_id IN (SELECT id FROM issue WHERE workspace_id=$1)", ws)
		}
		dbfx.Exec(t, "DELETE FROM issue WHERE workspace_id=$1", ws)
	})
	h := *testHandler
	svc := *testHandler.IssueService
	svc.CockpitArtifactBackendReady = true
	h.IssueService = &svc
	return artifactHTTPFixture{&h, ws, node.ID, source, project, module}
}

func (f artifactHTTPFixture) call(t *testing.T, fn http.HandlerFunc, method, path string, body any, params ...string) *testutil.Response {
	t.Helper()
	return testutil.Call(t, cockpitHandler(fn), testutil.WithURLParams(cockpitRequest(method, path, f.ws, body), params...))
}
func (f artifactHTTPFixture) create(t *testing.T) service.CockpitArtifactHeader {
	t.Helper()
	var artifact service.CockpitArtifactHeader
	f.call(t, f.h.CreateCockpitArtifact, "POST", "/artifacts", map[string]any{"creation_key": uuid.NewString(), "node_id": f.node, "source_issue_id": f.source, "reviewer_id": testUserID, "title": "Fixed delivery report", "description": ""}).Want(200).JSON(&artifact)
	return artifact
}
func (f artifactHTTPFixture) submit(t *testing.T, artifact service.CockpitArtifactHeader) service.CockpitArtifactVersionCommandResponse {
	t.Helper()
	var receipt service.CockpitArtifactVersionCommandResponse
	f.call(t, f.h.SubmitCockpitArtifactVersion, "POST", "/versions", map[string]any{"expected_revision": artifact.Revision, "submission_key": uuid.NewString(), "producer_issue_id": artifact.ProducerIssue.ID, "payload": map[string]any{"kind": "text", "content": "# Report\r\nFixed bytes  \n"}}, "artifactId", artifact.ID).Want(200).JSON(&receipt)
	return receipt
}

func TestCockpitArtifactHTTPFixedReviewAndStrictIdentity(t *testing.T) {
	f := newArtifactHTTPFixture(t)
	artifact := f.create(t)
	for _, body := range []map[string]any{
		{"expected_revision": artifact.Revision, "submission_key": uuid.NewString(), "payload": map[string]any{"kind": "text", "content": "Report"}},
		{"expected_revision": artifact.Revision, "submission_key": uuid.NewString(), "producer_issue_id": f.source, "producer_run_id": uuid.NewString(), "payload": map[string]any{"kind": "text", "content": "Report"}},
	} {
		f.call(t, f.h.SubmitCockpitArtifactVersion, "POST", "/versions", body, "artifactId", artifact.ID).Want(400)
	}
	if got := dbfx.Count(t, "SELECT count(*) FROM cockpit_artifact_version WHERE workspace_id=$1", f.ws); got != 0 {
		t.Fatalf("invalid command wrote %d versions", got)
	}
	receipt := f.submit(t, artifact)
	v := receipt.Version.Version
	if receipt.Version.Content == nil || *receipt.Version.Content != "# Report\r\nFixed bytes  \n" || v.ReviewIssue == nil || v.Decision != "pending" || !receipt.Version.ContentAvailable {
		t.Fatalf("fixed review incomplete: %+v", receipt)
	}
	if got := dbfx.Count(t, "SELECT count(*) FROM cockpit_issue_primary WHERE workspace_id=$1 AND issue_id=$2 AND node_id=$3", f.ws, v.ReviewIssue.ID, f.node); got != 1 {
		t.Fatal("formal review missing its primary L3")
	}
	f.call(t, f.h.ReviewCockpitArtifactVersion, "POST", "/review", map[string]any{"expected_revision": v.Revision, "decision": "changes_requested", "feedback": "Clarify the boundary"}, "artifactId", artifact.ID, "versionId", v.ID).Want(200).JSON(&receipt)
	if receipt.Version.Version.Decision != "changes_requested" || receipt.Version.Feedback != "Clarify the boundary" || receipt.Version.Version.ReviewIssue.Status != "done" {
		t.Fatalf("formal return not reflected: %+v", receipt.Version)
	}
	next := f.submit(t, receipt.Artifact)
	if next.Version.Version.ID == v.ID || next.Version.Version.VersionNumber != 2 {
		t.Fatalf("revision did not create a new fixed version: %+v", next.Version)
	}
	var old service.CockpitArtifactVersionDetail
	f.call(t, f.h.GetCockpitArtifactVersion, "GET", "/version", nil, "artifactId", artifact.ID, "versionId", v.ID).Want(200).JSON(&old)
	if old.Version.Decision != "changes_requested" || old.Feedback != "Clarify the boundary" {
		t.Fatal("later submission rewrote a past formal decision")
	}
}

func TestCockpitArtifactHTTPProducerReplayPreservesOrigin(t *testing.T) {
	f := newArtifactHTTPFixture(t)
	a := f.create(t)
	body := map[string]any{"expected_revision": a.Revision, "command_key": uuid.NewString(), "reason": "Revision round", "new_issue": map[string]any{"title": "Revise report", "description": "Apply feedback"}}
	var first, replay service.CockpitArtifactProducerResponse
	f.call(t, f.h.AssignCockpitArtifactProducer, "POST", "/producer", body, "artifactId", a.ID).Want(200).JSON(&first)
	if first.Artifact.SourceIssue.ID != f.source || first.ToIssue.ID == f.source || first.ToIssue.Status != "backlog" || first.Assignment.ToIssueID != first.ToIssue.ID {
		t.Fatalf("new producer changed origin or dispatched: %+v", first)
	}
	other := dbfx.Issue(t, "Later producer", testutil.Cols{"workspace_id": f.ws, "project_id": f.project, "module_id": f.module})
	dbfx.Exec(t, "UPDATE workspace SET issue_counter=(SELECT COALESCE(MAX(number),0) FROM issue WHERE workspace_id=$1) WHERE id=$1", f.ws)
	f.call(t, f.h.AssignCockpitArtifactProducer, "POST", "/producer", map[string]any{"expected_revision": first.Artifact.Revision, "command_key": uuid.NewString(), "reason": "Another round", "issue_id": other}, "artifactId", a.ID).Want(200)
	f.call(t, f.h.AssignCockpitArtifactProducer, "POST", "/producer", body, "artifactId", a.ID).Want(200).JSON(&replay)
	if replay.Assignment.ID != first.Assignment.ID || replay.ToIssue.ID != first.ToIssue.ID || replay.Artifact.ProducerIssue.ID != other {
		t.Fatalf("historical receipt followed mutable producer: %+v", replay)
	}
	if got := dbfx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", first.ToIssue.ID); got != 0 {
		t.Fatalf("producer assignment dispatched %d agent runs", got)
	}
}

func TestCockpitArtifactHTTPMeetingReferencesStayFixed(t *testing.T) {
	f := newArtifactHTTPFixture(t)
	a := f.create(t)
	v := f.submit(t, a)
	meeting := createMeeting(t, f.ws, map[string]any{"title": "Review evidence", "meet_date": "2026-10-11"})
	body := map[string]any{"reference_key": uuid.NewString(), "version_id": v.Version.Version.ID, "meeting_id": meeting.ID, "purpose": "input"}
	var reference service.CockpitArtifactReferenceResponse
	f.call(t, f.h.CreateCockpitArtifactMeetingReference, "POST", "/reference", body, "artifactId", a.ID).Want(200).JSON(&reference)
	var page service.CockpitMeetingArtifactReferencesPage
	f.call(t, f.h.ListCockpitMeetingArtifactReferences, "GET", "/references?page_size=25", nil, "meetingId", meeting.ID).Want(200).JSON(&page)
	if page.Total != 1 || page.Items[0].VersionID != v.Version.Version.ID || page.Items[0].ArtifactTitle != a.Title {
		t.Fatalf("meeting did not expose the fixed version: %+v", page)
	}
	body["reference_key"] = uuid.NewString()
	var conflict map[string]any
	f.call(t, f.h.CreateCockpitArtifactMeetingReference, "POST", "/reference", body, "artifactId", a.ID).Want(409).JSON(&conflict)
	if conflict["code"] != "reference_exists" || conflict["existing_reference_id"] != reference.Reference.ID {
		t.Fatalf("duplicate did not identify existing reference: %+v", conflict)
	}
	f.call(t, f.h.RemoveCockpitArtifactMeetingReference, "DELETE", "/reference", nil, "artifactId", a.ID, "referenceId", reference.Reference.ID).Want(200)
	f.call(t, f.h.ListCockpitMeetingArtifactReferences, "GET", "/references", nil, "meetingId", meeting.ID).Want(200).JSON(&page)
	if page.Total != 0 {
		t.Fatal("removed reference remains active material")
	}
	f.call(t, f.h.ListCockpitMeetingArtifactReferences, "GET", "/references?include_removed=true", nil, "meetingId", meeting.ID).Want(200).JSON(&page)
	if page.Total != 1 || page.Items[0].RemovedAt == nil {
		t.Fatal("removal erased reference history")
	}
}

func TestCockpitArtifactHTTPAcceptanceKeepsFixedEvidenceAndHumanAuthority(t *testing.T) {
	f := newArtifactHTTPFixture(t)
	a := f.create(t)
	v := f.submit(t, a)
	f.call(t, f.h.ReviewCockpitArtifactVersion, "POST", "/review", map[string]any{"expected_revision": v.Version.Version.Revision, "decision": "approved", "feedback": ""}, "artifactId", a.ID, "versionId", v.Version.Version.ID).Want(200).JSON(&v)
	criterionID := uuid.NewString()
	var criteria service.CockpitAcceptanceCriteriaView
	f.call(t, f.h.SaveCockpitAcceptanceCriteria, "PUT", "/criteria", map[string]any{"expected_revision": 0, "criteria": []map[string]any{{"id": criterionID, "title": "Scope is verified", "description": "Use the reviewed report"}}}, "id", f.node).Want(200).JSON(&criteria)
	body := map[string]any{"request_key": uuid.NewString(), "expected_criteria_revision": criteria.Revision, "reviewer_id": testUserID, "evidence": []map[string]any{{"criterion_id": criterionID, "version_ids": []string{v.Version.Version.ID}}}, "note": "Please accept the fixed report"}
	var acceptance service.CockpitAcceptanceRequestDetail
	f.call(t, f.h.CreateCockpitAcceptanceRequest, "POST", "/acceptance", body, "id", f.node).Want(200).JSON(&acceptance)
	if acceptance.Request.ReviewIssue.ID == "" || acceptance.Request.Decision != "pending" || len(acceptance.Evidence) != 1 || acceptance.Evidence[0].Versions[0].ID != v.Version.Version.ID {
		t.Fatalf("acceptance did not freeze exact evidence: %+v", acceptance)
	}
	machine := testutil.WithURLParams(cockpitRequest("POST", "/acceptance/review", f.ws, map[string]any{"expected_revision": acceptance.Request.Revision, "decision": "approved", "feedback": ""}), "id", f.node, "requestId", acceptance.Request.ID)
	machine.Header.Set("X-Actor-Source", "task_token")
	machine.Header.Set("X-Agent-ID", uuid.NewString())
	machine.Header.Set("X-Task-ID", uuid.NewString())
	testutil.Call(t, cockpitHandler(f.h.ReviewCockpitAcceptanceRequest), machine).Want(403)
	f.call(t, f.h.ReviewCockpitAcceptanceRequest, "POST", "/acceptance/review", map[string]any{"expected_revision": acceptance.Request.Revision, "decision": "approved", "feedback": ""}, "id", f.node, "requestId", acceptance.Request.ID).Want(200).JSON(&acceptance)
	if acceptance.Request.Decision != "approved" {
		t.Fatal("designated human could not accept fixed evidence")
	}
	var reverse service.CockpitIssueArtifactContextPage
	f.call(t, f.h.ListCockpitIssueArtifactContexts, "GET", "/issue/artifacts", nil, "issueId", acceptance.Request.ReviewIssue.ID).Want(200).JSON(&reverse)
	if reverse.Total != 1 || reverse.Items[0].RequestID == nil || *reverse.Items[0].RequestID != acceptance.Request.ID || reverse.Items[0].IsCurrentReview {
		t.Fatalf("completed review reverse context lost exact request: %+v", reverse)
	}
}

func TestCockpitArtifactHTTPUnavailableBackendDoesNotInitializeData(t *testing.T) {
	ws := cockpitMeetingFixture(t, "Artifacts not initialized")
	h := *testHandler
	svc := *testHandler.IssueService
	svc.CockpitArtifactBackendReady = false
	h.IssueService = &svc
	testutil.Call(t, cockpitHandler(h.ListCockpitArtifacts), cockpitRequest("GET", "/artifacts", ws, nil)).Want(503)
	if count := dbfx.Count(t, "SELECT count(*) FROM cockpit WHERE workspace_id=$1", ws); count != 0 {
		t.Fatal("unavailable artifact read initialized a cockpit")
	}
}
