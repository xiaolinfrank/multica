package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/storage"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func acceptanceManager(d db.CockpitAcceptanceDefinition, actor pgtype.UUID, role string, human bool) bool {
	return human && (role == "owner" || role == "admin" || d.CreatedBy.Valid && d.CreatedBy == actor)
}
func (s *IssueService) acceptanceChanged(ws, node, actor pgtype.UUID) {
	s.planningChanged(ws, actor, "acceptance", map[string]any{"id": util.UUIDToString(node), "node_id": util.UUIDToString(node)})
}
func (s *IssueService) SaveCockpitAcceptanceCriteria(ctx context.Context, p CockpitAcceptanceCriteriaCommand) (CockpitAcceptanceCriteriaView, error) {
	if !p.Human {
		return CockpitAcceptanceCriteriaView{}, ErrCockpitWorkflowForbidden
	}
	items, err := NormalizeCockpitAcceptanceCriteria(p.Criteria)
	if err != nil {
		return CockpitAcceptanceCriteriaView{}, err
	}
	p.Criteria = items
	hash := planningHash(p)
	tx, err := s.TxStarter.Begin(ctx)
	if err != nil {
		return CockpitAcceptanceCriteriaView{}, err
	}
	defer tx.Rollback(ctx)
	q := s.Queries.WithTx(tx)
	m, err := lockArtifactWorkspace(ctx, q, p.WorkspaceID, p.ActorID)
	if err != nil {
		return CockpitAcceptanceCriteriaView{}, err
	}
	if _, _, _, err = requireExecutionLeaf(ctx, q, p.WorkspaceID, p.NodeID); err != nil {
		return CockpitAcceptanceCriteriaView{}, err
	}
	d, err := q.LockCockpitAcceptanceDefinition(ctx, db.LockCockpitAcceptanceDefinitionParams{WorkspaceID: p.WorkspaceID, NodeID: p.NodeID})
	missing := errors.Is(err, pgx.ErrNoRows)
	if err != nil && !missing {
		return CockpitAcceptanceCriteriaView{}, err
	}
	if !acceptanceManager(d, p.ActorID, m.Role, p.Human) {
		return CockpitAcceptanceCriteriaView{}, ErrCockpitWorkflowForbidden
	}
	if !missing && d.LastRequestHash == hash && d.LastUpdatedBy == p.ActorID && d.Revision == p.ExpectedRevision+1 {
		_ = tx.Rollback(ctx)
		return s.GetCockpitAcceptanceCriteria(ctx, CockpitAcceptanceRead{WorkspaceID: p.WorkspaceID, ActorID: p.ActorID, NodeID: p.NodeID, Human: p.Human})
	}
	if missing {
		if p.ExpectedRevision != 0 {
			return CockpitAcceptanceCriteriaView{}, ErrCockpitWorkflowConflict
		}
		d, err = q.CreateCockpitAcceptanceDefinition(ctx, db.CreateCockpitAcceptanceDefinitionParams{WorkspaceID: p.WorkspaceID, NodeID: p.NodeID, CreatedBy: p.ActorID, LastRequestHash: hash})
	} else {
		if err = artifactExpected(d.Revision, p.ExpectedRevision); err != nil {
			return CockpitAcceptanceCriteriaView{}, err
		}
		d, err = q.UpdateCockpitAcceptanceDefinition(ctx, db.UpdateCockpitAcceptanceDefinitionParams{WorkspaceID: p.WorkspaceID, NodeID: p.NodeID, LastUpdatedBy: p.ActorID, LastRequestHash: hash})
	}
	if err != nil {
		return CockpitAcceptanceCriteriaView{}, err
	}
	ids := make([]pgtype.UUID, 0, len(items))
	for index, item := range items {
		id, _ := util.ParseUUID(item.ID)
		ids = append(ids, id)
		if _, err = q.UpsertCockpitAcceptanceCriterion(ctx, db.UpsertCockpitAcceptanceCriterionParams{ID: id, WorkspaceID: p.WorkspaceID, NodeID: p.NodeID, Title: item.Title, Description: item.Description, Position: int32(index)}); err != nil {
			return CockpitAcceptanceCriteriaView{}, cockpitWorkflowError(err)
		}
	}
	if err = q.RetireCockpitAcceptanceCriteria(ctx, db.RetireCockpitAcceptanceCriteriaParams{WorkspaceID: p.WorkspaceID, NodeID: p.NodeID, Column3: ids}); err != nil {
		return CockpitAcceptanceCriteriaView{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return CockpitAcceptanceCriteriaView{}, err
	}
	s.acceptanceChanged(p.WorkspaceID, p.NodeID, p.ActorID)
	return s.GetCockpitAcceptanceCriteria(ctx, CockpitAcceptanceRead{WorkspaceID: p.WorkspaceID, ActorID: p.ActorID, NodeID: p.NodeID, Human: p.Human})
}
func acceptanceEvidenceIDs(evidence []CockpitAcceptanceEvidenceInput) []pgtype.UUID {
	seen := map[pgtype.UUID]bool{}
	ids := []pgtype.UUID{}
	for _, e := range evidence {
		for _, raw := range e.VersionIDs {
			id, _ := util.ParseUUID(raw)
			if !seen[id] {
				seen[id] = true
				ids = append(ids, id)
			}
		}
	}
	return ids
}
func acceptanceSourcesCurrent(rows []db.ListCockpitAcceptanceVersionSourcesRow, ids []pgtype.UUID) error {
	if len(rows) != len(ids) {
		return artifactConflict("one or more evidence versions are unavailable")
	}
	for _, v := range rows {
		if v.ID != v.ApprovedVersionID || !v.Eligible || v.Decision != "approved" || v.CaptureStatus != "ready" || !v.ContentHash.Valid {
			return artifactConflict("use the current approved version owned by or explicitly referenced from this L3")
		}
	}
	return nil
}
func acceptanceProofFingerprint(rows []db.ListCockpitAcceptanceVersionSourcesRow) string {
	byID := map[string]any{}
	for _, v := range rows {
		byID[util.UUIDToString(v.ID)] = []any{v.ArtifactID, v.ContentHash.String, v.StorageKey.String, v.SizeBytes.Int64, v.ApprovedVersionID, v.Eligible}
	}
	return planningHash(byID)
}
func (s *IssueService) probeAcceptanceSources(ctx context.Context, rows []db.ListCockpitAcceptanceVersionSourcesRow) error {
	bounded, cancel := s.artifactProbeContext(ctx)
	defer cancel()
	ctx = bounded
	for _, v := range rows {
		if err := ctx.Err(); err != nil {
			return artifactProbeError(ctx, err)
		}
		if v.CaptureStatus != "ready" || !v.ContentHash.Valid {
			return artifactConflict("fixed evidence is not ready")
		}
		if v.PayloadKind == "text" {
			if !v.Content.Valid || minutesContentHash(v.Content.String) != v.ContentHash.String {
				return artifactConflict("fixed evidence content does not match its fingerprint")
			}
		} else {
			if s.CockpitArtifactCapturer == nil || !storage.SupportsPrivateArtifactFiles(s.CockpitArtifactCapturer.Store) {
				return ErrCockpitArtifactPrivateStorageRequired
			}
			if err := s.CockpitArtifactCapturer.Verify(ctx, v.StorageKey.String, v.SizeBytes.Int64, v.ContentHash.String); err != nil {
				if probeErr := artifactProbeError(ctx, err); errors.Is(probeErr, ErrCockpitArtifactVerificationTimeout) || errors.Is(probeErr, context.Canceled) {
					return probeErr
				}
				return artifactConflict("fixed evidence is unavailable; restore access or return the acceptance request for revision")
			}
		}
	}
	return nil
}
func acceptanceRequestHash(p CockpitAcceptanceRequestCommand) string { return planningHash(p) }
func (s *IssueService) CreateCockpitAcceptanceRequest(ctx context.Context, p CockpitAcceptanceRequestCommand, opts IssueCreateOpts) (CockpitAcceptanceRequestDetail, error) {
	if !p.Human {
		return CockpitAcceptanceRequestDetail{}, ErrCockpitWorkflowForbidden
	}
	if !p.RequestKey.Valid || !p.ReviewerID.Valid {
		return CockpitAcceptanceRequestDetail{}, ErrCockpitWorkflowInput
	}
	var err error
	p.Evidence, err = NormalizeCockpitAcceptanceEvidence(p.Evidence)
	if err != nil {
		return CockpitAcceptanceRequestDetail{}, err
	}
	p.Note = strings.TrimSpace(p.Note)
	if len(p.Note) > 16000 || !utf8.ValidString(p.Note) {
		return CockpitAcceptanceRequestDetail{}, artifactInput("note is limited to 16000 UTF-8 bytes")
	}
	read := CockpitAcceptanceRead{WorkspaceID: p.WorkspaceID, ActorID: p.ActorID, NodeID: p.NodeID, Human: p.Human}
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return CockpitAcceptanceRequestDetail{}, err
	}
	defer tx.Rollback(ctx)
	m, err := artifactReadMember(ctx, q, CockpitArtifactRead{WorkspaceID: p.WorkspaceID, ActorID: p.ActorID})
	if err != nil {
		return CockpitAcceptanceRequestDetail{}, err
	}
	d, err := q.GetCockpitAcceptanceDefinition(ctx, db.GetCockpitAcceptanceDefinitionParams{WorkspaceID: p.WorkspaceID, NodeID: p.NodeID})
	if err != nil {
		return CockpitAcceptanceRequestDetail{}, cockpitWorkflowError(err)
	}

	old, err := q.GetCockpitAcceptanceRequestByKey(ctx, db.GetCockpitAcceptanceRequestByKeyParams{WorkspaceID: p.WorkspaceID, NodeID: p.NodeID, RequestKey: p.RequestKey})
	if err == nil {
		if old.RequestHash != acceptanceRequestHash(p) || old.CreatedBy != p.ActorID {
			return CockpitAcceptanceRequestDetail{}, ErrCockpitWorkflowConflict
		}
		read.RequestID = old.ID
		_ = tx.Rollback(ctx)
		return s.GetCockpitAcceptanceRequest(ctx, read)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return CockpitAcceptanceRequestDetail{}, err
	}
	if !acceptanceManager(d, p.ActorID, m.Role, p.Human) {
		return CockpitAcceptanceRequestDetail{}, ErrCockpitWorkflowForbidden
	}
	ids := acceptanceEvidenceIDs(p.Evidence)
	sources, err := q.ListCockpitAcceptanceVersionSources(ctx, db.ListCockpitAcceptanceVersionSourcesParams{WorkspaceID: p.WorkspaceID, NodeID: p.NodeID, VersionIds: ids})
	if err != nil {
		return CockpitAcceptanceRequestDetail{}, err
	}
	if err = acceptanceSourcesCurrent(sources, ids); err != nil {
		return CockpitAcceptanceRequestDetail{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return CockpitAcceptanceRequestDetail{}, err
	}
	if err = s.probeAcceptanceSources(ctx, sources); err != nil {
		return CockpitAcceptanceRequestDetail{}, err
	}
	hook := &cockpitArtifactIssue{acceptance: &p, acceptanceProof: acceptanceProofFingerprint(sources)}
	_, err = s.Create(ctx, IssueCreateParams{WorkspaceID: p.WorkspaceID, CreatorID: p.ActorID, CreatorType: "member", CockpitArtifact: hook}, opts)
	if err != nil {
		return CockpitAcceptanceRequestDetail{}, err
	}
	read.RequestID = hook.acceptanceRequest.ID
	s.finalizeAcceptanceRetired(ctx, hook, p.ActorID, p.WorkspaceID)
	s.acceptanceChanged(p.WorkspaceID, p.NodeID, p.ActorID)
	return s.GetCockpitAcceptanceRequest(ctx, read)
}
func acceptanceRequestStale(ctx context.Context, q *db.Queries, d db.CockpitAcceptanceDefinition, r db.CockpitAcceptanceRequest) (bool, error) {
	if r.CriteriaRevision != d.Revision {
		return true, nil
	}
	rows, err := q.ListCockpitAcceptanceEvidence(ctx, db.ListCockpitAcceptanceEvidenceParams{WorkspaceID: d.WorkspaceID, NodeID: d.NodeID, RequestID: r.ID})
	if err != nil {
		return false, err
	}
	if len(rows) == 0 {
		return true, nil
	}
	for _, e := range rows {
		if e.VersionID != e.ApprovedVersionID || !e.Eligible {
			return true, nil
		}
	}
	return false, nil
}
func prepareCockpitAcceptanceIssue(ctx context.Context, q *db.Queries, p *IssueCreateParams) (*db.Issue, error) {
	h := p.CockpitArtifact
	in := *h.acceptance
	m, err := lockArtifactWorkspace(ctx, q, in.WorkspaceID, in.ActorID)
	if err != nil {
		return nil, err
	}
	node, project, module, err := requireExecutionLeaf(ctx, q, in.WorkspaceID, in.NodeID)
	if err != nil {
		return nil, err
	}
	d, err := q.LockCockpitAcceptanceDefinition(ctx, db.LockCockpitAcceptanceDefinitionParams{WorkspaceID: in.WorkspaceID, NodeID: in.NodeID})
	if err != nil {
		return nil, cockpitWorkflowError(err)
	}

	h.acceptanceDefinition = d
	old, err := q.GetCockpitAcceptanceRequestByKey(ctx, db.GetCockpitAcceptanceRequestByKeyParams{WorkspaceID: in.WorkspaceID, NodeID: in.NodeID, RequestKey: in.RequestKey})
	if err == nil {
		if old.RequestHash != acceptanceRequestHash(in) || old.CreatedBy != in.ActorID {
			return nil, ErrCockpitWorkflowConflict
		}
		h.acceptanceRequest = old
		i, e := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: in.WorkspaceID, ID: old.ReviewIssueID})
		return &i, cockpitWorkflowError(e)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if !acceptanceManager(d, in.ActorID, m.Role, in.Human) {
		return nil, ErrCockpitWorkflowForbidden
	}
	if err = artifactExpected(d.Revision, in.ExpectedCriteriaRevision); err != nil {
		return nil, err
	}
	if err = artifactReviewer(ctx, q, in.WorkspaceID, in.ReviewerID); err != nil {
		return nil, err
	}
	criteria, err := q.ListCockpitAcceptanceCriteria(ctx, db.ListCockpitAcceptanceCriteriaParams{WorkspaceID: in.WorkspaceID, NodeID: in.NodeID})
	if err != nil {
		return nil, err
	}
	if len(criteria) == 0 || len(criteria) != len(in.Evidence) {
		return nil, artifactConflict("provide evidence for every current acceptance criterion")
	}
	set := map[string]bool{}
	for _, c := range criteria {
		set[util.UUIDToString(c.ID)] = true
	}
	for _, e := range in.Evidence {
		if !set[e.CriterionID] {
			return nil, artifactConflict("the acceptance criteria changed")
		}
	}
	ids := acceptanceEvidenceIDs(in.Evidence)
	sources, err := q.ListCockpitAcceptanceVersionSources(ctx, db.ListCockpitAcceptanceVersionSourcesParams{WorkspaceID: in.WorkspaceID, NodeID: in.NodeID, VersionIds: ids})
	if err != nil {
		return nil, err
	}
	if err = acceptanceSourcesCurrent(sources, ids); err != nil {
		return nil, err
	}
	if acceptanceProofFingerprint(sources) != h.acceptanceProof {
		return nil, artifactConflict("evidence changed while its content was verified")
	}
	h.acceptanceSources = sources
	h.acceptanceCriteria = criteria
	if d.CurrentRequestID.Valid {
		current, e := q.GetCockpitAcceptanceRequest(ctx, db.GetCockpitAcceptanceRequestParams{WorkspaceID: in.WorkspaceID, NodeID: in.NodeID, ID: d.CurrentRequestID})
		if e != nil {
			return nil, e
		}
		stale, e := acceptanceRequestStale(ctx, q, d, current)
		if e != nil {
			return nil, e
		}
		if e = validateCockpitAcceptanceReplacement(util.UUIDToString(current.ID), current.Decision, stale, util.UUIDToString(in.SupersedesRequestID)); e != nil {
			return nil, e
		}
		if current.Decision == "pending" {
			h.supersededRequest = current
			i, e := q.LockIssueForDescriptionUpdate(ctx, db.LockIssueForDescriptionUpdateParams{WorkspaceID: in.WorkspaceID, ID: current.ReviewIssueID})
			if e != nil {
				return nil, e
			}
			h.retiredPreviousStatus = i.Status
		}
	} else if in.SupersedesRequestID.Valid {
		return nil, ErrCockpitWorkflowConflict
	}
	h.acceptanceRequest = db.CockpitAcceptanceRequest{ID: dbid.NewV7()}
	p.Title = "Accept L3: " + node.Name
	p.Description = pgtype.Text{String: fmt.Sprintf("Review the fixed acceptance request %s for L3 %s. Verify its criteria and exact approved artifact evidence, then record a formal decision in the acceptance reader.", util.UUIDToString(h.acceptanceRequest.ID), util.UUIDToString(node.ID)), Valid: true}
	p.Status = "todo"
	p.Priority = "none"
	p.ProjectID = project
	p.ModuleID = module
	p.AssigneeType = pgtype.Text{String: "member", Valid: true}
	p.AssigneeID = in.ReviewerID
	p.ParentIssueID = pgtype.UUID{}
	p.AllowDuplicate = true
	return nil, nil
}
func linkCockpitAcceptanceIssue(ctx context.Context, q *db.Queries, p IssueCreateParams, issue db.Issue) error {
	h := p.CockpitArtifact
	in := *h.acceptance
	fingerprint := planningHash([]any{h.acceptanceDefinition.Revision, h.acceptanceCriteria, in.Evidence, h.acceptanceProof})
	r, err := q.CreateCockpitAcceptanceRequest(ctx, db.CreateCockpitAcceptanceRequestParams{ID: h.acceptanceRequest.ID, WorkspaceID: in.WorkspaceID, NodeID: in.NodeID, RequestKey: in.RequestKey, RequestHash: acceptanceRequestHash(in), CriteriaRevision: h.acceptanceDefinition.Revision, EvidenceHash: fingerprint, ReviewerID: in.ReviewerID, ReviewIssueID: issue.ID, Note: in.Note, SupersedesRequestID: in.SupersedesRequestID, CreatedBy: in.ActorID})
	if err != nil {
		return err
	}
	h.acceptanceRequest = r
	for _, c := range h.acceptanceCriteria {
		if err = q.CreateCockpitAcceptanceRequestCriterion(ctx, db.CreateCockpitAcceptanceRequestCriterionParams{WorkspaceID: in.WorkspaceID, RequestID: r.ID, CriterionID: c.ID, Title: c.Title, Description: c.Description, Position: c.Position, Revision: c.Revision}); err != nil {
			return err
		}
	}
	byID := map[string]db.ListCockpitAcceptanceVersionSourcesRow{}
	for _, v := range h.acceptanceSources {
		byID[util.UUIDToString(v.ID)] = v
	}
	for _, e := range in.Evidence {
		criterion, _ := util.ParseUUID(e.CriterionID)
		for _, id := range e.VersionIDs {
			v := byID[id]
			if err = q.CreateCockpitAcceptanceEvidence(ctx, db.CreateCockpitAcceptanceEvidenceParams{WorkspaceID: in.WorkspaceID, RequestID: r.ID, CriterionID: criterion, VersionID: v.ID, ArtifactID: v.ArtifactID, ContentHash: v.ContentHash.String}); err != nil {
				return err
			}
		}
	}
	if _, err = q.CreateCockpitIssuePrimary(ctx, db.CreateCockpitIssuePrimaryParams{WorkspaceID: in.WorkspaceID, IssueID: issue.ID, NodeID: in.NodeID, CreatedBy: in.ActorID}); err != nil {
		return err
	}
	if h.supersededRequest.ID.Valid {
		if _, err = q.SupersedeCockpitAcceptanceRequest(ctx, db.SupersedeCockpitAcceptanceRequestParams{WorkspaceID: in.WorkspaceID, NodeID: in.NodeID, ID: h.supersededRequest.ID, SupersededByRequestID: r.ID}); err != nil {
			return err
		}
		h.retired, err = q.UpdateIssueStatus(ctx, db.UpdateIssueStatusParams{WorkspaceID: in.WorkspaceID, ID: h.supersededRequest.ReviewIssueID, Status: "cancelled"})
		if err != nil {
			return err
		}
		h.cancelled, err = StopClosedIssueWakeups(ctx, q, h.retired)
		if err != nil {
			return err
		}
	}
	_, err = q.SetCockpitAcceptanceCurrentRequest(ctx, db.SetCockpitAcceptanceCurrentRequestParams{WorkspaceID: in.WorkspaceID, NodeID: in.NodeID, CurrentRequestID: r.ID})
	return err
}
func (s *IssueService) finalizeAcceptanceRetired(ctx context.Context, h *cockpitArtifactIssue, actor, ws pgtype.UUID) {
	if !h.retired.ID.Valid {
		return
	}
	s.publishCockpitWorkflowIssueUpdate(ctx, h.retired, actor, h.retiredPreviousStatus)
	if s.TaskService != nil {
		s.TaskService.FinalizeIssueTaskCancellations(ctx, util.UUIDToString(ws), h.cancelled)
	}
}

// CockpitAcceptanceApprovalRevoke is the R2 reverse command for a recorded
// acceptance approval: it withdraws the definition's approved pointer and
// records the re-decision, while the historical request rows keep their
// formal decisions.
type CockpitAcceptanceApprovalRevoke struct {
	WorkspaceID, ActorID, NodeID, RequestID pgtype.UUID
	Human                                   bool
	Reason                                  string
}

func (s *IssueService) RevokeCockpitAcceptanceApproval(ctx context.Context, p CockpitAcceptanceApprovalRevoke) error {
	if !p.Human {
		return ErrCockpitWorkflowForbidden
	}
	reason, err := artifactReason(p.Reason)
	if err != nil {
		return err
	}
	tx, err := s.TxStarter.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	q := s.Queries.WithTx(tx)
	m, err := lockArtifactWorkspace(ctx, q, p.WorkspaceID, p.ActorID)
	if err != nil {
		return err
	}
	d, err := q.LockCockpitAcceptanceDefinition(ctx, db.LockCockpitAcceptanceDefinitionParams{WorkspaceID: p.WorkspaceID, NodeID: p.NodeID})
	if err != nil {
		return cockpitWorkflowError(err)
	}
	if !acceptanceManager(d, p.ActorID, m.Role, p.Human) {
		return ErrCockpitWorkflowForbidden
	}
	// The guarded UPDATE is the compare-and-swap: zero rows mean the request
	// is not the approval currently in force (already revoked, superseded by a
	// later approval, or never approved).
	if _, err = q.RevokeCockpitAcceptanceApproval(ctx, db.RevokeCockpitAcceptanceApprovalParams{WorkspaceID: p.WorkspaceID, NodeID: p.NodeID, RequestID: p.RequestID, ActorID: p.ActorID, Reason: reason}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return artifactConflict("the request is not the acceptance approval currently in force")
		}
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.acceptanceChanged(p.WorkspaceID, p.NodeID, p.ActorID)
	return nil
}
func (s *IssueService) ReviewCockpitAcceptanceRequest(ctx context.Context, p CockpitAcceptanceReview) error {
	if !p.Human {
		return ErrCockpitWorkflowForbidden
	}
	p.Feedback = strings.TrimSpace(p.Feedback)
	var proof string
	if p.Decision == "approved" {
		tx, q, err := s.beginPlanningRead(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		if err = cockpitWorkflowMember(ctx, q, p.WorkspaceID, p.ActorID); err != nil {
			return err
		}
		r, err := q.GetCockpitAcceptanceRequest(ctx, db.GetCockpitAcceptanceRequestParams{WorkspaceID: p.WorkspaceID, NodeID: p.NodeID, ID: p.RequestID})
		if err != nil {
			return cockpitWorkflowError(err)
		}
		if r.ReviewerID != p.ActorID {
			return ErrCockpitWorkflowForbidden
		}
		if !(r.Decision == "approved" && r.ReviewedBy == p.ActorID && r.Feedback == p.Feedback) {
			d, e := q.GetCockpitAcceptanceDefinition(ctx, db.GetCockpitAcceptanceDefinitionParams{WorkspaceID: p.WorkspaceID, NodeID: p.NodeID})
			if e != nil {
				return e
			}
			stale, e := acceptanceRequestStale(ctx, q, d, r)
			if e != nil {
				return e
			}
			if stale {
				return artifactConflict("acceptance conditions or current approved evidence changed; replace the request")
			}
			evidence, e := q.ListCockpitAcceptanceEvidence(ctx, db.ListCockpitAcceptanceEvidenceParams{WorkspaceID: p.WorkspaceID, NodeID: p.NodeID, RequestID: r.ID})
			if e != nil {
				return e
			}
			ids := []pgtype.UUID{}
			seen := map[pgtype.UUID]bool{}
			for _, row := range evidence {
				if !seen[row.VersionID] {
					ids = append(ids, row.VersionID)
					seen[row.VersionID] = true
				}
			}
			sources, e := q.ListCockpitAcceptanceVersionSources(ctx, db.ListCockpitAcceptanceVersionSourcesParams{WorkspaceID: p.WorkspaceID, NodeID: p.NodeID, VersionIds: ids})
			if e != nil {
				return e
			}
			if e = acceptanceSourcesCurrent(sources, ids); e != nil {
				return e
			}
			proof = acceptanceProofFingerprint(sources)
			if err = tx.Commit(ctx); err != nil {
				return err
			}
			if err = s.probeAcceptanceSources(ctx, sources); err != nil {
				return err
			}
		} else {
			_ = tx.Rollback(ctx)
		}
	}
	tx, err := s.TxStarter.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	q := s.Queries.WithTx(tx)
	if _, err = lockArtifactWorkspace(ctx, q, p.WorkspaceID, p.ActorID); err != nil {
		return err
	}
	d, err := q.LockCockpitAcceptanceDefinition(ctx, db.LockCockpitAcceptanceDefinitionParams{WorkspaceID: p.WorkspaceID, NodeID: p.NodeID})
	if err != nil {
		return cockpitWorkflowError(err)
	}
	r, err := q.GetCockpitAcceptanceRequest(ctx, db.GetCockpitAcceptanceRequestParams{WorkspaceID: p.WorkspaceID, NodeID: p.NodeID, ID: p.RequestID})
	if err != nil {
		return cockpitWorkflowError(err)
	}
	feedback, replay, err := validateCockpitFormalReview(cockpitFormalReviewFacts{Revision: r.Revision, ReviewerID: util.UUIDToString(r.ReviewerID), ReviewedBy: util.UUIDToString(r.ReviewedBy), Decision: r.Decision, Feedback: r.Feedback, Ready: true, Current: d.CurrentRequestID == r.ID, Superseded: r.SupersededAt.Valid, ReviewIssueID: util.UUIDToString(r.ReviewIssueID)}, util.UUIDToString(p.ActorID), p.Human, p.ExpectedRevision, p.Decision, p.Feedback)
	if err != nil {
		return err
	}
	if replay {
		return nil
	}
	if p.Decision == "approved" {
		stale, e := acceptanceRequestStale(ctx, q, d, r)
		if e != nil {
			return e
		}
		if stale {
			return artifactConflict("acceptance evidence changed during verification")
		}
		evidence, e := q.ListCockpitAcceptanceEvidence(ctx, db.ListCockpitAcceptanceEvidenceParams{WorkspaceID: p.WorkspaceID, NodeID: p.NodeID, RequestID: r.ID})
		if e != nil {
			return e
		}
		ids := []pgtype.UUID{}
		seen := map[pgtype.UUID]bool{}
		for _, row := range evidence {
			if !seen[row.VersionID] {
				ids = append(ids, row.VersionID)
				seen[row.VersionID] = true
			}
		}
		sources, e := q.ListCockpitAcceptanceVersionSources(ctx, db.ListCockpitAcceptanceVersionSourcesParams{WorkspaceID: p.WorkspaceID, NodeID: p.NodeID, VersionIds: ids})
		if e != nil {
			return e
		}
		if proof == "" || proof != acceptanceProofFingerprint(sources) {
			return artifactConflict("acceptance content changed during verification")
		}
	}
	old, err := q.LockIssueForDescriptionUpdate(ctx, db.LockIssueForDescriptionUpdateParams{WorkspaceID: p.WorkspaceID, ID: r.ReviewIssueID})
	if err != nil {
		return cockpitWorkflowError(err)
	}
	if _, err = q.ReviewCockpitAcceptanceRequest(ctx, db.ReviewCockpitAcceptanceRequestParams{WorkspaceID: p.WorkspaceID, NodeID: p.NodeID, ID: r.ID, Decision: p.Decision, Feedback: feedback, ReviewedBy: p.ActorID}); err != nil {
		return err
	}
	if p.Decision == "approved" {
		if _, err = q.SetCockpitAcceptanceApprovedRequest(ctx, db.SetCockpitAcceptanceApprovedRequestParams{WorkspaceID: p.WorkspaceID, NodeID: p.NodeID, LastApprovedRequestID: r.ID}); err != nil {
			return err
		}
	}
	updated, err := q.UpdateIssueStatus(ctx, db.UpdateIssueStatusParams{WorkspaceID: p.WorkspaceID, ID: r.ReviewIssueID, Status: "done"})
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
	s.publishCockpitWorkflowIssueUpdate(ctx, updated, p.ActorID, old.Status)
	if s.TaskService != nil {
		for _, task := range cancelled {
			s.TaskService.broadcastTaskEvent(ctx, protocol.EventTaskCancelled, task)
		}
	}
	s.acceptanceChanged(p.WorkspaceID, p.NodeID, p.ActorID)
	return nil
}
