package service

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type CockpitArtifactRead struct {
	fileCaptureAvailable                                                                    bool
	AuthorID, ProducerRunID                                                                 pgtype.UUID
	WorkspaceID, ActorID, ArtifactID, VersionID, NodeID, ProjectID, ModuleID, SourceIssueID pgtype.UUID
	Human                                                                                   bool
	IDs                                                                                     []pgtype.UUID
	Query, Status, Relation, Cursor                                                         string
	PageSize                                                                                int32
}

func artifactManager(a db.CockpitArtifact, actor pgtype.UUID, role string, human bool) bool {
	return human && (a.CreatedBy == actor || role == "owner" || role == "admin")
}
func artifactVersionMetadata(v db.ListCockpitArtifactVersionMetadataRow, a db.CockpitArtifact, facts map[pgtype.UUID]CockpitIssueSummary, p CockpitArtifactRead, role string) CockpitArtifactVersionMetadata {
	var review *CockpitIssueSummary
	if i, ok := facts[v.ReviewIssueID]; ok {
		review = &i
	}
	var sourceNumber *int32
	if v.SourceMinutesVersionNumber.Valid {
		x := v.SourceMinutesVersionNumber.Int32
		sourceNumber = &x
	}
	var manifestNumber *int32
	if v.InputManifestVersionNumber.Valid {
		n := v.InputManifestVersionNumber.Int32
		manifestNumber = &n
	}
	return CockpitArtifactVersionMetadata{ID: util.UUIDToString(v.ID), ArtifactID: util.UUIDToString(v.ArtifactID), VersionNumber: v.VersionNumber, SubmissionKey: util.UUIDToString(v.SubmissionKey), Revision: v.Revision,
		InputManifestVersionID: planningUUID(v.InputManifestVersionID), InputManifestIssueID: planningUUID(v.InputManifestIssueID), InputManifestVersionNumber: manifestNumber, InputManifestHash: planningText(v.InputManifestHash),
		ProducerIssueID: util.UUIDToString(v.ProducerIssueID), ProducerIssueIdentifier: v.ProducerIssueIdentifier, ProducerIssueTitle: v.ProducerIssueTitle, ProducerRunID: planningUUID(v.ProducerRunID), SourceMeetingID: planningUUID(v.SourceMeetingID), SourceMeetingTitle: v.SourceMeetingTitle, SourceMinutesVersionID: planningUUID(v.SourceMinutesVersionID), SourceMinutesVersionNumber: sourceNumber,
		PayloadKind: v.PayloadKind, SourceAttachmentID: planningUUID(v.SourceAttachmentID), Filename: v.Filename, ContentType: v.ContentType, SizeBytes: util.Int8ToPtr(v.SizeBytes), ContentHash: planningText(v.ContentHash), CaptureStatus: v.CaptureStatus, CaptureErrorCode: v.CaptureErrorCode, CaptureError: v.CaptureError, Decision: v.Decision, ReviewerID: util.UUIDToString(v.ReviewerID), ReviewIssue: review, SubmittedByType: v.SubmittedByType, SubmittedByID: util.UUIDToString(v.SubmittedByID), CreatedAt: v.CreatedAt.Time.UTC().Format(time.RFC3339Nano), ReviewedAt: timestamp(v.ReviewedAt), HasFeedback: v.HasFeedback,
		CanReview:       p.Human && v.ReviewerID == p.ActorID && a.CurrentVersionID == v.ID && !a.ArchivedAt.Valid && v.CaptureStatus == "ready" && v.Decision == "pending",
		CanRetryCapture: p.fileCaptureAvailable && artifactManager(a, p.ActorID, role, p.Human) && a.CurrentVersionID == v.ID && !a.ArchivedAt.Valid && v.PayloadKind == "attachment" && v.Decision == "not_requested" && (v.CaptureStatus == "needs_attention" || v.CaptureStatus == "retry_wait")}
}
func artifactReadMember(ctx context.Context, q *db.Queries, p CockpitArtifactRead) (db.Member, error) {
	m, err := q.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{WorkspaceID: p.WorkspaceID, UserID: p.ActorID})
	if errors.Is(err, pgx.ErrNoRows) {
		return m, ErrCockpitWorkflowForbidden
	}
	return m, err
}
func readArtifactHeaders(ctx context.Context, q *db.Queries, rows []db.CockpitArtifact, p CockpitArtifactRead, role string) ([]CockpitArtifactHeader, error) {
	ids := make([]pgtype.UUID, 0, len(rows)*2)
	issues := make([]pgtype.UUID, 0, len(rows)*4)
	for _, a := range rows {
		if a.CurrentVersionID.Valid {
			ids = append(ids, a.CurrentVersionID)
		}
		if a.ApprovedVersionID.Valid {
			ids = append(ids, a.ApprovedVersionID)
		}
		issues = append(issues, a.SourceIssueID, a.AuthorizedProducerIssueID)
	}
	versions, err := q.ListCockpitArtifactVersionMetadataByIDs(ctx, db.ListCockpitArtifactVersionMetadataByIDsParams{WorkspaceID: p.WorkspaceID, VersionIds: ids})
	if err != nil {
		return nil, err
	}
	byID := make(map[pgtype.UUID]db.ListCockpitArtifactVersionMetadataRow, len(versions))
	for _, v := range versions {
		byID[v.ID] = db.ListCockpitArtifactVersionMetadataRow(v)
		if v.ReviewIssueID.Valid {
			issues = append(issues, v.ReviewIssueID)
		}
	}
	facts, err := readPlanningIssueFacts(ctx, q, p.WorkspaceID, issues)
	if err != nil {
		return nil, err
	}
	nodeIDs, artifactIDs := make([]pgtype.UUID, 0, len(rows)), make([]pgtype.UUID, 0, len(rows))
	for _, a := range rows {
		nodeIDs = append(nodeIDs, a.OwnerNodeID)
		artifactIDs = append(artifactIDs, a.ID)
	}
	labels, err := q.ListCockpitArtifactOwnerLabels(ctx, db.ListCockpitArtifactOwnerLabelsParams{WorkspaceID: p.WorkspaceID, Column2: nodeIDs})
	if err != nil {
		return nil, err
	}
	byNode := map[pgtype.UUID]string{}
	for _, n := range labels {
		byNode[n.ID] = n.Name
	}
	evidence := map[pgtype.UUID]pgtype.UUID{}
	if p.NodeID.Valid {
		pins, e := q.ListCockpitArtifactEvidencePins(ctx, db.ListCockpitArtifactEvidencePinsParams{WorkspaceID: p.WorkspaceID, Column2: artifactIDs, OwnerNodeID: p.NodeID})
		if e != nil {
			return nil, e
		}
		for _, pin := range pins {
			evidence[pin.ID] = pin.ApprovedVersionID
		}
	}
	var taskProducer pgtype.UUID
	if !p.Human && p.AuthorID.Valid && p.ProducerRunID.Valid {
		run, e := q.GetAgentTask(ctx, p.ProducerRunID)
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return nil, e
		}
		if e == nil && run.AgentID == p.AuthorID {
			taskProducer = run.IssueID
		}
	}
	result := make([]CockpitArtifactHeader, 0, len(rows))
	// The page is bounded; labels and eligibility never read version bodies.
	for _, a := range rows {
		if a.CurrentVersionID.Valid {
			if _, ok := byID[a.CurrentVersionID]; !ok {
				return nil, artifactConflict("current artifact version is unavailable")
			}
		}
		if a.ApprovedVersionID.Valid {
			if v, ok := byID[a.ApprovedVersionID]; !ok || v.Decision != "approved" {
				return nil, artifactConflict("approved artifact version is unavailable")
			}
		}
		label, ok := byNode[a.OwnerNodeID]
		if !ok {
			return nil, ErrCockpitWorkflowConflict
		}
		source, sourceOK := facts[a.SourceIssueID]
		producer, producerOK := facts[a.AuthorizedProducerIssueID]
		if !sourceOK || !producerOK {
			return nil, fmt.Errorf("%w: artifact source task is unavailable", ErrCockpitWorkflowConflict)
		}
		h := CockpitArtifactHeader{ID: util.UUIDToString(a.ID), WorkspaceID: util.UUIDToString(a.WorkspaceID), CreationKey: util.UUIDToString(a.CreationKey), NodeID: util.UUIDToString(a.OwnerNodeID), NodeLabel: label, ProjectID: util.UUIDToString(a.ProjectID), ModuleID: util.UUIDToString(a.ModuleID), SourceIssue: source, ProducerIssue: producer, CreatedBy: util.UUIDToString(a.CreatedBy), Title: a.Title, Description: a.Description, Revision: a.Revision, ReviewerID: util.UUIDToString(a.ReviewerID), ArchivedAt: timestamp(a.ArchivedAt), Status: "draft"}
		if v, ok := byID[a.CurrentVersionID]; ok {
			meta := artifactVersionMetadata(v, a, facts, p, role)
			h.CurrentVersion = &meta
			h.VersionCount = int64(v.VersionNumber)
			switch v.CaptureStatus {
			case "queued", "running", "retry_wait":
				h.Status = "capturing"
			case "needs_attention":
				h.Status = "needs_attention"
			case "ready":
				switch v.Decision {
				case "pending", "approved", "changes_requested", "rejected":
					h.Status = v.Decision
				default:
					h.Status = "unknown"
				}
			default:
				h.Status = "unknown"
			}
		}
		if v, ok := byID[a.ApprovedVersionID]; ok {
			meta := artifactVersionMetadata(v, a, facts, p, role)
			h.ApprovedVersion = &meta
			if evidence[a.ID] == v.ID {
				h.EvidenceVersion = &meta
			}
		}
		h.FileCaptureAvailable = p.fileCaptureAvailable
		if !h.FileCaptureAvailable {
			h.FileCaptureUnavailableReason = "private_storage_required"
		}
		manager := artifactManager(a, p.ActorID, role, p.Human)
		h.CanEdit = manager && !a.ArchivedAt.Valid
		h.CanRestore = manager && a.ArchivedAt.Valid
		h.CanReference = manager && !a.ArchivedAt.Valid
		h.CanAssignProducer = manager && !a.ArchivedAt.Valid
		h.CanReassignReviewer = manager && !a.ArchivedAt.Valid
		h.CanArchive = manager && !a.ArchivedAt.Valid && validateCockpitArtifactSubmission(false, h.CurrentVersion) == nil
		ownsProducer := producer.AssigneeType != nil && *producer.AssigneeType == "member" && producer.AssigneeID != nil && *producer.AssigneeID == util.UUIDToString(p.ActorID)
		h.CanSubmit = (p.Human && (manager || ownsProducer) || !p.Human && taskProducer.Valid && taskProducer == a.AuthorizedProducerIssueID) && validateCockpitArtifactSubmission(a.ArchivedAt.Valid, h.CurrentVersion) == nil
		if a.ArchivedAt.Valid {
			h.Status = "archived"
		}
		result = append(result, h)
	}
	return result, nil
}
func (s *IssueService) GetCockpitArtifact(ctx context.Context, p CockpitArtifactRead) (CockpitArtifactHeader, error) {
	p.fileCaptureAvailable = s.artifactFileCaptureAvailable()
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return CockpitArtifactHeader{}, err
	}
	defer tx.Rollback(ctx)
	m, err := artifactReadMember(ctx, q, p)
	if err != nil {
		return CockpitArtifactHeader{}, err
	}
	if p.NodeID.Valid {
		if err := validateArtifactNodeReadScope(ctx, q, p); err != nil {
			return CockpitArtifactHeader{}, err
		}
	}
	a, err := q.GetCockpitArtifact(ctx, db.GetCockpitArtifactParams{WorkspaceID: p.WorkspaceID, ID: p.ArtifactID})
	if err != nil {
		return CockpitArtifactHeader{}, cockpitWorkflowError(err)
	}
	headers, err := readArtifactHeaders(ctx, q, []db.CockpitArtifact{a}, p, m.Role)
	if err != nil {
		return CockpitArtifactHeader{}, err
	}
	return headers[0], tx.Commit(ctx)
}
func normalizeArtifactRead(p *CockpitArtifactRead) (CockpitArtifactScope, error) {
	p.Query = strings.TrimSpace(p.Query)
	if len(p.Query) > 512 {
		return CockpitArtifactScope{}, fmt.Errorf("%w: search is limited to 512 bytes", ErrCockpitWorkflowInput)
	}
	var err error
	p.PageSize, err = planningPageSize(p.PageSize)
	if err != nil {
		return CockpitArtifactScope{}, err
	}
	if p.ModuleID.Valid && !p.ProjectID.Valid {
		return CockpitArtifactScope{}, fmt.Errorf("%w: module scope requires project", ErrCockpitWorkflowInput)
	}
	if p.Relation == "" {
		p.Relation = "owned"
	}
	if p.Relation != "owned" && p.Relation != "referenced" && p.Relation != "all" {
		return CockpitArtifactScope{}, ErrCockpitWorkflowInput
	}
	if !p.NodeID.Valid && p.Relation != "owned" {
		return CockpitArtifactScope{}, ErrCockpitWorkflowInput
	}
	switch p.Status {
	case "", "draft", "capturing", "needs_attention", "pending", "approved", "changes_requested", "rejected", "archived", "unknown":
	default:
		return CockpitArtifactScope{}, ErrCockpitWorkflowInput
	}
	if len(p.IDs) > 100 || (len(p.IDs) > 0 && (p.Query != "" || p.Status != "")) {
		return CockpitArtifactScope{}, ErrCockpitWorkflowInput
	}
	set := map[string]pgtype.UUID{}
	for _, id := range p.IDs {
		if !id.Valid {
			return CockpitArtifactScope{}, ErrCockpitWorkflowInput
		}
		set[util.UUIDToString(id)] = id
	}
	ids := make([]string, 0, len(set))
	for id := range set {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	p.IDs = make([]pgtype.UUID, 0, len(ids))
	for _, id := range ids {
		p.IDs = append(p.IDs, set[id])
	}
	return CockpitArtifactScope{IDs: ids, ProjectID: planningUUID(p.ProjectID), ModuleID: planningUUID(p.ModuleID), NodeID: planningUUID(p.NodeID), SourceIssueID: planningUUID(p.SourceIssueID), Query: p.Query, Status: p.Status, Relation: p.Relation}, nil
}
func (s *IssueService) ListCockpitArtifacts(ctx context.Context, p CockpitArtifactRead) (CockpitArtifactPage, error) {
	p.fileCaptureAvailable = s.artifactFileCaptureAvailable()
	scope, err := normalizeArtifactRead(&p)
	if err != nil {
		return CockpitArtifactPage{}, err
	}
	fingerprint := planningHash(struct {
		WS    pgtype.UUID
		Scope CockpitArtifactScope
		Size  int32
	}{p.WorkspaceID, scope, p.PageSize})
	after, _, err := decodePlanningCursor(p.Cursor, fingerprint)
	if err != nil {
		return CockpitArtifactPage{}, err
	}
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return CockpitArtifactPage{}, err
	}
	defer tx.Rollback(ctx)
	m, err := artifactReadMember(ctx, q, p)
	if err != nil {
		return CockpitArtifactPage{}, err
	}
	if p.ProjectID.Valid {
		if _, err = q.GetProjectInWorkspace(ctx, db.GetProjectInWorkspaceParams{WorkspaceID: p.WorkspaceID, ID: p.ProjectID}); err != nil {
			return CockpitArtifactPage{}, cockpitWorkflowError(err)
		}
	}
	if p.ModuleID.Valid {
		mod, e := q.GetModuleInWorkspace(ctx, db.GetModuleInWorkspaceParams{WorkspaceID: p.WorkspaceID, ID: p.ModuleID})
		if e != nil {
			return CockpitArtifactPage{}, cockpitWorkflowError(e)
		}
		if mod.ProjectID != p.ProjectID {
			return CockpitArtifactPage{}, ErrCockpitWorkflowNotFound
		}
	}
	if p.NodeID.Valid {
		if err = validateArtifactNodeReadScope(ctx, q, p); err != nil {
			return CockpitArtifactPage{}, err
		}
	}
	if p.SourceIssueID.Valid {
		if _, err = q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: p.WorkspaceID, ID: p.SourceIssueID}); err != nil {
			return CockpitArtifactPage{}, cockpitWorkflowError(err)
		}
	}
	params := db.ListCockpitArtifactsParams{WorkspaceID: p.WorkspaceID, ProjectID: p.ProjectID, ModuleID: p.ModuleID, SourceIssueID: p.SourceIssueID, NodeID: p.NodeID, Ids: p.IDs, Relation: p.Relation, Query: p.Query, Status: p.Status, AfterID: after, PageLimit: p.PageSize + 1}
	rows, err := q.ListCockpitArtifacts(ctx, params)
	if err != nil {
		return CockpitArtifactPage{}, err
	}
	counts, err := q.CountCockpitArtifacts(ctx, db.CountCockpitArtifactsParams{WorkspaceID: p.WorkspaceID, ProjectID: p.ProjectID, ModuleID: p.ModuleID, SourceIssueID: p.SourceIssueID, NodeID: p.NodeID, Ids: p.IDs, Relation: p.Relation, Query: p.Query, Status: p.Status})
	if err != nil {
		return CockpitArtifactPage{}, err
	}
	out := CockpitArtifactPage{WorkspaceID: util.UUIDToString(p.WorkspaceID), Scope: scope, Total: counts.Total, FilteredTotal: counts.FilteredTotal, CanCreate: p.Human}
	if len(rows) > int(p.PageSize) {
		rows = rows[:p.PageSize]
		out.NextCursor = encodePlanningCursor(fingerprint, rows[len(rows)-1].ID, 0)
	}
	out.Items, err = readArtifactHeaders(ctx, q, rows, p, m.Role)
	if err != nil {
		return CockpitArtifactPage{}, err
	}
	return out, tx.Commit(ctx)
}
func (s *IssueService) ListCockpitArtifactVersions(ctx context.Context, p CockpitArtifactRead) (CockpitArtifactVersionPage, error) {
	p.fileCaptureAvailable = s.artifactFileCaptureAvailable()
	size, err := planningPageSize(p.PageSize)
	if err != nil {
		return CockpitArtifactVersionPage{}, err
	}
	fingerprint := planningHash(struct {
		W, A pgtype.UUID
		Size int32
	}{p.WorkspaceID, p.ArtifactID, size})
	after, number, err := decodePlanningCursor(p.Cursor, fingerprint)
	if err != nil {
		return CockpitArtifactVersionPage{}, err
	}
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return CockpitArtifactVersionPage{}, err
	}
	defer tx.Rollback(ctx)
	m, err := artifactReadMember(ctx, q, p)
	if err != nil {
		return CockpitArtifactVersionPage{}, err
	}
	a, err := q.GetCockpitArtifact(ctx, db.GetCockpitArtifactParams{WorkspaceID: p.WorkspaceID, ID: p.ArtifactID})
	if err != nil {
		return CockpitArtifactVersionPage{}, cockpitWorkflowError(err)
	}
	rows, err := q.ListCockpitArtifactVersionMetadata(ctx, db.ListCockpitArtifactVersionMetadataParams{WorkspaceID: p.WorkspaceID, ArtifactID: p.ArtifactID, BeforeNumber: pgtype.Int4{Int32: number, Valid: after.Valid}, PageLimit: size + 1})
	if err != nil {
		return CockpitArtifactVersionPage{}, err
	}
	total, err := q.CountCockpitArtifactVersions(ctx, db.CountCockpitArtifactVersionsParams{WorkspaceID: p.WorkspaceID, ArtifactID: p.ArtifactID})
	if err != nil {
		return CockpitArtifactVersionPage{}, err
	}
	out := CockpitArtifactVersionPage{WorkspaceID: util.UUIDToString(p.WorkspaceID), ArtifactID: util.UUIDToString(p.ArtifactID), ArtifactRevision: a.Revision, Items: []CockpitArtifactVersionMetadata{}, Total: total}
	if len(rows) > int(size) {
		rows = rows[:size]
		last := rows[len(rows)-1]
		out.NextCursor = encodePlanningCursor(fingerprint, last.ID, last.VersionNumber)
	}
	ids := make([]pgtype.UUID, 0, len(rows))
	for _, v := range rows {
		ids = append(ids, v.ReviewIssueID)
	}
	facts, err := readPlanningIssueFacts(ctx, q, p.WorkspaceID, ids)
	if err != nil {
		return out, err
	}
	for _, v := range rows {
		out.Items = append(out.Items, artifactVersionMetadata(v, a, facts, p, m.Role))
	}
	return out, tx.Commit(ctx)
}
func (s *IssueService) GetCockpitArtifactVersion(ctx context.Context, p CockpitArtifactRead) (CockpitArtifactVersionDetail, error) {
	p.fileCaptureAvailable = s.artifactFileCaptureAvailable()
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return CockpitArtifactVersionDetail{}, err
	}
	defer tx.Rollback(ctx)
	m, err := artifactReadMember(ctx, q, p)
	if err != nil {
		return CockpitArtifactVersionDetail{}, err
	}
	a, err := q.GetCockpitArtifact(ctx, db.GetCockpitArtifactParams{WorkspaceID: p.WorkspaceID, ID: p.ArtifactID})
	if err != nil {
		return CockpitArtifactVersionDetail{}, cockpitWorkflowError(err)
	}
	v, err := q.GetCockpitArtifactVersion(ctx, db.GetCockpitArtifactVersionParams{WorkspaceID: p.WorkspaceID, ArtifactID: p.ArtifactID, ID: p.VersionID})
	if err != nil {
		return CockpitArtifactVersionDetail{}, cockpitWorkflowError(err)
	}
	metaRows, err := q.ListCockpitArtifactVersionMetadataByIDs(ctx, db.ListCockpitArtifactVersionMetadataByIDsParams{WorkspaceID: p.WorkspaceID, VersionIds: []pgtype.UUID{v.ID}})
	if err != nil {
		return CockpitArtifactVersionDetail{}, err
	}
	if len(metaRows) != 1 {
		return CockpitArtifactVersionDetail{}, ErrCockpitWorkflowNotFound
	}
	facts, err := readPlanningIssueFacts(ctx, q, p.WorkspaceID, []pgtype.UUID{v.ReviewIssueID})
	if err != nil {
		return CockpitArtifactVersionDetail{}, err
	}
	out := CockpitArtifactVersionDetail{WorkspaceID: util.UUIDToString(p.WorkspaceID), ArtifactID: util.UUIDToString(p.ArtifactID), Version: artifactVersionMetadata(db.ListCockpitArtifactVersionMetadataRow(metaRows[0]), a, facts, p, m.Role), Content: planningText(v.Content), Feedback: v.Feedback}
	if err = tx.Commit(ctx); err != nil {
		return out, err
	}
	// Fixed-content I/O occurs after releasing the read transaction. Availability
	// never revokes the historical decision or the reviewer's recovery authority.
	if v.CaptureStatus != "ready" {
		out.ContentUnavailableReason = "capture_not_ready"
		return out, nil
	}
	if v.PayloadKind == "text" {
		out.ContentAvailable = v.Content.Valid && minutesContentHash(v.Content.String) == v.ContentHash.String
		if !out.ContentAvailable {
			out.ContentUnavailableReason = "content_mismatch"
		}
		return out, nil
	}
	if !p.fileCaptureAvailable {
		out.ContentUnavailableReason = "private_storage_required"
		return out, nil
	}
	if err = s.probeArtifactFile(ctx, v.StorageKey.String, v.SizeBytes.Int64, v.ContentHash.String); err != nil {
		out.ContentUnavailableReason = "content_unavailable"
		if errors.Is(err, ErrCockpitArtifactVerificationTimeout) {
			out.ContentUnavailableReason = "verification_timeout"
		}
		return out, nil
	}
	out.ContentAvailable = true
	return out, nil
}

func (s *IssueService) readArtifactVersionMetadata(ctx context.Context, p CockpitArtifactRead) (CockpitArtifactVersionMetadata, error) {
	p.fileCaptureAvailable = s.artifactFileCaptureAvailable()
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return CockpitArtifactVersionMetadata{}, err
	}
	defer tx.Rollback(ctx)
	m, err := artifactReadMember(ctx, q, p)
	if err != nil {
		return CockpitArtifactVersionMetadata{}, err
	}
	a, err := q.GetCockpitArtifact(ctx, db.GetCockpitArtifactParams{WorkspaceID: p.WorkspaceID, ID: p.ArtifactID})
	if err != nil {
		return CockpitArtifactVersionMetadata{}, cockpitWorkflowError(err)
	}
	rows, err := q.ListCockpitArtifactVersionMetadataByIDs(ctx, db.ListCockpitArtifactVersionMetadataByIDsParams{WorkspaceID: p.WorkspaceID, VersionIds: []pgtype.UUID{p.VersionID}})
	if err != nil {
		return CockpitArtifactVersionMetadata{}, err
	}
	if len(rows) != 1 || rows[0].ArtifactID != p.ArtifactID {
		return CockpitArtifactVersionMetadata{}, ErrCockpitWorkflowNotFound
	}
	facts, err := readPlanningIssueFacts(ctx, q, p.WorkspaceID, []pgtype.UUID{rows[0].ReviewIssueID})
	if err != nil {
		return CockpitArtifactVersionMetadata{}, err
	}
	return artifactVersionMetadata(db.ListCockpitArtifactVersionMetadataRow(rows[0]), a, facts, p, m.Role), tx.Commit(ctx)
}

func validateArtifactNodeReadScope(ctx context.Context, q *db.Queries, p CockpitArtifactRead) error {
	_, project, module, err := requireExecutionLeaf(ctx, q, p.WorkspaceID, p.NodeID)
	if err != nil {
		return err
	}
	if p.ProjectID.Valid && p.ProjectID != project || p.ModuleID.Valid && p.ModuleID != module {
		return ErrCockpitWorkflowNotFound
	}
	return nil
}
