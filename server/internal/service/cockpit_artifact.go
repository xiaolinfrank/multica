package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/artifactcapture"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type CockpitArtifactCommand struct {
	WorkspaceID, ActorID, ArtifactID pgtype.UUID
	ExpectedRevision                 int64
	Human                            bool
}
type CockpitArtifactCreate struct {
	WorkspaceID, ActorID, NodeID, SourceIssueID, ReviewerID, CreationKey pgtype.UUID
	Title, Description                                                   string
	Human                                                                bool
}
type CockpitArtifactEdit struct {
	CockpitArtifactCommand
	Title, Description string
}
type CockpitArtifactSubmission struct {
	CockpitArtifactCommand
	SubmissionKey, ProducerIssueID, ProducerRunID, SourceMeetingID, SourceMinutesVersionID, AuthorID pgtype.UUID
	ActorType                                                                                        string
	Payload                                                                                          CockpitArtifactPayload
}
type CockpitArtifactReview struct {
	CockpitArtifactCommand
	VersionID          pgtype.UUID
	Decision, Feedback string
}

func artifactInput(message string) error {
	return fmt.Errorf("%w: %s", ErrCockpitWorkflowInput, message)
}
func artifactConflict(message string) error {
	return fmt.Errorf("%w: %s", ErrCockpitWorkflowConflict, message)
}
func lockArtifactWorkspace(ctx context.Context, q *db.Queries, ws, actor pgtype.UUID) (db.Member, error) {
	if _, err := q.LockWorkspaceForChatSessionCreate(ctx, ws); err != nil {
		return db.Member{}, cockpitWorkflowError(err)
	}
	if _, err := q.LockCockpitCreationMember(ctx, db.LockCockpitCreationMemberParams{WorkspaceID: ws, UserID: actor}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return db.Member{}, ErrCockpitWorkflowForbidden
		}
		return db.Member{}, err
	}
	m, err := q.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{WorkspaceID: ws, UserID: actor})
	if err != nil {
		return m, err
	}
	if _, err = q.LockCockpitForWorkspaceChanges(ctx, ws); err != nil {
		return m, cockpitWorkflowError(err)
	}
	return m, nil
}
func (s *IssueService) beginArtifact(ctx context.Context, p CockpitArtifactCommand) (pgx.Tx, *db.Queries, db.CockpitArtifact, db.Member, error) {
	tx, err := s.TxStarter.Begin(ctx)
	if err != nil {
		return nil, nil, db.CockpitArtifact{}, db.Member{}, err
	}
	q := s.Queries.WithTx(tx)
	m, err := lockArtifactWorkspace(ctx, q, p.WorkspaceID, p.ActorID)
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, nil, db.CockpitArtifact{}, m, err
	}
	a, err := q.LockCockpitArtifact(ctx, db.LockCockpitArtifactParams{WorkspaceID: p.WorkspaceID, ID: p.ArtifactID})
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, nil, a, m, cockpitWorkflowError(err)
	}
	return tx, q, a, m, nil
}
func artifactExpected(actual, expected int64) error {
	if expected < 1 {
		return artifactInput("expected_revision must be positive")
	}
	if actual != expected {
		return ErrCockpitWorkflowConflict
	}
	return nil
}
func artifactReviewer(ctx context.Context, q *db.Queries, ws, reviewer pgtype.UUID) error {
	if !reviewer.Valid {
		return artifactInput("a human workspace reviewer is required")
	}
	if _, err := q.LockCockpitCreationMember(ctx, db.LockCockpitCreationMemberParams{WorkspaceID: ws, UserID: reviewer}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return artifactConflict("the designated reviewer is no longer a workspace member; explicitly hand over responsibility")
		}
		return err
	}
	return nil
}
func (s *IssueService) CreateCockpitArtifact(ctx context.Context, p CockpitArtifactCreate) (pgtype.UUID, error) {
	if !p.Human {
		return pgtype.UUID{}, ErrCockpitWorkflowForbidden
	}
	if !p.CreationKey.Valid {
		return pgtype.UUID{}, artifactInput("creation_key is required")
	}
	var err error
	p.Title, p.Description, err = NormalizeCockpitArtifactText(p.Title, p.Description)
	if err != nil {
		return pgtype.UUID{}, err
	}
	hash := planningHash(p)
	tx, err := s.TxStarter.Begin(ctx)
	if err != nil {
		return pgtype.UUID{}, err
	}
	defer tx.Rollback(ctx)
	q := s.Queries.WithTx(tx)
	if _, err = lockArtifactWorkspace(ctx, q, p.WorkspaceID, p.ActorID); err != nil {
		return pgtype.UUID{}, err
	}
	old, err := q.GetCockpitArtifactByKey(ctx, db.GetCockpitArtifactByKeyParams{WorkspaceID: p.WorkspaceID, CreationKey: p.CreationKey})
	if err == nil {
		if old.RequestHash != hash || old.CreatedBy != p.ActorID {
			return pgtype.UUID{}, artifactConflict("creation_key identifies a different command")
		}
		return old.ID, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return pgtype.UUID{}, err
	}
	_, project, module, err := requireExecutionLeaf(ctx, q, p.WorkspaceID, p.NodeID)
	if err != nil {
		return pgtype.UUID{}, err
	}
	source, err := q.LockIssueForDescriptionUpdate(ctx, db.LockIssueForDescriptionUpdateParams{WorkspaceID: p.WorkspaceID, ID: p.SourceIssueID})
	if err != nil {
		return pgtype.UUID{}, cockpitWorkflowError(err)
	}
	if source.ProjectID != project || source.ModuleID != module {
		return pgtype.UUID{}, artifactConflict("the source Issue must already belong to the owner L3 project and module")
	}
	if err = artifactReviewer(ctx, q, p.WorkspaceID, p.ReviewerID); err != nil {
		return pgtype.UUID{}, err
	}
	a, err := q.CreateCockpitArtifact(ctx, db.CreateCockpitArtifactParams{ID: dbid.NewV7(), WorkspaceID: p.WorkspaceID, OwnerNodeID: p.NodeID, ProjectID: project, ModuleID: module, SourceIssueID: source.ID, CreationKey: p.CreationKey, RequestHash: hash, CreatedBy: p.ActorID, Title: p.Title, Description: p.Description, ReviewerID: p.ReviewerID})
	if err != nil {
		return pgtype.UUID{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return pgtype.UUID{}, err
	}
	s.artifactChanged(a, p.ActorID)
	return a.ID, nil
}
func (s *IssueService) EditCockpitArtifact(ctx context.Context, p CockpitArtifactEdit) error {
	var err error
	p.Title, p.Description, err = NormalizeCockpitArtifactText(p.Title, p.Description)
	if err != nil {
		return err
	}
	tx, q, a, m, err := s.beginArtifact(ctx, p.CockpitArtifactCommand)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if !artifactManager(a, p.ActorID, m.Role, p.Human) {
		return ErrCockpitWorkflowForbidden
	}
	if a.ArchivedAt.Valid {
		return artifactConflict("restore the artifact before editing")
	}
	if err = artifactExpected(a.Revision, p.ExpectedRevision); err != nil {
		return err
	}
	oldTitle, oldDescription := a.Title, a.Description
	a, err = q.EditCockpitArtifact(ctx, db.EditCockpitArtifactParams{WorkspaceID: p.WorkspaceID, ID: p.ArtifactID, Title: p.Title, Description: p.Description})
	if err != nil {
		return err
	}
	if err = recordArtifactActivity(ctx, q, a, p.ActorID, "cockpit_artifact_updated", map[string]any{"title_before": oldTitle, "title_after": p.Title, "description_changed": oldDescription != p.Description}); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.artifactChanged(a, p.ActorID)
	return nil
}
func (s *IssueService) ArchiveCockpitArtifact(ctx context.Context, p CockpitArtifactCommand, archived bool) error {
	tx, q, a, m, err := s.beginArtifact(ctx, p)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if !artifactManager(a, p.ActorID, m.Role, p.Human) {
		return ErrCockpitWorkflowForbidden
	}
	if p.ExpectedRevision < 1 || p.ExpectedRevision > a.Revision {
		return ErrCockpitWorkflowConflict
	}
	if a.ArchivedAt.Valid == archived {
		return nil
	}
	if err = artifactExpected(a.Revision, p.ExpectedRevision); err != nil {
		return err
	}
	if archived && a.CurrentVersionID.Valid {
		v, e := q.GetCockpitArtifactVersion(ctx, db.GetCockpitArtifactVersionParams{WorkspaceID: a.WorkspaceID, ArtifactID: a.ID, ID: a.CurrentVersionID})
		if e != nil {
			return e
		}
		if e = validateCockpitArtifactSubmission(false, &CockpitArtifactVersionMetadata{CaptureStatus: v.CaptureStatus, Decision: v.Decision}); e != nil {
			return e
		}
	}
	a, err = q.ArchiveCockpitArtifact(ctx, db.ArchiveCockpitArtifactParams{WorkspaceID: p.WorkspaceID, ID: p.ArtifactID, Archived: archived, ActorID: p.ActorID})
	if err != nil {
		return err
	}
	action := "cockpit_artifact_restored"
	if archived {
		action = "cockpit_artifact_archived"
	}
	if err = recordArtifactActivity(ctx, q, a, p.ActorID, action, nil); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.artifactChanged(a, p.ActorID)
	return nil
}
func (s *IssueService) artifactChanged(a db.CockpitArtifact, actor pgtype.UUID) {
	s.planningChanged(a.WorkspaceID, actor, "artifacts", map[string]any{"id": util.UUIDToString(a.ID), "artifact_id": util.UUIDToString(a.ID), "node_id": util.UUIDToString(a.OwnerNodeID)})
}

// The create hook uses the canonical Issue transaction and its quota, numbering
// and post-commit events. No task can exist without its formal domain relation.
type cockpitArtifactIssue struct {
	acceptanceReviewer    *CockpitAcceptanceReviewerCommand
	acceptanceHandoff     db.CockpitAcceptanceReviewerHandoff
	acceptance            *CockpitAcceptanceRequestCommand
	acceptanceProof       string
	acceptanceDefinition  db.CockpitAcceptanceDefinition
	acceptanceRequest     db.CockpitAcceptanceRequest
	supersededRequest     db.CockpitAcceptanceRequest
	acceptanceCriteria    []db.CockpitAcceptanceCriterion
	acceptanceSources     []db.ListCockpitAcceptanceVersionSourcesRow
	producer              *CockpitArtifactProducerCommand
	reviewer              *CockpitArtifactReviewerCommand
	assignment            db.CockpitArtifactProducerAssignment
	handoff               db.CockpitArtifactReviewerHandoff
	retired               db.Issue
	retiredPreviousStatus string
	cancelled             []db.AgentTaskQueue
	captured              *cockpitArtifactCaptured
	submission            *CockpitArtifactSubmission
	payload               CockpitArtifactPayloadIdentity
	hash                  string
	artifact              db.CockpitArtifact
	version               db.CockpitArtifactVersion
	versionParams         db.CreateCockpitArtifactVersionParams
}

func artifactSubmissionHash(p CockpitArtifactSubmission, payload CockpitArtifactPayloadIdentity) string {
	return planningHash(struct {
		Actor, Author, Producer, Run, Meeting, Minutes pgtype.UUID
		ActorType                                      string
		Expected                                       int64
		Payload                                        CockpitArtifactPayloadIdentity
	}{p.ActorID, p.AuthorID, p.ProducerIssueID, p.ProducerRunID, p.SourceMeetingID, p.SourceMinutesVersionID, p.ActorType, p.ExpectedRevision, payload})
}
func prepareArtifactSubmission(ctx context.Context, q *db.Queries, a db.CockpitArtifact, p CockpitArtifactSubmission, payload CockpitArtifactPayloadIdentity, hash string) (db.CreateCockpitArtifactVersionParams, *db.CockpitArtifactVersion, error) {
	existing, err := q.GetCockpitArtifactVersionByKey(ctx, db.GetCockpitArtifactVersionByKeyParams{WorkspaceID: p.WorkspaceID, ArtifactID: p.ArtifactID, SubmissionKey: p.SubmissionKey})
	if err == nil {
		if existing.RequestHash != hash || existing.SubmittedByUserID != p.ActorID {
			return db.CreateCockpitArtifactVersionParams{}, nil, artifactConflict("submission_key identifies a different command")
		}
		return db.CreateCockpitArtifactVersionParams{}, &existing, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return db.CreateCockpitArtifactVersionParams{}, nil, err
	}
	if err = artifactExpected(a.Revision, p.ExpectedRevision); err != nil {
		return db.CreateCockpitArtifactVersionParams{}, nil, err
	}
	if a.AuthorizedProducerIssueID != p.ProducerIssueID {
		return db.CreateCockpitArtifactVersionParams{}, nil, artifactConflict("production responsibility changed; use the current producer Issue")
	}
	producer, err := q.LockIssueForDescriptionUpdate(ctx, db.LockIssueForDescriptionUpdateParams{WorkspaceID: p.WorkspaceID, ID: p.ProducerIssueID})
	if err != nil {
		return db.CreateCockpitArtifactVersionParams{}, nil, cockpitWorkflowError(err)
	}
	if producer.ProjectID != a.ProjectID || producer.ModuleID != a.ModuleID {
		return db.CreateCockpitArtifactVersionParams{}, nil, artifactConflict("producer Issue scope does not match the artifact")
	}
	member, err := q.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{WorkspaceID: p.WorkspaceID, UserID: p.ActorID})
	if err != nil {
		return db.CreateCockpitArtifactVersionParams{}, nil, err
	}
	if p.ActorType == "member" {
		if !p.Human || p.AuthorID != p.ActorID || p.ProducerRunID.Valid || (!artifactManager(a, p.ActorID, member.Role, true) && !(producer.AssigneeType.String == "member" && producer.AssigneeID == p.ActorID)) {
			return db.CreateCockpitArtifactVersionParams{}, nil, ErrCockpitWorkflowForbidden
		}
	} else if p.ActorType == "agent" {
		if p.Human || !p.AuthorID.Valid || !p.ProducerRunID.Valid {
			return db.CreateCockpitArtifactVersionParams{}, nil, ErrCockpitWorkflowForbidden
		}
		run, err := q.GetAgentTask(ctx, p.ProducerRunID)
		if err != nil || run.IssueID != producer.ID || run.AgentID != p.AuthorID {
			return db.CreateCockpitArtifactVersionParams{}, nil, ErrCockpitWorkflowForbidden
		}
	} else {
		return db.CreateCockpitArtifactVersionParams{}, nil, ErrCockpitWorkflowForbidden
	}
	number := int32(1)
	var current *CockpitArtifactVersionMetadata
	if a.CurrentVersionID.Valid {
		v, e := q.GetCockpitArtifactVersion(ctx, db.GetCockpitArtifactVersionParams{WorkspaceID: a.WorkspaceID, ArtifactID: a.ID, ID: a.CurrentVersionID})
		if e != nil {
			return db.CreateCockpitArtifactVersionParams{}, nil, e
		}
		current = &CockpitArtifactVersionMetadata{CaptureStatus: v.CaptureStatus, Decision: v.Decision}
		if v.VersionNumber == 2147483647 {
			return db.CreateCockpitArtifactVersionParams{}, nil, artifactConflict("version numbering exhausted")
		}
		number = v.VersionNumber + 1
	}
	if err = validateCockpitArtifactSubmission(a.ArchivedAt.Valid, current); err != nil {
		return db.CreateCockpitArtifactVersionParams{}, nil, err
	}
	if err = artifactReviewer(ctx, q, a.WorkspaceID, a.ReviewerID); err != nil {
		return db.CreateCockpitArtifactVersionParams{}, nil, err
	}
	facts, err := readPlanningIssueFacts(ctx, q, p.WorkspaceID, []pgtype.UUID{producer.ID})
	if err != nil {
		return db.CreateCockpitArtifactVersionParams{}, nil, err
	}
	fact, ok := facts[producer.ID]
	if !ok {
		return db.CreateCockpitArtifactVersionParams{}, nil, ErrCockpitWorkflowNotFound
	}
	v := db.CreateCockpitArtifactVersionParams{ID: dbid.NewV7(), WorkspaceID: a.WorkspaceID, ArtifactID: a.ID, VersionNumber: number, SubmissionKey: p.SubmissionKey, RequestHash: hash, ProducerIssueID: producer.ID, ProducerIssueIdentifier: fact.Identifier, ProducerIssueTitle: producer.Title, ProducerRunID: p.ProducerRunID, SourceMeetingID: p.SourceMeetingID, SourceMinutesVersionID: p.SourceMinutesVersionID, PayloadKind: payload.Kind, ReviewerID: a.ReviewerID, SubmittedByType: p.ActorType, SubmittedByID: p.AuthorID, SubmittedByUserID: p.ActorID, CaptureStatus: "queued", Decision: "not_requested"}
	if p.SourceMinutesVersionID.Valid && !p.SourceMeetingID.Valid {
		return v, nil, artifactInput("a minutes version requires its meeting")
	}
	if p.SourceMeetingID.Valid {
		meeting, e := q.GetCockpitMeeting(ctx, db.GetCockpitMeetingParams{WorkspaceID: a.WorkspaceID, ID: p.SourceMeetingID})
		if e != nil {
			return v, nil, cockpitWorkflowError(e)
		}
		v.SourceMeetingTitle = meeting.Title
		if p.SourceMinutesVersionID.Valid {
			mv, e := q.GetCockpitMinutesVersion(ctx, db.GetCockpitMinutesVersionParams{WorkspaceID: a.WorkspaceID, MeetingID: p.SourceMeetingID, ID: p.SourceMinutesVersionID})
			if e != nil {
				return v, nil, cockpitWorkflowError(e)
			}
			if !mv.PublishedAt.Valid || mv.Decision != "approved" {
				return v, nil, artifactConflict("source minutes must be an approved, previously published fixed version")
			}
			v.SourceMinutesVersionNumber = pgtype.Int4{Int32: mv.VersionNumber, Valid: true}
		}
	}
	if payload.Kind == "text" {
		v.Content = pgtype.Text{String: payload.Content, Valid: true}
		v.ContentType = "text/markdown; charset=utf-8"
		v.SizeBytes = pgtype.Int8{Int64: int64(len(payload.Content)), Valid: true}
		v.ContentHash = pgtype.Text{String: payload.ContentHash, Valid: true}
		v.CaptureStatus = "ready"
		v.Decision = "pending"
	}
	return v, nil, nil
}
func (s *IssueService) SubmitCockpitArtifactVersion(ctx context.Context, p CockpitArtifactSubmission, opts IssueCreateOpts) (pgtype.UUID, error) {
	if !p.SubmissionKey.Valid || !p.ProducerIssueID.Valid {
		return pgtype.UUID{}, artifactInput("submission_key and producer_issue_id are required")
	}
	payload, err := NormalizeCockpitArtifactPayload(p.Payload)
	if err != nil {
		return pgtype.UUID{}, err
	}
	hash := artifactSubmissionHash(p, payload)
	if payload.Kind == "text" {
		hook := &cockpitArtifactIssue{submission: &p, payload: payload, hash: hash}
		_, err = s.Create(ctx, IssueCreateParams{WorkspaceID: p.WorkspaceID, CreatorID: p.ActorID, CreatorType: "member", CockpitArtifact: hook}, opts)
		if err != nil {
			return pgtype.UUID{}, err
		}
		s.artifactChanged(hook.artifact, p.ActorID)
		return hook.version.ID, nil
	}
	tx, q, a, _, err := s.beginArtifact(ctx, p.CockpitArtifactCommand)
	if err != nil {
		return pgtype.UUID{}, err
	}
	defer tx.Rollback(ctx)
	params, existing, err := prepareArtifactSubmission(ctx, q, a, p, payload, hash)
	if err != nil {
		return pgtype.UUID{}, err
	}
	if existing != nil {
		return existing.ID, nil
	}
	attachmentID, err := util.ParseUUID(payload.AttachmentID)
	if err != nil {
		return pgtype.UUID{}, err
	}
	attachment, err := q.GetAttachment(ctx, db.GetAttachmentParams{WorkspaceID: p.WorkspaceID, ID: attachmentID})
	if err != nil {
		return pgtype.UUID{}, cockpitWorkflowError(err)
	}
	if attachment.IssueID != p.ProducerIssueID {
		return pgtype.UUID{}, artifactConflict("the selected attachment must belong to the authorized producer Issue")
	}
	if !s.artifactFileCaptureAvailable() {
		return pgtype.UUID{}, ErrCockpitArtifactPrivateStorageRequired
	}
	sourceKey := s.CockpitArtifactStorage.KeyFromURL(attachment.Url)
	request := artifactcapture.Request{WorkspaceID: util.UUIDToString(a.WorkspaceID), VersionID: util.UUIDToString(params.ID), AttemptID: util.UUIDToString(dbid.NewV7()), Source: artifactcapture.Source{AttachmentID: payload.AttachmentID, StorageKey: sourceKey, Filename: attachment.Filename, ContentType: attachment.ContentType, SizeBytes: attachment.SizeBytes}}
	if _, err = artifactcapture.TargetKey(request); err != nil {
		return pgtype.UUID{}, artifactInput(err.Error())
	}
	params.SourceAttachmentID = attachment.ID
	params.Filename = attachment.Filename
	params.ContentType = attachment.ContentType
	params.SizeBytes = pgtype.Int8{Int64: attachment.SizeBytes, Valid: true}
	v, err := q.CreateCockpitArtifactVersion(ctx, params)
	if err != nil {
		return pgtype.UUID{}, err
	}
	if _, err = q.CreateCockpitArtifactCapture(ctx, db.CreateCockpitArtifactCaptureParams{VersionID: v.ID, WorkspaceID: a.WorkspaceID, ArtifactID: a.ID, SourceAttachmentID: attachment.ID, SourceStorageKey: sourceKey, SourceObjectUrl: attachment.Url, SourceFilename: attachment.Filename, SourceContentType: attachment.ContentType, SourceSizeBytes: attachment.SizeBytes, CreatedBy: p.ActorID}); err != nil {
		return pgtype.UUID{}, err
	}
	if err = retireUnrequestedArtifactCapture(ctx, q, a); err != nil {
		return pgtype.UUID{}, err
	}
	a, err = q.SetCockpitArtifactCurrentVersion(ctx, db.SetCockpitArtifactCurrentVersionParams{WorkspaceID: a.WorkspaceID, ID: a.ID, CurrentVersionID: v.ID})
	if err != nil {
		return pgtype.UUID{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return pgtype.UUID{}, err
	}
	s.artifactChanged(a, p.ActorID)
	return v.ID, nil
}
func prepareCockpitArtifactIssue(ctx context.Context, q *db.Queries, p *IssueCreateParams) (*db.Issue, error) {
	hook := p.CockpitArtifact
	if hook.acceptanceReviewer != nil {
		return prepareCockpitAcceptanceReviewerIssue(ctx, q, p)
	}
	if hook.acceptance != nil {
		return prepareCockpitAcceptanceIssue(ctx, q, p)
	}
	if hook.producer != nil {
		return prepareCockpitArtifactProducerIssue(ctx, q, p)
	}
	if hook.reviewer != nil {
		return prepareCockpitArtifactReviewerIssue(ctx, q, p)
	}
	if hook.captured != nil {
		return prepareCockpitArtifactCaptured(ctx, q, p)
	}
	in := hook.submission
	if in == nil {
		return nil, artifactInput("unknown artifact issue command")
	}
	if _, err := lockArtifactWorkspace(ctx, q, in.WorkspaceID, in.ActorID); err != nil {
		return nil, err
	}
	a, err := q.LockCockpitArtifact(ctx, db.LockCockpitArtifactParams{WorkspaceID: in.WorkspaceID, ID: in.ArtifactID})
	if err != nil {
		return nil, cockpitWorkflowError(err)
	}
	hook.artifact = a
	params, existing, err := prepareArtifactSubmission(ctx, q, a, *in, hook.payload, hook.hash)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		hook.version = *existing
		i, err := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: a.WorkspaceID, ID: existing.ReviewIssueID})
		return &i, cockpitWorkflowError(err)
	}
	hook.versionParams = params
	p.Title = fmt.Sprintf("Review artifact: %s · v%d", a.Title, params.VersionNumber)
	p.Description = pgtype.Text{String: fmt.Sprintf("Review the fixed artifact version %s (artifact %s). Submit the formal approved / changes_requested / rejected decision from its artifact reader. Completing or reassigning this Issue does not grant approval authority.", util.UUIDToString(params.ID), util.UUIDToString(a.ID)), Valid: true}
	p.Status = "todo"
	p.Priority = "none"
	p.ProjectID = a.ProjectID
	p.ModuleID = a.ModuleID
	p.AssigneeType = pgtype.Text{String: "member", Valid: true}
	p.AssigneeID = a.ReviewerID
	p.ParentIssueID = pgtype.UUID{}
	p.AllowDuplicate = true
	return nil, nil
}
func linkCockpitArtifactIssue(ctx context.Context, q *db.Queries, p IssueCreateParams, issue db.Issue) error {
	hook := p.CockpitArtifact
	if hook.acceptanceReviewer != nil {
		return linkCockpitAcceptanceReviewerIssue(ctx, q, p, issue)
	}
	if hook.acceptance != nil {
		return linkCockpitAcceptanceIssue(ctx, q, p, issue)
	}
	if hook.producer != nil {
		return linkCockpitArtifactProducerIssue(ctx, q, p, issue)
	}
	if hook.reviewer != nil {
		return linkCockpitArtifactReviewerIssue(ctx, q, p, issue)
	}
	if hook.captured != nil {
		return linkCockpitArtifactCaptured(ctx, q, p, issue)
	}
	hook.versionParams.ReviewIssueID = issue.ID
	v, err := q.CreateCockpitArtifactVersion(ctx, hook.versionParams)
	if err != nil {
		return err
	}
	hook.version = v
	_, err = q.CreateCockpitIssuePrimary(ctx, db.CreateCockpitIssuePrimaryParams{WorkspaceID: issue.WorkspaceID, IssueID: issue.ID, NodeID: hook.artifact.OwnerNodeID, CreatedBy: hook.submission.ActorID})
	if err != nil {
		return err
	}
	if err = retireUnrequestedArtifactCapture(ctx, q, hook.artifact); err != nil {
		return err
	}
	hook.artifact, err = q.SetCockpitArtifactCurrentVersion(ctx, db.SetCockpitArtifactCurrentVersionParams{WorkspaceID: issue.WorkspaceID, ID: hook.artifact.ID, CurrentVersionID: v.ID})
	return err
}
func (s *IssueService) ReviewCockpitArtifactVersion(ctx context.Context, p CockpitArtifactReview) error {
	if !p.Human {
		return ErrCockpitWorkflowForbidden
	}
	p.Feedback = strings.TrimSpace(p.Feedback)
	// Probe before taking business locks. The transaction verifies the same fixed
	// version, revision and content fingerprint again before recording approval.
	var proof db.CockpitArtifactVersion
	if p.Decision == "approved" {
		v, err := s.Queries.GetCockpitArtifactVersion(ctx, db.GetCockpitArtifactVersionParams{WorkspaceID: p.WorkspaceID, ArtifactID: p.ArtifactID, ID: p.VersionID})
		if err != nil {
			return cockpitWorkflowError(err)
		}
		if v.ReviewerID != p.ActorID {
			return ErrCockpitWorkflowForbidden
		}
		proof = v
		replay := v.Decision == p.Decision && v.Feedback == p.Feedback && v.ReviewedBy == p.ActorID
		if !replay {
			if v.CaptureStatus != "ready" {
				return artifactConflict("the fixed content is not ready")
			}
			if v.PayloadKind == "text" {
				if !v.Content.Valid || minutesContentHash(v.Content.String) != v.ContentHash.String {
					return artifactConflict("the fixed content does not match its fingerprint")
				}
			} else {
				if s.CockpitArtifactCapturer == nil {
					return ErrCockpitArtifactPrivateStorageRequired
				}
				if err = s.probeArtifactFile(ctx, v.StorageKey.String, v.SizeBytes.Int64, v.ContentHash.String); err != nil {
					if errors.Is(err, ErrCockpitArtifactVerificationTimeout) || errors.Is(err, ErrCockpitArtifactPrivateStorageRequired) || errors.Is(err, context.Canceled) {
						return err
					}
					return artifactConflict("fixed content is unavailable; restore access or return it for revision")
				}
			}
		}
	}
	tx, q, a, _, err := s.beginArtifact(ctx, p.CockpitArtifactCommand)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	v, err := q.LockCockpitArtifactVersion(ctx, db.LockCockpitArtifactVersionParams{WorkspaceID: p.WorkspaceID, ArtifactID: p.ArtifactID, ID: p.VersionID})
	if err != nil {
		return cockpitWorkflowError(err)
	}
	feedback, replay, err := validateCockpitFormalReview(cockpitFormalReviewFacts{Revision: v.Revision, ReviewerID: util.UUIDToString(v.ReviewerID), ReviewedBy: util.UUIDToString(v.ReviewedBy), Decision: v.Decision, Feedback: v.Feedback, Ready: v.CaptureStatus == "ready", Current: a.CurrentVersionID == v.ID && !a.ArchivedAt.Valid, ReviewIssueID: util.UUIDToString(v.ReviewIssueID)}, util.UUIDToString(p.ActorID), p.Human, p.ExpectedRevision, p.Decision, p.Feedback)
	if err != nil {
		return err
	}
	if replay {
		return nil
	}
	if p.Decision == "approved" && (proof.Revision != v.Revision || proof.ContentHash != v.ContentHash || proof.StorageKey != v.StorageKey) {
		return artifactConflict("the reviewed version changed during content verification")
	}
	review, err := q.LockIssueForDescriptionUpdate(ctx, db.LockIssueForDescriptionUpdateParams{WorkspaceID: a.WorkspaceID, ID: v.ReviewIssueID})
	if err != nil {
		return cockpitWorkflowError(err)
	}
	if _, err = q.ReviewCockpitArtifactVersion(ctx, db.ReviewCockpitArtifactVersionParams{WorkspaceID: a.WorkspaceID, ArtifactID: a.ID, ID: v.ID, Decision: p.Decision, Feedback: feedback, ReviewedBy: p.ActorID}); err != nil {
		return err
	}
	if p.Decision == "approved" {
		a, err = q.SetCockpitArtifactApprovedVersion(ctx, db.SetCockpitArtifactApprovedVersionParams{WorkspaceID: a.WorkspaceID, ID: a.ID, ApprovedVersionID: v.ID})
	} else {
		a, err = q.SetCockpitArtifactCurrentVersion(ctx, db.SetCockpitArtifactCurrentVersionParams{WorkspaceID: a.WorkspaceID, ID: a.ID, CurrentVersionID: v.ID})
	}
	if err != nil {
		return err
	}
	updated, err := q.UpdateIssueStatus(ctx, db.UpdateIssueStatusParams{WorkspaceID: a.WorkspaceID, ID: review.ID, Status: "done"})
	if err != nil {
		return err
	}
	cancelled, err := StopClosedIssueWakeups(ctx, q, updated)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.publishCockpitWorkflowIssueUpdate(ctx, updated, p.ActorID, review.Status)
	if s.TaskService != nil {
		for _, task := range cancelled {
			s.TaskService.broadcastTaskEvent(ctx, protocol.EventTaskCancelled, task)
		}
	}
	s.artifactChanged(a, p.ActorID)
	return nil
}

func retireUnrequestedArtifactCapture(ctx context.Context, q *db.Queries, a db.CockpitArtifact) error {
	if !a.CurrentVersionID.Valid {
		return nil
	}
	v, err := q.GetCockpitArtifactVersion(ctx, db.GetCockpitArtifactVersionParams{WorkspaceID: a.WorkspaceID, ArtifactID: a.ID, ID: a.CurrentVersionID})
	if err != nil {
		return err
	}
	if v.CaptureStatus == "needs_attention" && v.Decision == "not_requested" {
		return q.QueueCockpitArtifactAttemptCleanup(ctx, db.QueueCockpitArtifactAttemptCleanupParams{WorkspaceID: a.WorkspaceID, VersionID: v.ID})
	}
	return nil
}

func recordArtifactActivity(ctx context.Context, q *db.Queries, a db.CockpitArtifact, actor pgtype.UUID, action string, extra map[string]any) error {
	details := map[string]any{"artifact_id": util.UUIDToString(a.ID), "artifact_title": a.Title, "revision": a.Revision}
	for key, value := range extra {
		details[key] = value
	}
	body, err := json.Marshal(details)
	if err != nil {
		return err
	}
	_, err = q.CreateActivity(ctx, db.CreateActivityParams{ID: dbid.NewV7(), WorkspaceID: a.WorkspaceID, IssueID: a.SourceIssueID, ActorType: pgtype.Text{String: "member", Valid: true}, ActorID: actor, Action: action, Details: body})
	return err
}
