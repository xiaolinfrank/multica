package service

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"sync"
	"testing"
)

type artifactFixture struct {
	planningFixture
	artifact, producer pgtype.UUID
}

func newArtifactFixture(t *testing.T) artifactFixture {
	t.Helper()
	f := newPlanningFixture(t)
	ctx := context.Background()
	f.Cleanup(t, "DELETE FROM activity_log WHERE workspace_id=$1", f.ws)
	// Domain relations disappear before testutil removes their protected Issues
	// and nodes. Production retains object intents for the cleanup worker.
	t.Cleanup(func() {
		if err := f.q.DeleteCockpitArtifactsByWorkspace(ctx, f.ws); err != nil {
			t.Errorf("artifact domain cleanup: %v", err)
		}
		if _, err := f.Pool.Exec(ctx, "DELETE FROM cockpit_artifact_capture_attempt WHERE workspace_id=$1", f.ws); err != nil {
			t.Errorf("artifact object fixture cleanup: %v", err)
		}
	})
	task, err := f.issues.CreateCockpitNodeTask(ctx, f.createInput("Produce the source deliverable"), IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	id, err := f.issues.CreateCockpitArtifact(ctx, CockpitArtifactCreate{WorkspaceID: f.ws, ActorID: f.owner, NodeID: f.a, SourceIssueID: task.Issue.ID, ReviewerID: f.owner, CreationKey: dbid.NewV7(), Title: "Research deliverable", Human: true})
	if err != nil {
		t.Fatal(err)
	}
	return artifactFixture{planningFixture: f, artifact: id, producer: task.Issue.ID}
}
func (f artifactFixture) artifactHeader(t *testing.T) CockpitArtifactHeader {
	t.Helper()
	h, err := f.issues.GetCockpitArtifact(context.Background(), CockpitArtifactRead{WorkspaceID: f.ws, ActorID: f.owner, ArtifactID: f.artifact, Human: true})
	if err != nil {
		t.Fatal(err)
	}
	return h
}
func (f artifactFixture) submission(t *testing.T, text string) CockpitArtifactSubmission {
	t.Helper()
	return CockpitArtifactSubmission{CockpitArtifactCommand: CockpitArtifactCommand{WorkspaceID: f.ws, ActorID: f.owner, ArtifactID: f.artifact, Human: true, ExpectedRevision: f.artifactHeader(t).Revision}, SubmissionKey: dbid.NewV7(), ProducerIssueID: f.producer, ActorType: "member", AuthorID: f.owner, Payload: CockpitArtifactPayload{Kind: "text", Content: &text}}
}
func (f artifactFixture) review(t *testing.T, id pgtype.UUID, decision string) {
	t.Helper()
	v, err := f.q.GetCockpitArtifactVersion(context.Background(), db.GetCockpitArtifactVersionParams{WorkspaceID: f.ws, ArtifactID: f.artifact, ID: id})
	if err != nil {
		t.Fatal(err)
	}
	feedback := ""
	if decision != "approved" {
		feedback = "Revise the evidence"
	}
	if err = f.issues.ReviewCockpitArtifactVersion(context.Background(), CockpitArtifactReview{CockpitArtifactCommand: CockpitArtifactCommand{WorkspaceID: f.ws, ActorID: f.owner, ArtifactID: f.artifact, Human: true, ExpectedRevision: v.Revision}, VersionID: id, Decision: decision, Feedback: feedback}); err != nil {
		t.Fatal(err)
	}
}
func TestCockpitArtifactRuntimeTextReviewIsAtomicAndImmutable(t *testing.T) {
	f := newArtifactFixture(t)
	ctx := context.Background()
	in := f.submission(t, "Evidence with a preserved final newline.\n")
	var wg sync.WaitGroup
	ids := make(chan pgtype.UUID, 3)
	errs := make(chan error, 3)
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id, e := f.issues.SubmitCockpitArtifactVersion(ctx, in, IssueCreateOpts{})
			ids <- id
			errs <- e
		}()
	}
	wg.Wait()
	close(ids)
	close(errs)
	for e := range errs {
		if e != nil {
			t.Fatal(e)
		}
	}
	var version pgtype.UUID
	for id := range ids {
		if version.Valid && version != id {
			t.Fatal("same submission produced multiple versions")
		}
		version = id
	}
	v, err := f.q.GetCockpitArtifactVersion(ctx, db.GetCockpitArtifactVersionParams{WorkspaceID: f.ws, ArtifactID: f.artifact, ID: version})
	if err != nil {
		t.Fatal(err)
	}
	if v.Content.String != *in.Payload.Content || v.ContentHash.String != minutesContentHash(*in.Payload.Content) || v.ProducerIssueID != f.producer {
		t.Fatal("fixed source bytes or producer identity changed")
	}
	issue, err := f.q.GetIssue(ctx, v.ReviewIssueID)
	if err != nil {
		t.Fatal(err)
	}
	if issue.AssigneeType.String != "member" || issue.AssigneeID != f.owner || issue.Status != "todo" || issue.ParentIssueID.Valid {
		t.Fatal("formal review task scope or responsibility is wrong")
	}
	primary, err := f.q.GetCockpitIssuePrimary(ctx, db.GetCockpitIssuePrimaryParams{WorkspaceID: f.ws, IssueID: issue.ID})
	if err != nil || primary.NodeID != f.a {
		t.Fatalf("formal review missing from L3 work: %+v %v", primary, err)
	}
	if _, err = f.q.UpdateIssueStatus(ctx, db.UpdateIssueStatusParams{WorkspaceID: f.ws, ID: issue.ID, Status: "done"}); err == nil {
		t.Fatal("ordinary done bypassed formal review")
	}
	if err = GuardCockpitIssueExecution(ctx, f.q, issue.ID); !errors.Is(err, ErrCockpitWorkflowExecutionBlocked) {
		t.Fatalf("formal human review entered execution: %v", err)
	}
	if count := f.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", issue.ID); count != 0 {
		t.Fatal("formal review dispatched Agent")
	}
	f.review(t, version, "approved")
	h := f.artifactHeader(t)
	if h.ApprovedVersion == nil || h.ApprovedVersion.ID != util.UUIDToString(version) || h.CurrentVersion.Decision != "approved" {
		t.Fatal("formal approval pin missing")
	}
	replay, err := f.issues.SubmitCockpitArtifactVersion(ctx, in, IssueCreateOpts{})
	if err != nil || replay != version {
		t.Fatalf("historical exact replay failed: %v", err)
	}
	changed := in
	other := "Different bytes"
	changed.Payload.Content = &other
	if _, err = f.issues.SubmitCockpitArtifactVersion(ctx, changed, IssueCreateOpts{}); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("key accepted changed content: %v", err)
	}
	detail, err := f.issues.GetCockpitArtifactVersion(ctx, CockpitArtifactRead{WorkspaceID: f.ws, ActorID: f.owner, ArtifactID: f.artifact, VersionID: version, Human: true})
	if err != nil || !detail.ContentAvailable || detail.Content == nil || *detail.Content != *in.Payload.Content {
		t.Fatalf("fixed text read failed: %+v %v", detail, err)
	}
}
func TestCockpitArtifactRuntimeProducerAndReferencesPreserveOrigins(t *testing.T) {
	f := newArtifactFixture(t)
	ctx := context.Background()
	v, err := f.issues.SubmitCockpitArtifactVersion(ctx, f.submission(t, "Version one"), IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	f.review(t, v, "approved")
	cmd := CockpitArtifactProducerCommand{CockpitArtifactCommand: CockpitArtifactCommand{WorkspaceID: f.ws, ActorID: f.owner, ArtifactID: f.artifact, Human: true, ExpectedRevision: f.artifactHeader(t).Revision}, CommandKey: dbid.NewV7(), Reason: "Revision responsibility", NewIssue: &IssueCreateParams{Title: "Produce revision"}}
	moved, err := f.issues.AssignCockpitArtifactProducer(ctx, cmd, IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if moved.Artifact.SourceIssue.ID != util.UUIDToString(f.producer) || moved.ToIssue.Status != "backlog" || moved.Assignment.ToIssueID == moved.Assignment.FromIssueID {
		t.Fatal("producer handover changed origin or dispatched work")
	}
	retry, err := f.issues.AssignCockpitArtifactProducer(ctx, cmd, IssueCreateOpts{})
	if err != nil || retry.Assignment.ID != moved.Assignment.ID {
		t.Fatalf("new producer task duplicated: %v", err)
	}
	refCmd := CockpitArtifactReferenceCommand{CockpitArtifactCommand: CockpitArtifactCommand{WorkspaceID: f.ws, ActorID: f.owner, ArtifactID: f.artifact, Human: true}, ReferenceKey: dbid.NewV7(), VersionID: v, NodeID: f.b, Purpose: "evidence"}
	ref, err := f.issues.CreateCockpitArtifactReference(ctx, refCmd, "node")
	if err != nil {
		t.Fatal(err)
	}
	page, err := f.issues.ListCockpitArtifacts(ctx, CockpitArtifactRead{WorkspaceID: f.ws, ActorID: f.owner, NodeID: f.b, Human: true, Relation: "all", IDs: []pgtype.UUID{f.artifact}})
	if err != nil || len(page.Items) != 1 || page.Items[0].EvidenceVersion == nil || page.Items[0].EvidenceVersion.ID != util.UUIDToString(v) {
		t.Fatalf("referenced current evidence missing: %+v %v", page, err)
	}
	duplicate := refCmd
	duplicate.ReferenceKey = dbid.NewV7()
	var exists *CockpitArtifactReferenceExistsError
	if _, err = f.issues.CreateCockpitArtifactReference(ctx, duplicate, "node"); !errors.As(err, &exists) || exists.ExistingReferenceID != ref.Reference.ID {
		t.Fatalf("natural duplicate lost command identity: %v", err)
	}
	refID, _ := util.ParseUUID(ref.Reference.ID)
	refCmd.ReferenceID = refID
	if _, err = f.issues.RemoveCockpitArtifactReference(ctx, refCmd, "node"); err != nil {
		t.Fatal(err)
	}
	again, err := f.issues.CreateCockpitArtifactReference(ctx, refCmd, "node")
	if err != nil || again.Reference.RemovedAt == nil {
		t.Fatalf("retry resurrected removed reference: %+v %v", again, err)
	}
	contexts, err := f.issues.ListCockpitIssueArtifactContexts(ctx, f.ws, f.producer, f.owner, "", 25)
	if err != nil || contexts.Total < 2 {
		t.Fatalf("origin/version producer contexts missing: %+v %v", contexts, err)
	}
}
func TestCockpitAcceptanceRuntimeEvidenceRevisionAndFormalDecision(t *testing.T) {
	f := newArtifactFixture(t)
	ctx := context.Background()
	version, err := f.issues.SubmitCockpitArtifactVersion(ctx, f.submission(t, "Acceptance evidence"), IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	f.review(t, version, "approved")
	criterion := util.UUIDToString(dbid.NewV7())
	criteria, err := f.issues.SaveCockpitAcceptanceCriteria(ctx, CockpitAcceptanceCriteriaCommand{WorkspaceID: f.ws, ActorID: f.owner, NodeID: f.a, Human: true, Criteria: []CockpitAcceptanceCriterionInput{{ID: criterion, Title: "Evidence is complete"}}})
	if err != nil {
		t.Fatal(err)
	}
	input := CockpitAcceptanceRequestCommand{WorkspaceID: f.ws, ActorID: f.owner, NodeID: f.a, Human: true, ReviewerID: f.owner, RequestKey: dbid.NewV7(), ExpectedCriteriaRevision: criteria.Revision, Evidence: []CockpitAcceptanceEvidenceInput{{CriterionID: criterion, VersionIDs: []string{util.UUIDToString(version)}}}}
	request, err := f.issues.CreateCockpitAcceptanceRequest(ctx, input, IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if !request.EvidenceAvailable || !request.Request.CanReview || len(request.Evidence) != 1 {
		t.Fatalf("fixed request not reviewable: %+v", request)
	}
	requestID, _ := util.ParseUUID(request.Request.ID)
	review := CockpitAcceptanceReview{WorkspaceID: f.ws, ActorID: f.owner, NodeID: f.a, RequestID: requestID, Human: true, ExpectedRevision: request.Request.Revision, Decision: "approved"}
	if err = f.issues.ReviewCockpitAcceptanceRequest(ctx, review); err != nil {
		t.Fatal(err)
	}
	header, err := f.issues.GetCockpitAcceptance(ctx, CockpitAcceptanceRead{WorkspaceID: f.ws, ActorID: f.owner, NodeID: f.a, Human: true})
	if err != nil || header.LastApprovedRequest == nil || header.NeedsReacceptance {
		t.Fatalf("acceptance not recorded: %+v %v", header, err)
	}
	second, err := f.issues.SubmitCockpitArtifactVersion(ctx, f.submission(t, "Revised acceptance evidence"), IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	f.review(t, second, "approved")
	header, err = f.issues.GetCockpitAcceptance(ctx, CockpitAcceptanceRead{WorkspaceID: f.ws, ActorID: f.owner, NodeID: f.a, Human: true})
	if err != nil || !header.NeedsReacceptance || header.LastApprovedRequest.ID != request.Request.ID {
		t.Fatalf("new evidence silently rewrote previous acceptance: %+v %v", header, err)
	}
	old, err := f.issues.GetCockpitAcceptanceRequest(ctx, CockpitAcceptanceRead{WorkspaceID: f.ws, ActorID: f.owner, NodeID: f.a, RequestID: requestID, Human: true})
	if err != nil || old.Request.Decision != "approved" || !old.EvidenceOutdated {
		t.Fatalf("historical decision was revoked or stale evidence hidden: %+v %v", old, err)
	}
}

func TestCockpitArtifactRuntimeReferencedEvidenceUsesTargetScope(t *testing.T) {
	f := newArtifactFixture(t)
	ctx := context.Background()
	version, err := f.issues.SubmitCockpitArtifactVersion(ctx, f.submission(t, "Cross-project evidence"), IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	f.review(t, version, "approved")
	project := parseTestUUID(t, f.Project(t, "Referenced project"))
	module := parseTestUUID(t, f.Module(t, util.UUIDToString(project), "Referenced module"))
	meeting, err := f.q.GetCockpitMeeting(ctx, db.GetCockpitMeetingParams{WorkspaceID: f.ws, ID: f.meeting})
	if err != nil {
		t.Fatal(err)
	}
	root := parseTestUUID(t, f.Insert(t, "cockpit_node", testutil.Cols{"workspace_id": f.ws, "cockpit_id": meeting.CockpitID, "code": "external-project", "name": "External project", "project_id": project}))
	mod := parseTestUUID(t, f.Insert(t, "cockpit_node", testutil.Cols{"workspace_id": f.ws, "cockpit_id": meeting.CockpitID, "code": "external-module", "name": "External module", "parent_id": root, "project_id": project, "module_id": module}))
	node := parseTestUUID(t, f.Insert(t, "cockpit_node", testutil.Cols{"workspace_id": f.ws, "cockpit_id": meeting.CockpitID, "code": "external-leaf", "name": "External delivery", "parent_id": mod}))
	// These later fixture nodes must outlive their explicit reference.
	f.Cleanup(t, "DELETE FROM cockpit_artifact_node_reference WHERE workspace_id=$1 AND node_id=$2", f.ws, node)
	_, err = f.issues.CreateCockpitArtifactReference(ctx, CockpitArtifactReferenceCommand{CockpitArtifactCommand: CockpitArtifactCommand{WorkspaceID: f.ws, ActorID: f.owner, ArtifactID: f.artifact, Human: true}, ReferenceKey: dbid.NewV7(), VersionID: version, NodeID: node, Purpose: "evidence"}, "node")
	if err != nil {
		t.Fatal(err)
	}
	for _, relation := range []string{"referenced", "all"} {
		page, e := f.issues.ListCockpitArtifacts(ctx, CockpitArtifactRead{WorkspaceID: f.ws, ActorID: f.owner, ProjectID: project, ModuleID: module, NodeID: node, Relation: relation, IDs: []pgtype.UUID{f.artifact}, Human: true})
		if e != nil || page.Total != 1 || page.FilteredTotal != 1 || len(page.Items) != 1 || page.Items[0].EvidenceVersion == nil || page.Items[0].ProjectID != util.UUIDToString(f.project) {
			t.Fatalf("external owner lost under target scope %s: %+v %v", relation, page, e)
		}
	}
	owned, err := f.issues.ListCockpitArtifacts(ctx, CockpitArtifactRead{WorkspaceID: f.ws, ActorID: f.owner, ProjectID: project, ModuleID: module, NodeID: node, Relation: "owned", Human: true})
	if err != nil || owned.Total != 0 {
		t.Fatalf("reference became ownership: %+v %v", owned, err)
	}
	_, err = f.issues.ListCockpitArtifacts(ctx, CockpitArtifactRead{WorkspaceID: f.ws, ActorID: f.owner, ProjectID: f.project, ModuleID: f.module, NodeID: node, Relation: "all", Human: true})
	if !errors.Is(err, ErrCockpitWorkflowNotFound) {
		t.Fatalf("mismatched target scope accepted: %v", err)
	}
}

func TestCockpitArtifactRuntimeReviewerHandoffKeepsAuthoritativeReverseContext(t *testing.T) {
	f := newArtifactFixture(t)
	ctx := context.Background()
	version, err := f.issues.SubmitCockpitArtifactVersion(ctx, f.submission(t, "Review handoff evidence"), IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	before, err := f.q.GetCockpitArtifactVersion(ctx, db.GetCockpitArtifactVersionParams{WorkspaceID: f.ws, ArtifactID: f.artifact, ID: version})
	if err != nil {
		t.Fatal(err)
	}
	user := f.User(t, "New reviewer", "new-reviewer-"+util.UUIDToString(dbid.NewV7())+"@multica.test")
	f.Member(t, f.WorkspaceID, user, "member")
	reviewer := parseTestUUID(t, user)
	command := CockpitArtifactReviewerCommand{CockpitArtifactCommand: CockpitArtifactCommand{WorkspaceID: f.ws, ActorID: f.owner, ArtifactID: f.artifact, ExpectedRevision: f.artifactHeader(t).Revision, Human: true}, HandoffKey: dbid.NewV7(), ReviewerID: reviewer, Reason: "New review responsibility"}
	first, err := f.issues.ReassignCockpitArtifactReviewer(ctx, command, IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.issues.ReassignCockpitArtifactReviewer(ctx, command, IssueCreateOpts{})
	if err != nil || second.Handoff.ID != first.Handoff.ID {
		t.Fatalf("handoff replay duplicated review: %v", err)
	}
	after, err := f.q.GetCockpitArtifactVersion(ctx, db.GetCockpitArtifactVersionParams{WorkspaceID: f.ws, ArtifactID: f.artifact, ID: version})
	if err != nil {
		t.Fatal(err)
	}
	if after.ID != before.ID || after.Content.String != before.Content.String || after.ContentHash != before.ContentHash || after.SubmissionKey != before.SubmissionKey || after.ReviewIssueID == before.ReviewIssueID {
		t.Fatal("handoff replaced content instead of responsibility")
	}
	old, err := f.q.GetIssue(ctx, before.ReviewIssueID)
	if err != nil || old.Status != "cancelled" {
		t.Fatalf("retired task not explicitly cancelled: %+v %v", old, err)
	}
	if _, err = f.q.UpdateIssueStatus(ctx, db.UpdateIssueStatusParams{WorkspaceID: f.ws, ID: old.ID, Status: "todo"}); err == nil {
		t.Fatal("retired formal review reopened via generic status")
	}
	// Origin rows deliberately sort before the retired version context. The
	// authoritative formal_review header must remain available on page one.
	for i := 0; i < 2; i++ {
		if _, err = f.issues.CreateCockpitArtifact(ctx, CockpitArtifactCreate{WorkspaceID: f.ws, ActorID: f.owner, NodeID: f.a, SourceIssueID: old.ID, ReviewerID: f.owner, CreationKey: dbid.NewV7(), Title: "Review supporting artifact", Human: true}); err != nil {
			t.Fatal(err)
		}
	}
	page, err := f.issues.ListCockpitIssueArtifactContexts(ctx, f.ws, old.ID, f.owner, "", 1)
	if err != nil || page.FormalReview == nil || page.FormalReview.Stage != "closed" || page.FormalReview.VersionID == nil || *page.FormalReview.VersionID != util.UUIDToString(version) || len(page.Items) != 1 || page.Items[0].Kind != "artifact" {
		t.Fatalf("formal guard depended on visible page: %+v %v", page, err)
	}
	denied := CockpitArtifactReview{CockpitArtifactCommand: CockpitArtifactCommand{WorkspaceID: f.ws, ActorID: f.owner, ArtifactID: f.artifact, ExpectedRevision: after.Revision, Human: true}, VersionID: version, Decision: "approved"}
	if err = f.issues.ReviewCockpitArtifactVersion(ctx, denied); !errors.Is(err, ErrCockpitWorkflowForbidden) {
		t.Fatalf("manager became reviewer after handoff: %v", err)
	}
	denied.ActorID = reviewer
	if err = f.issues.ReviewCockpitArtifactVersion(ctx, denied); err != nil {
		t.Fatal(err)
	}
	historical, err := f.issues.ReassignCockpitArtifactReviewer(ctx, command, IssueCreateOpts{})
	if err != nil || historical.Handoff.ID != first.Handoff.ID || historical.Version == nil || historical.Version.Decision != "approved" {
		t.Fatalf("old handoff retry lost original receipt: %+v %v", historical, err)
	}
}
func TestCockpitAcceptanceRuntimeExplicitReplacementAndReviewerRecovery(t *testing.T) {
	f := newArtifactFixture(t)
	ctx := context.Background()
	version, err := f.issues.SubmitCockpitArtifactVersion(ctx, f.submission(t, "Replacement evidence"), IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	f.review(t, version, "approved")
	if _, err = f.q.UpdateIssueStatus(ctx, db.UpdateIssueStatusParams{WorkspaceID: f.ws, ID: f.producer, Status: "done"}); err != nil {
		t.Fatal(err)
	}
	criterion := util.UUIDToString(dbid.NewV7())
	definition := CockpitAcceptanceCriteriaCommand{WorkspaceID: f.ws, ActorID: f.owner, NodeID: f.a, Human: true, Criteria: []CockpitAcceptanceCriterionInput{{ID: criterion, Title: "Initial condition"}}}
	criteria, err := f.issues.SaveCockpitAcceptanceCriteria(ctx, definition)
	if err != nil {
		t.Fatal(err)
	}
	cmd := CockpitAcceptanceRequestCommand{WorkspaceID: f.ws, ActorID: f.owner, NodeID: f.a, Human: true, ReviewerID: f.owner, RequestKey: dbid.NewV7(), ExpectedCriteriaRevision: criteria.Revision, Evidence: []CockpitAcceptanceEvidenceInput{{CriterionID: criterion, VersionIDs: []string{util.UUIDToString(version)}}}}
	first, err := f.issues.CreateCockpitAcceptanceRequest(ctx, cmd, IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	firstID, _ := util.ParseUUID(first.Request.ID)
	definition.ExpectedRevision = criteria.Revision
	definition.Criteria[0].Title = "Revised condition"
	criteria, err = f.issues.SaveCockpitAcceptanceCriteria(ctx, definition)
	if err != nil {
		t.Fatal(err)
	}
	oldReview := CockpitAcceptanceReview{WorkspaceID: f.ws, ActorID: f.owner, NodeID: f.a, RequestID: firstID, Human: true, ExpectedRevision: first.Request.Revision, Decision: "approved"}
	if err = f.issues.ReviewCockpitAcceptanceRequest(ctx, oldReview); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("stale conditions approved: %v", err)
	}
	replacement := cmd
	replacement.RequestKey = dbid.NewV7()
	replacement.ExpectedCriteriaRevision = criteria.Revision
	if _, err = f.issues.CreateCockpitAcceptanceRequest(ctx, replacement, IssueCreateOpts{}); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("stale review silently replaced: %v", err)
	}
	replacement.SupersedesRequestID = firstID
	next, err := f.issues.CreateCockpitAcceptanceRequest(ctx, replacement, IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	nextID, _ := util.ParseUUID(next.Request.ID)
	old, err := f.issues.GetCockpitAcceptanceRequest(ctx, CockpitAcceptanceRead{WorkspaceID: f.ws, ActorID: f.owner, NodeID: f.a, RequestID: firstID, Human: true})
	if err != nil || old.Request.Decision != "pending" || old.Request.SupersededAt == nil || old.Request.CanReview {
		t.Fatalf("replacement forged a historical conclusion: %+v %v", old, err)
	}
	user := f.User(t, "Acceptance reviewer", "acceptance-reviewer-"+util.UUIDToString(dbid.NewV7())+"@multica.test")
	f.Member(t, f.WorkspaceID, user, "member")
	reviewer := parseTestUUID(t, user)
	handoff, err := f.issues.ReassignCockpitAcceptanceReviewer(ctx, CockpitAcceptanceReviewerCommand{WorkspaceID: f.ws, ActorID: f.owner, NodeID: f.a, RequestID: nextID, HandoffKey: dbid.NewV7(), ReviewerID: reviewer, Human: true, ExpectedRevision: next.Request.Revision, Reason: "Delegate formal acceptance"}, IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	definition.ExpectedRevision = criteria.Revision
	definition.Criteria[0].Title = "A later condition"
	if _, err = f.issues.SaveCockpitAcceptanceCriteria(ctx, definition); err != nil {
		t.Fatal(err)
	}
	reject := CockpitAcceptanceReview{WorkspaceID: f.ws, ActorID: reviewer, NodeID: f.a, RequestID: nextID, Human: true, ExpectedRevision: handoff.Request.Request.Revision, Decision: "changes_requested", Feedback: "Update the request to the new conditions."}
	if err = f.issues.ReviewCockpitAcceptanceRequest(ctx, reject); err != nil {
		t.Fatalf("stale evidence blocked formal return for revision: %v", err)
	}
	source, err := f.q.GetIssue(ctx, f.producer)
	if err != nil || source.Status != "done" {
		t.Fatalf("acceptance feedback reopened unrelated production state: %+v %v", source, err)
	}
}

func TestCockpitArtifactRuntimeMinutesProvenanceRequiresPublishedFixedVersion(t *testing.T) {
	f := newArtifactFixture(t)
	ctx := context.Background()
	if err := f.issues.SubmitCockpitMeetingMinutes(ctx, CockpitMinutesSubmission{CockpitWorkPackageCommand: f.command(t), SubmissionKey: dbid.NewV7(), Content: "Unpublished follow-up minutes", ActorType: "member", AuthorID: f.owner}, IssueCreateOpts{}); err != nil {
		t.Fatal(err)
	}
	pending := f.versions(t)[0]
	if pending.PublishedAt.Valid {
		t.Fatal("fixture expected an unpublished minutes version")
	}
	in := f.submission(t, "A produced artifact with explicit meeting provenance")
	in.SourceMeetingID = f.meeting
	in.SourceMinutesVersionID = pending.ID
	if _, err := f.issues.SubmitCockpitArtifactVersion(ctx, in, IssueCreateOpts{}); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("unpublished minutes became fixed formal provenance: %v", err)
	}
	if n := f.Count(t, "SELECT count(*) FROM cockpit_artifact_version WHERE workspace_id=$1", f.ws); n != 0 {
		t.Fatal("rejected provenance left a partial version")
	}
	in.SourceMinutesVersionID = f.version.ID
	version, err := f.issues.SubmitCockpitArtifactVersion(ctx, in, IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	fixed, err := f.q.GetCockpitArtifactVersion(ctx, db.GetCockpitArtifactVersionParams{WorkspaceID: f.ws, ArtifactID: f.artifact, ID: version})
	if err != nil || fixed.SourceMeetingID != f.meeting || fixed.SourceMinutesVersionID != f.version.ID || fixed.SourceMinutesVersionNumber.Int32 != f.version.VersionNumber || fixed.SourceMeetingTitle == "" {
		t.Fatalf("fixed published provenance did not persist: %+v %v", fixed, err)
	}
}

func TestCockpitArtifactRuntimeCommandReplaySurvivesManagerDemotion(t *testing.T) {
	f := newArtifactFixture(t)
	ctx := context.Background()
	user := f.User(t, "Temporary domain manager", "temporary-manager-"+util.UUIDToString(dbid.NewV7())+"@multica.test")
	f.Member(t, f.WorkspaceID, user, "admin")
	admin := parseTestUUID(t, user)
	version, err := f.issues.SubmitCockpitArtifactVersion(ctx, f.submission(t, "Fixed evidence before permission change"), IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	f.review(t, version, "approved")
	replacementTask, err := f.issues.CreateCockpitNodeTask(ctx, f.createInput("Existing revision work"), IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	existing := CockpitArtifactProducerCommand{CockpitArtifactCommand: CockpitArtifactCommand{WorkspaceID: f.ws, ActorID: admin, ArtifactID: f.artifact, ExpectedRevision: f.artifactHeader(t).Revision, Human: true}, CommandKey: dbid.NewV7(), IssueID: replacementTask.Issue.ID, Reason: "Adopt existing production work"}
	firstAssignment, err := f.issues.AssignCockpitArtifactProducer(ctx, existing, IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	newTask := CockpitArtifactProducerCommand{CockpitArtifactCommand: CockpitArtifactCommand{WorkspaceID: f.ws, ActorID: admin, ArtifactID: f.artifact, ExpectedRevision: f.artifactHeader(t).Revision, Human: true}, CommandKey: dbid.NewV7(), NewIssue: &IssueCreateParams{Title: "Explicit new production task"}, Reason: "Create production responsibility"}
	secondAssignment, err := f.issues.AssignCockpitArtifactProducer(ctx, newTask, IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	reviewer := CockpitArtifactReviewerCommand{CockpitArtifactCommand: CockpitArtifactCommand{WorkspaceID: f.ws, ActorID: admin, ArtifactID: f.artifact, ExpectedRevision: f.artifactHeader(t).Revision, Human: true}, HandoffKey: dbid.NewV7(), ReviewerID: admin, Reason: "Assign future review responsibility"}
	handoff, err := f.issues.ReassignCockpitArtifactReviewer(ctx, reviewer, IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	refCommand := CockpitArtifactReferenceCommand{CockpitArtifactCommand: CockpitArtifactCommand{WorkspaceID: f.ws, ActorID: admin, ArtifactID: f.artifact, Human: true}, ReferenceKey: dbid.NewV7(), VersionID: version, NodeID: f.b, Purpose: "evidence"}
	reference, err := f.issues.CreateCockpitArtifactReference(ctx, refCommand, "node")
	if err != nil {
		t.Fatal(err)
	}
	criterion := util.UUIDToString(dbid.NewV7())
	criteria, err := f.issues.SaveCockpitAcceptanceCriteria(ctx, CockpitAcceptanceCriteriaCommand{WorkspaceID: f.ws, ActorID: f.owner, NodeID: f.a, Human: true, Criteria: []CockpitAcceptanceCriterionInput{{ID: criterion, Title: "Verify evidence"}}})
	if err != nil {
		t.Fatal(err)
	}
	requestCommand := CockpitAcceptanceRequestCommand{WorkspaceID: f.ws, ActorID: admin, NodeID: f.a, Human: true, RequestKey: dbid.NewV7(), ReviewerID: f.owner, ExpectedCriteriaRevision: criteria.Revision, Evidence: []CockpitAcceptanceEvidenceInput{{CriterionID: criterion, VersionIDs: []string{util.UUIDToString(version)}}}}
	request, err := f.issues.CreateCockpitAcceptanceRequest(ctx, requestCommand, IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	requestID, _ := util.ParseUUID(request.Request.ID)
	acceptanceReviewer := CockpitAcceptanceReviewerCommand{WorkspaceID: f.ws, ActorID: admin, NodeID: f.a, RequestID: requestID, HandoffKey: dbid.NewV7(), ReviewerID: admin, Human: true, ExpectedRevision: request.Request.Revision, Reason: "Move formal acceptance responsibility"}
	acceptanceHandoff, err := f.issues.ReassignCockpitAcceptanceReviewer(ctx, acceptanceReviewer, IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.Pool.Exec(ctx, "UPDATE member SET role='member' WHERE workspace_id=$1 AND user_id=$2", f.ws, admin); err != nil {
		t.Fatal(err)
	}
	if out, e := f.issues.AssignCockpitArtifactProducer(ctx, existing, IssueCreateOpts{}); e != nil || out.Assignment.ID != firstAssignment.Assignment.ID {
		t.Fatalf("existing producer receipt blocked after demotion: %v", e)
	}
	if out, e := f.issues.AssignCockpitArtifactProducer(ctx, newTask, IssueCreateOpts{}); e != nil || out.Assignment.ID != secondAssignment.Assignment.ID {
		t.Fatalf("new producer receipt blocked after demotion: %v", e)
	}
	if out, e := f.issues.ReassignCockpitArtifactReviewer(ctx, reviewer, IssueCreateOpts{}); e != nil || out.Handoff.ID != handoff.Handoff.ID {
		t.Fatalf("reviewer receipt blocked after demotion: %v", e)
	}
	if out, e := f.issues.CreateCockpitArtifactReference(ctx, refCommand, "node"); e != nil || out.Reference.ID != reference.Reference.ID {
		t.Fatalf("reference receipt blocked after demotion: %v", e)
	}
	if out, e := f.issues.CreateCockpitAcceptanceRequest(ctx, requestCommand, IssueCreateOpts{}); e != nil || out.Request.ID != request.Request.ID {
		t.Fatalf("acceptance receipt blocked after demotion: %v", e)
	}
	if out, e := f.issues.ReassignCockpitAcceptanceReviewer(ctx, acceptanceReviewer, IssueCreateOpts{}); e != nil || out.Handoff.ID != acceptanceHandoff.Handoff.ID {
		t.Fatalf("acceptance handoff receipt blocked after demotion: %v", e)
	}
	newTask.CommandKey = dbid.NewV7()
	if _, err = f.issues.AssignCockpitArtifactProducer(ctx, newTask, IssueCreateOpts{}); !errors.Is(err, ErrCockpitWorkflowForbidden) {
		t.Fatalf("demoted manager created new production work: %v", err)
	}
	reviewer.HandoffKey = dbid.NewV7()
	reviewer.ReviewerID = f.owner
	if _, err = f.issues.ReassignCockpitArtifactReviewer(ctx, reviewer, IssueCreateOpts{}); !errors.Is(err, ErrCockpitWorkflowForbidden) {
		t.Fatalf("demoted manager changed future reviewer: %v", err)
	}
	refCommand.ReferenceKey = dbid.NewV7()
	refCommand.Purpose = "reference"
	if _, err = f.issues.CreateCockpitArtifactReference(ctx, refCommand, "node"); !errors.Is(err, ErrCockpitWorkflowForbidden) {
		t.Fatalf("demoted manager created a new reference: %v", err)
	}
	requestCommand.RequestKey = dbid.NewV7()
	if _, err = f.issues.CreateCockpitAcceptanceRequest(ctx, requestCommand, IssueCreateOpts{}); !errors.Is(err, ErrCockpitWorkflowForbidden) {
		t.Fatalf("demoted manager opened new acceptance: %v", err)
	}
	acceptanceReviewer.HandoffKey = dbid.NewV7()
	acceptanceReviewer.ReviewerID = f.owner
	if _, err = f.issues.ReassignCockpitAcceptanceReviewer(ctx, acceptanceReviewer, IssueCreateOpts{}); !errors.Is(err, ErrCockpitWorkflowForbidden) {
		t.Fatalf("demoted manager moved a formal review: %v", err)
	}
}

func TestCockpitArtifactRuntimeRetentionGuardCoversCurrentAndRetiredRoles(t *testing.T) {
	f := newArtifactFixture(t)
	ctx := context.Background()
	version, err := f.issues.SubmitCockpitArtifactVersion(ctx, f.submission(t, "Retained origin and formal review"), IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	initial, err := f.q.GetCockpitArtifactVersion(ctx, db.GetCockpitArtifactVersionParams{WorkspaceID: f.ws, ArtifactID: f.artifact, ID: version})
	if err != nil {
		t.Fatal(err)
	}
	first, err := f.issues.CreateCockpitNodeTask(ctx, f.createInput("Former authorized producer"), IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.issues.CreateCockpitNodeTask(ctx, f.createInput("Current authorized producer"), IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []pgtype.UUID{first.Issue.ID, second.Issue.ID} {
		if _, err = f.issues.AssignCockpitArtifactProducer(ctx, CockpitArtifactProducerCommand{CockpitArtifactCommand: CockpitArtifactCommand{WorkspaceID: f.ws, ActorID: f.owner, ArtifactID: f.artifact, ExpectedRevision: f.artifactHeader(t).Revision, Human: true}, CommandKey: dbid.NewV7(), IssueID: id, Reason: "Retain explicit production history"}, IssueCreateOpts{}); err != nil {
			t.Fatal(err)
		}
	}
	user := f.User(t, "Retention reviewer", "retention-reviewer-"+util.UUIDToString(dbid.NewV7())+"@multica.test")
	f.Member(t, f.WorkspaceID, user, "member")
	reviewer := parseTestUUID(t, user)
	handed, err := f.issues.ReassignCockpitArtifactReviewer(ctx, CockpitArtifactReviewerCommand{CockpitArtifactCommand: CockpitArtifactCommand{WorkspaceID: f.ws, ActorID: f.owner, ArtifactID: f.artifact, ExpectedRevision: f.artifactHeader(t).Revision, Human: true}, HandoffKey: dbid.NewV7(), ReviewerID: reviewer, Reason: "Preserve retired formal authority"}, IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if handed.Version == nil || handed.Version.ReviewIssue == nil {
		t.Fatal("handoff lacks current formal review")
	}
	currentReview, _ := util.ParseUUID(handed.Version.ReviewIssue.ID)
	if err = f.issues.ReviewCockpitArtifactVersion(ctx, CockpitArtifactReview{CockpitArtifactCommand: CockpitArtifactCommand{WorkspaceID: f.ws, ActorID: reviewer, ArtifactID: f.artifact, ExpectedRevision: handed.Version.Revision, Human: true}, VersionID: version, Decision: "approved"}); err != nil {
		t.Fatal(err)
	}
	criterion := util.UUIDToString(dbid.NewV7())
	criteria, err := f.issues.SaveCockpitAcceptanceCriteria(ctx, CockpitAcceptanceCriteriaCommand{WorkspaceID: f.ws, ActorID: f.owner, NodeID: f.a, Human: true, Criteria: []CockpitAcceptanceCriterionInput{{ID: criterion, Title: "Retained criterion"}}})
	if err != nil {
		t.Fatal(err)
	}
	accepted, err := f.issues.CreateCockpitAcceptanceRequest(ctx, CockpitAcceptanceRequestCommand{WorkspaceID: f.ws, ActorID: f.owner, NodeID: f.a, RequestKey: dbid.NewV7(), ReviewerID: f.owner, Human: true, ExpectedCriteriaRevision: criteria.Revision, Evidence: []CockpitAcceptanceEvidenceInput{{CriterionID: criterion, VersionIDs: []string{util.UUIDToString(version)}}}}, IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	request, _ := util.ParseUUID(accepted.Request.ID)
	oldAcceptance, _ := util.ParseUUID(accepted.Request.ReviewIssue.ID)
	changed, err := f.issues.ReassignCockpitAcceptanceReviewer(ctx, CockpitAcceptanceReviewerCommand{WorkspaceID: f.ws, ActorID: f.owner, NodeID: f.a, RequestID: request, HandoffKey: dbid.NewV7(), ReviewerID: reviewer, Human: true, ExpectedRevision: accepted.Request.Revision, Reason: "Preserve retired acceptance authority"}, IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	currentAcceptance, _ := util.ParseUUID(changed.Request.Request.ReviewIssue.ID)
	cases := map[string]pgtype.UUID{"origin/version producer": f.producer, "former producer": first.Issue.ID, "current producer": second.Issue.ID, "retired artifact review": initial.ReviewIssueID, "current artifact review": currentReview, "retired acceptance review": oldAcceptance, "current acceptance review": currentAcceptance}
	for name, id := range cases {
		t.Run(name, func(t *testing.T) {
			protected, e := f.q.CockpitArtifactReferencesIssue(ctx, db.CockpitArtifactReferencesIssueParams{Column1: f.ws, Column2: id})
			if e != nil || !protected {
				t.Fatalf("retention lookup lost %s: %v", name, e)
			}
			if e = f.q.DeleteIssue(ctx, db.DeleteIssueParams{WorkspaceID: f.ws, ID: id}); !IsCockpitArtifactIntegrityError(e) {
				t.Fatalf("direct deletion bypassed %s protection: %v", name, e)
			}
			other, e := f.q.CockpitArtifactReferencesIssue(ctx, db.CockpitArtifactReferencesIssueParams{Column1: dbid.NewV7(), Column2: id})
			if e != nil || other {
				t.Fatalf("guard crossed workspace: %v", e)
			}
		})
	}
	unrelated, err := f.issues.Create(ctx, IssueCreateParams{WorkspaceID: f.ws, CreatorID: f.owner, CreatorType: "member", Title: "Unrelated cleanup remains valid", Status: "backlog", Priority: "none", AllowDuplicate: true}, IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if err = f.q.DeleteIssue(ctx, db.DeleteIssueParams{WorkspaceID: f.ws, ID: unrelated.Issue.ID}); err != nil {
		t.Fatalf("guard blocked an unrelated Issue: %v", err)
	}
}
