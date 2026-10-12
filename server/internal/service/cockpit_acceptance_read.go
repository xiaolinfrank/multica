package service

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"time"
)

func acceptanceCriterionView(c db.CockpitAcceptanceCriterion) CockpitAcceptanceCriterionView {
	return CockpitAcceptanceCriterionView{ID: util.UUIDToString(c.ID), Title: c.Title, Description: c.Description, Revision: c.Revision, Position: c.Position}
}
func acceptanceMetadata(r db.CockpitAcceptanceRequest, d db.CockpitAcceptanceDefinition, issue CockpitIssueSummary, p CockpitAcceptanceRead) CockpitAcceptanceRequestMetadata {
	return CockpitAcceptanceRequestMetadata{ID: util.UUIDToString(r.ID), NodeID: util.UUIDToString(r.NodeID), RequestKey: util.UUIDToString(r.RequestKey), Revision: r.Revision, CriteriaRevision: r.CriteriaRevision, EvidenceHash: r.EvidenceHash, ReviewerID: util.UUIDToString(r.ReviewerID), ReviewIssue: issue, Decision: r.Decision, HasFeedback: r.Feedback != "", CreatedBy: util.UUIDToString(r.CreatedBy), CreatedAt: r.CreatedAt.Time.UTC().Format(time.RFC3339Nano), ReviewedAt: timestamp(r.ReviewedAt), CanReview: p.Human && r.ReviewerID == p.ActorID && r.Decision == "pending" && !r.SupersededAt.Valid && d.CurrentRequestID == r.ID, SupersedesRequestID: planningUUID(r.SupersedesRequestID), SupersededAt: timestamp(r.SupersededAt)}
}
func acceptanceReadContext(ctx context.Context, q *db.Queries, p CockpitAcceptanceRead) (db.Member, db.CockpitAcceptanceDefinition, error) {
	m, err := artifactReadMember(ctx, q, CockpitArtifactRead{WorkspaceID: p.WorkspaceID, ActorID: p.ActorID})
	if err != nil {
		return m, db.CockpitAcceptanceDefinition{}, err
	}
	if _, err = q.GetCockpitNode(ctx, db.GetCockpitNodeParams{WorkspaceID: p.WorkspaceID, ID: p.NodeID}); err != nil {
		return m, db.CockpitAcceptanceDefinition{}, cockpitWorkflowError(err)
	}
	d, err := q.GetCockpitAcceptanceDefinition(ctx, db.GetCockpitAcceptanceDefinitionParams{WorkspaceID: p.WorkspaceID, NodeID: p.NodeID})
	if errors.Is(err, pgx.ErrNoRows) {
		d = db.CockpitAcceptanceDefinition{WorkspaceID: p.WorkspaceID, NodeID: p.NodeID}
		err = nil
	}
	return m, d, err
}
func (s *IssueService) GetCockpitAcceptanceCriteria(ctx context.Context, p CockpitAcceptanceRead) (CockpitAcceptanceCriteriaView, error) {
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return CockpitAcceptanceCriteriaView{}, err
	}
	defer tx.Rollback(ctx)
	m, d, err := acceptanceReadContext(ctx, q, p)
	if err != nil {
		return CockpitAcceptanceCriteriaView{}, err
	}
	out := CockpitAcceptanceCriteriaView{WorkspaceID: util.UUIDToString(p.WorkspaceID), NodeID: util.UUIDToString(p.NodeID), Revision: d.Revision, Items: []CockpitAcceptanceCriterionView{}, MaxItems: CockpitAcceptanceMaxCriteria, CanEdit: acceptanceManager(d, p.ActorID, m.Role, p.Human)}
	_, eligibility, err := executionLeaf(ctx, q, p.WorkspaceID, p.NodeID)
	if err != nil {
		return out, err
	}
	out.CanEdit = out.CanEdit && eligibility.Eligible
	rows, err := q.ListCockpitAcceptanceCriteria(ctx, db.ListCockpitAcceptanceCriteriaParams{WorkspaceID: p.WorkspaceID, NodeID: p.NodeID})
	if err != nil {
		return out, err
	}
	for _, c := range rows {
		out.Items = append(out.Items, acceptanceCriterionView(c))
	}
	return out, tx.Commit(ctx)
}

// CockpitAcceptanceApprovalRevocation presents the R2 reverse decision that
// withdrew an in-force approval. The request rows keep their recorded
// decisions; a later approval clears this presentation.
type CockpitAcceptanceApprovalRevocation struct {
	RevokedAt string `json:"revoked_at"`
	RevokedBy string `json:"revoked_by"`
	Reason    string `json:"reason"`
}

// CockpitAcceptanceHeaderView extends the stable acceptance contract with the
// revocation projection. The embedded contract marshals inline, so the JSON
// stays a superset of CockpitAcceptanceHeader and parses loose on clients
// that do not know the new fields yet.
type CockpitAcceptanceHeaderView struct {
	CockpitAcceptanceHeader
	ApprovalRevoked   *CockpitAcceptanceApprovalRevocation `json:"approval_revoked"`
	CanRevokeApproval bool                                 `json:"can_revoke_approval"`
}

func (s *IssueService) GetCockpitAcceptance(ctx context.Context, p CockpitAcceptanceRead) (CockpitAcceptanceHeaderView, error) {
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return CockpitAcceptanceHeaderView{}, err
	}
	defer tx.Rollback(ctx)
	m, d, err := acceptanceReadContext(ctx, q, p)
	if err != nil {
		return CockpitAcceptanceHeaderView{}, err
	}
	_, eligibility, err := executionLeaf(ctx, q, p.WorkspaceID, p.NodeID)
	if err != nil {
		return CockpitAcceptanceHeaderView{}, err
	}
	manager := acceptanceManager(d, p.ActorID, m.Role, p.Human) && eligibility.Eligible
	out := CockpitAcceptanceHeaderView{CockpitAcceptanceHeader: CockpitAcceptanceHeader{WorkspaceID: util.UUIDToString(p.WorkspaceID), NodeID: util.UUIDToString(p.NodeID), CriteriaRevision: d.Revision, CanEditCriteria: manager}}
	out.CanRevokeApproval = acceptanceManager(d, p.ActorID, m.Role, p.Human) && d.LastApprovedRequestID.Valid
	rows := []db.CockpitAcceptanceRequest{}
	ids := []pgtype.UUID{}
	for _, id := range []pgtype.UUID{d.CurrentRequestID, d.LastApprovedRequestID} {
		if id.Valid {
			r, e := q.GetCockpitAcceptanceRequest(ctx, db.GetCockpitAcceptanceRequestParams{WorkspaceID: p.WorkspaceID, NodeID: p.NodeID, ID: id})
			if e != nil {
				return out, e
			}
			rows = append(rows, r)
			ids = append(ids, r.ReviewIssueID)
		}
	}
	facts, err := readPlanningIssueFacts(ctx, q, p.WorkspaceID, ids)
	if err != nil {
		return out, err
	}
	var current db.CockpitAcceptanceRequest
	for _, r := range rows {
		issue, ok := facts[r.ReviewIssueID]
		if !ok {
			return out, ErrCockpitWorkflowConflict
		}
		meta := acceptanceMetadata(r, d, issue, p)
		if r.ID == d.CurrentRequestID {
			out.CurrentRequest = &meta
			current = r
		}
		if r.ID == d.LastApprovedRequestID {
			out.LastApprovedRequest = &meta
			out.NeedsReacceptance, err = acceptanceRequestStale(ctx, q, d, r)
			if err != nil {
				return out, err
			}
		}
	}
	if !d.LastApprovedRequestID.Valid && d.ApprovalRevokedAt.Valid {
		// R2: the in-force approval was withdrawn, so the L3 presents as
		// needing a fresh acceptance decision while the request rows keep
		// their recorded approvals.
		out.ApprovalRevoked = &CockpitAcceptanceApprovalRevocation{RevokedAt: d.ApprovalRevokedAt.Time.UTC().Format(time.RFC3339Nano), RevokedBy: util.UUIDToString(d.ApprovalRevokedBy), Reason: d.ApprovalRevokedReason.String}
		out.NeedsReacceptance = true
	}
	out.RequestCount, err = q.CountCockpitAcceptanceRequests(ctx, db.CountCockpitAcceptanceRequestsParams{WorkspaceID: p.WorkspaceID, NodeID: p.NodeID})
	if err != nil {
		return out, err
	}
	criteria, err := q.ListCockpitAcceptanceCriteria(ctx, db.ListCockpitAcceptanceCriteriaParams{WorkspaceID: p.WorkspaceID, NodeID: p.NodeID})
	if err != nil {
		return out, err
	}
	out.CanRequest = manager && len(criteria) > 0
	if current.ID.Valid && current.Decision == "pending" && !current.SupersededAt.Valid {
		stale, e := acceptanceRequestStale(ctx, q, d, current)
		if e != nil {
			return out, e
		}
		out.CanRequest = out.CanRequest && stale
		out.CanReassignReviewer = manager
	}
	return out, tx.Commit(ctx)
}
func (s *IssueService) ListCockpitAcceptanceRequests(ctx context.Context, p CockpitAcceptanceRead) (CockpitAcceptanceRequestPage, error) {
	size, err := planningPageSize(p.PageSize)
	if err != nil {
		return CockpitAcceptanceRequestPage{}, err
	}
	scope := planningHash([]any{"acceptance-requests", p.WorkspaceID, p.NodeID, size})
	after, _, err := decodePlanningCursor(p.Cursor, scope)
	if err != nil {
		return CockpitAcceptanceRequestPage{}, err
	}
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return CockpitAcceptanceRequestPage{}, err
	}
	defer tx.Rollback(ctx)
	_, d, err := acceptanceReadContext(ctx, q, p)
	if err != nil {
		return CockpitAcceptanceRequestPage{}, err
	}
	rows, err := q.ListCockpitAcceptanceRequests(ctx, db.ListCockpitAcceptanceRequestsParams{WorkspaceID: p.WorkspaceID, NodeID: p.NodeID, AfterID: after, PageLimit: size + 1})
	if err != nil {
		return CockpitAcceptanceRequestPage{}, err
	}
	out := CockpitAcceptanceRequestPage{WorkspaceID: util.UUIDToString(p.WorkspaceID), NodeID: util.UUIDToString(p.NodeID), Items: []CockpitAcceptanceRequestMetadata{}}
	out.Total, err = q.CountCockpitAcceptanceRequests(ctx, db.CountCockpitAcceptanceRequestsParams{WorkspaceID: p.WorkspaceID, NodeID: p.NodeID})
	if err != nil {
		return out, err
	}
	if len(rows) > int(size) {
		rows = rows[:size]
		out.NextCursor = encodePlanningCursor(scope, rows[len(rows)-1].ID, 0)
	}
	ids := []pgtype.UUID{}
	for _, r := range rows {
		ids = append(ids, r.ReviewIssueID)
	}
	facts, err := readPlanningIssueFacts(ctx, q, p.WorkspaceID, ids)
	if err != nil {
		return out, err
	}
	for _, r := range rows {
		issue, ok := facts[r.ReviewIssueID]
		if !ok {
			return out, ErrCockpitWorkflowConflict
		}
		v := db.CockpitAcceptanceRequest{ID: r.ID, NodeID: r.NodeID, RequestKey: r.RequestKey, Revision: r.Revision, CriteriaRevision: r.CriteriaRevision, EvidenceHash: r.EvidenceHash, ReviewerID: r.ReviewerID, ReviewIssueID: r.ReviewIssueID, Decision: r.Decision, CreatedBy: r.CreatedBy, CreatedAt: r.CreatedAt, ReviewedAt: r.ReviewedAt, SupersedesRequestID: r.SupersedesRequestID, SupersededAt: r.SupersededAt}
		meta := acceptanceMetadata(v, d, issue, p)
		meta.HasFeedback = r.HasFeedback
		out.Items = append(out.Items, meta)
	}
	return out, tx.Commit(ctx)
}
func (s *IssueService) GetCockpitAcceptanceRequest(ctx context.Context, p CockpitAcceptanceRead) (CockpitAcceptanceRequestDetail, error) {
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return CockpitAcceptanceRequestDetail{}, err
	}
	defer tx.Rollback(ctx)
	_, d, err := acceptanceReadContext(ctx, q, p)
	if err != nil {
		return CockpitAcceptanceRequestDetail{}, err
	}
	r, err := q.GetCockpitAcceptanceRequest(ctx, db.GetCockpitAcceptanceRequestParams{WorkspaceID: p.WorkspaceID, NodeID: p.NodeID, ID: p.RequestID})
	if err != nil {
		return CockpitAcceptanceRequestDetail{}, cockpitWorkflowError(err)
	}
	evidence, err := q.ListCockpitAcceptanceEvidence(ctx, db.ListCockpitAcceptanceEvidenceParams{WorkspaceID: p.WorkspaceID, NodeID: p.NodeID, RequestID: r.ID})
	if err != nil {
		return CockpitAcceptanceRequestDetail{}, err
	}
	criteria, err := q.ListCockpitAcceptanceRequestCriteria(ctx, db.ListCockpitAcceptanceRequestCriteriaParams{WorkspaceID: p.WorkspaceID, RequestID: r.ID})
	if err != nil {
		return CockpitAcceptanceRequestDetail{}, err
	}
	ids := []pgtype.UUID{}
	seen := map[pgtype.UUID]bool{}
	out := CockpitAcceptanceRequestDetail{WorkspaceID: util.UUIDToString(p.WorkspaceID), NodeID: util.UUIDToString(p.NodeID), Note: r.Note, Feedback: r.Feedback, DefinitionChanged: d.Revision != r.CriteriaRevision, Evidence: []CockpitAcceptanceEvidenceView{}}
	for _, e := range evidence {
		if !seen[e.VersionID] {
			ids = append(ids, e.VersionID)
			seen[e.VersionID] = true
		}
		if e.ApprovedVersionID != e.VersionID || !e.Eligible {
			out.EvidenceOutdated = true
		}
	}
	metaRows, err := q.ListCockpitArtifactVersionMetadataByIDs(ctx, db.ListCockpitArtifactVersionMetadataByIDsParams{WorkspaceID: p.WorkspaceID, VersionIds: ids})
	if err != nil {
		return out, err
	}
	issueIDs := []pgtype.UUID{r.ReviewIssueID}
	for _, v := range metaRows {
		if v.ReviewIssueID.Valid {
			issueIDs = append(issueIDs, v.ReviewIssueID)
		}
	}
	facts, err := readPlanningIssueFacts(ctx, q, p.WorkspaceID, issueIDs)
	if err != nil {
		return out, err
	}
	issue, ok := facts[r.ReviewIssueID]
	if !ok {
		return out, ErrCockpitWorkflowConflict
	}
	out.Request = acceptanceMetadata(r, d, issue, p)
	byID := map[pgtype.UUID]CockpitArtifactVersionMetadata{}
	for _, v := range metaRows {
		// Evidence rows are not a second formal artifact review surface. Their
		// immutable metadata links to the exact version reader for that authority.
		byID[v.ID] = artifactVersionMetadata(db.ListCockpitArtifactVersionMetadataRow(v), db.CockpitArtifact{}, facts, CockpitArtifactRead{}, "")
	}
	for _, c := range criteria {
		item := CockpitAcceptanceEvidenceView{Criterion: CockpitAcceptanceCriterionView{ID: util.UUIDToString(c.CriterionID), Title: c.Title, Description: c.Description, Revision: c.Revision, Position: c.Position}, Versions: []CockpitArtifactVersionMetadata{}}
		for _, e := range evidence {
			if e.CriterionID == c.CriterionID {
				meta, ok := byID[e.VersionID]
				if !ok || meta.ContentHash == nil || *meta.ContentHash != e.ContentHash {
					return out, artifactConflict("the fixed acceptance evidence is inconsistent")
				}
				item.Versions = append(item.Versions, meta)
			}
		}
		out.Evidence = append(out.Evidence, item)
	}
	sources, err := q.ListCockpitAcceptanceVersionSources(ctx, db.ListCockpitAcceptanceVersionSourcesParams{WorkspaceID: p.WorkspaceID, NodeID: p.NodeID, VersionIds: ids})
	if err != nil {
		return out, err
	}
	if err = tx.Commit(ctx); err != nil {
		return out, err
	}
	// Availability is distinct from the immutable decision and current authority.
	switch {
	case out.DefinitionChanged:
		out.EvidenceUnavailableReason = "criteria_changed"
	case out.EvidenceOutdated:
		out.EvidenceUnavailableReason = "evidence_outdated"
	case len(sources) != len(ids) || len(ids) == 0:
		out.EvidenceUnavailableReason = "content_unavailable"
	default:
		if e := s.probeAcceptanceSources(ctx, sources); e != nil {
			out.EvidenceUnavailableReason = "content_unavailable"
			if errors.Is(e, ErrCockpitArtifactPrivateStorageRequired) {
				out.EvidenceUnavailableReason = "private_storage_required"
			}
			if errors.Is(e, ErrCockpitArtifactVerificationTimeout) {
				out.EvidenceUnavailableReason = "verification_timeout"
			}
		} else {
			out.EvidenceAvailable = true
		}
	}
	return out, nil
}
