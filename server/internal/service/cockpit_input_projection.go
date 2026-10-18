package service

import (
	"context"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/storage"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type inputProjectionActor struct {
	kind                                                      string
	actor, credential, authorizer, agent, run, issue, runtime pgtype.UUID
}
type inputProjectionLabels struct {
	users, agents map[pgtype.UUID]string
	issues        map[pgtype.UUID]CockpitIssueSummary
}

func inputProjectionChunks(ids []pgtype.UUID) [][]pgtype.UUID {
	ids = inputUniqueIDs(ids)
	out := [][]pgtype.UUID{}
	for len(ids) > 0 {
		n := len(ids)
		if n > CockpitInputMaxSelectedIDs {
			n = CockpitInputMaxSelectedIDs
		}
		out = append(out, ids[:n])
		ids = ids[n:]
	}
	return out
}
func inputProjectionIDs[T any](p CockpitInputRead, rows []T, identity func(T) (pgtype.UUID, pgtype.UUID)) ([]pgtype.UUID, error) {
	if len(rows) > CockpitInputMaxSelectedIDs {
		return nil, inputError("invalid_input", "The input projection exceeds its bounded batch.")
	}
	ids := make([]pgtype.UUID, 0, len(rows))
	seen := map[pgtype.UUID]bool{}
	for _, row := range rows {
		id, ws := identity(row)
		if !id.Valid || seen[id] || ws.Valid && ws != p.WorkspaceID {
			return nil, inputError("not_found", "The selected input identity is unavailable in this scope.")
		}
		seen[id] = true
		ids = append(ids, id)
	}
	return ids, nil
}
func inputProjectionMissing() error {
	return inputError("not_found", "The selected input record is unavailable in this scope.")
}
func loadInputProjectionLabels(ctx context.Context, q *db.Queries, p CockpitInputRead, actors []inputProjectionActor, issues []pgtype.UUID) (inputProjectionLabels, error) {
	out := inputProjectionLabels{users: map[pgtype.UUID]string{}, agents: map[pgtype.UUID]string{}, issues: map[pgtype.UUID]CockpitIssueSummary{}}
	users, agents := []pgtype.UUID{}, []pgtype.UUID{}
	for _, a := range actors {
		users = append(users, a.credential, a.authorizer)
		issues = append(issues, a.issue)
		agents = append(agents, a.agent)
		if a.kind == "member" {
			users = append(users, a.actor)
		} else if a.kind == "agent" {
			agents = append(agents, a.actor)
		}
	}
	for _, batch := range inputProjectionChunks(users) {
		rows, err := q.GetUsersByIDs(ctx, batch)
		if err != nil {
			return out, err
		}
		for _, row := range rows {
			out.users[row.ID] = row.Name
		}
	}
	for _, batch := range inputProjectionChunks(agents) {
		rows, err := q.ReadCockpitInputAgentNames(ctx, db.ReadCockpitInputAgentNamesParams{WorkspaceID: p.WorkspaceID, Ids: batch})
		if err != nil {
			return out, err
		}
		for _, row := range rows {
			out.agents[row.ID] = row.Name
		}
	}
	for _, batch := range inputProjectionChunks(issues) {
		rows, err := readPlanningIssueFacts(ctx, q, p.WorkspaceID, batch)
		if err != nil {
			return out, err
		}
		for id, row := range rows {
			out.issues[id] = row
		}
	}
	return out, nil
}
func (l inputProjectionLabels) principal(a inputProjectionActor) CockpitInputPrincipal {
	name := ""
	if a.kind == "member" {
		name = l.users[a.actor]
	} else if a.kind == "agent" {
		name = l.agents[a.actor]
	}
	return CockpitInputPrincipal{ActorType: a.kind, ActorID: util.UUIDToString(a.actor), ActorName: name, CredentialOwnerUserID: util.UUIDToString(a.credential), AuthorizingUserID: util.UUIDToString(a.authorizer), AuthorizingUserName: l.users[a.authorizer], AgentID: planningUUID(a.agent), RunID: planningUUID(a.run), IssueID: planningUUID(a.issue), RuntimeID: planningUUID(a.runtime)}
}
func (l inputProjectionLabels) issue(id pgtype.UUID) *CockpitIssueSummary {
	row, ok := l.issues[id]
	if !ok {
		return nil
	}
	return &row
}
func inputProjectionManager(p CockpitInputRead, a cockpitInputAuthority, h db.ReadCockpitInputHeadersRow) bool {
	return inputHumanManager(p, a.Member, db.CockpitInput{ID: h.ID, WorkspaceID: h.WorkspaceID, AuthorizingUserID: h.AuthorizingUserID})
}
func inputProjectionKnownActor(kind string) bool { return kind == "member" || kind == "agent" }
func inputProjectionKnownCapture(kind string) bool {
	return kind == "awaiting_upload" || kind == "queued" || kind == "capturing" || kind == "ready" || kind == "needs_attention"
}
func inputProjectionKnownAvailability(kind string) bool {
	return kind == "unknown" || kind == "checking" || kind == "available" || kind == "unavailable"
}
func inputProjectionKnownSource(kind string) bool {
	return kind == "upload" || kind == "nas_file" || kind == "attachment" || kind == "artifact_version"
}
func inputProjectionKnownTransfer(kind string) bool {
	switch kind {
	case "awaiting_bytes", "queued", "reading", "pinned", "writing", "verifying", "awaiting_finalize", "verified", "failed", "abandoned", "expired":
		return true
	}
	return false
}
func inputProjectionTerminal(kind string) bool {
	return kind == "verified" || kind == "failed" || kind == "abandoned" || kind == "expired"
}
func inputProjectionHasPin(v db.ReadCockpitInputVersionsRow) bool {
	return v.PinnedAt.Valid && v.PinnedSizeBytes.Valid && v.PinnedSizeBytes.Int64 >= 0 && v.ContentHash.Valid && len(v.ContentHash.String) == 64
}
func inputProjectionHeadMap(ctx context.Context, q *db.Queries, p CockpitInputRead, ids []pgtype.UUID) (map[pgtype.UUID]db.ReadCockpitInputHeadersRow, error) {
	out := map[pgtype.UUID]db.ReadCockpitInputHeadersRow{}
	for _, batch := range inputProjectionChunks(ids) {
		rows, err := q.ReadCockpitInputHeaders(ctx, db.ReadCockpitInputHeadersParams{WorkspaceID: p.WorkspaceID, Ids: batch})
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			if row.WorkspaceID != p.WorkspaceID {
				return nil, inputProjectionMissing()
			}
			out[row.ID] = row
		}
	}
	for _, id := range inputUniqueIDs(ids) {
		if _, ok := out[id]; !ok {
			return nil, inputProjectionMissing()
		}
	}
	return out, nil
}
func inputProjectionHeaderActor(r db.ReadCockpitInputHeadersRow) inputProjectionActor {
	return inputProjectionActor{kind: r.ActorType, actor: r.ActorID, credential: r.CredentialOwnerUserID, authorizer: r.AuthorizingUserID, agent: r.SourceAgentID, run: r.SourceRunID, issue: r.SourceIssueID, runtime: r.SourceRuntimeID}
}
func inputProjectionVersionActor(r db.ReadCockpitInputVersionsRow) inputProjectionActor {
	return inputProjectionActor{kind: r.ActorType, actor: r.ActorID, credential: r.CredentialOwnerUserID, authorizer: r.AuthorizingUserID, agent: r.SourceAgentID, run: r.SourceRunID, issue: r.SourceIssueID, runtime: r.SourceRuntimeID}
}
func inputProjectionTransferActor(r db.ReadCockpitInputTransfersRow) inputProjectionActor {
	return inputProjectionActor{kind: r.ActorType.String, actor: r.ActorID, credential: r.CredentialOwnerUserID, authorizer: r.AuthorizingUserID, agent: r.SourceAgentID, run: r.SourceRunID, issue: r.SourceIssueID, runtime: r.SourceRuntimeID}
}

func (s *IssueService) inputHeaders(ctx context.Context, q *db.Queries, p CockpitInputRead, located []db.CockpitInput) ([]CockpitInputHeader, error) {
	ids, err := inputProjectionIDs(p, located, func(r db.CockpitInput) (pgtype.UUID, pgtype.UUID) { return r.ID, r.WorkspaceID })
	if err != nil {
		return nil, err
	}
	out := []CockpitInputHeader{}
	if len(ids) == 0 {
		return out, nil
	}
	a, err := inputReadPrincipal(ctx, q, p)
	if err != nil {
		return nil, err
	}
	if !inputCatalogAllowed(p) {
		return nil, inputProjectionMissing()
	}
	heads, err := inputProjectionHeadMap(ctx, q, p, ids)
	if err != nil {
		return nil, err
	}
	actors := []inputProjectionActor{}
	issueIDs, versionIDs := []pgtype.UUID{}, []pgtype.UUID{}
	for _, id := range ids {
		row := heads[id]
		if p.ActorSource != "human" && !inputSameSource(row.SourceAgentID, row.SourceIssueID, row.AuthorizingUserID, a) {
			return nil, inputProjectionMissing()
		}
		actors = append(actors, inputProjectionHeaderActor(row))
		issueIDs = append(issueIDs, row.OriginIssueID)
		versionIDs = append(versionIDs, row.CurrentVersionID)
	}
	labels, err := loadInputProjectionLabels(ctx, q, p, actors, issueIDs)
	if err != nil {
		return nil, err
	}
	versions, err := s.inputVersionProjectionByIDs(ctx, q, p, a, inputUniqueIDs(versionIDs))
	if err != nil {
		return nil, err
	}
	versionCounts, err := q.GetCockpitInputVersionCounts(ctx, db.GetCockpitInputVersionCountsParams{WorkspaceID: p.WorkspaceID, Ids: ids})
	if err != nil {
		return nil, err
	}
	referenceCounts, err := q.GetCockpitInputReferenceCounts(ctx, db.GetCockpitInputReferenceCountsParams{WorkspaceID: p.WorkspaceID, Ids: ids})
	if err != nil {
		return nil, err
	}
	counts, refs := map[pgtype.UUID]int64{}, map[pgtype.UUID]int64{}
	for _, v := range versionCounts {
		counts[v.InputID] = v.VersionTotal
	}
	for _, v := range referenceCounts {
		refs[v.InputID] = v.ReferenceTotal
	}
	for _, id := range ids {
		row := heads[id]
		manager := inputProjectionManager(p, a, row) && inputProjectionKnownActor(row.ActorType)
		canSubmit := manager || p.ActorSource == "task_token" && inputLiveAuthority(p, a) && inputSameSource(row.SourceAgentID, row.SourceIssueID, row.AuthorizingUserID, a)
		dto := CockpitInputHeader{WorkspaceID: util.UUIDToString(row.WorkspaceID), ID: util.UUIDToString(row.ID), CreationKey: util.UUIDToString(row.CreationKey), Title: row.Title, Description: row.Description, ProjectID: planningUUID(row.ProjectID), OriginIssue: labels.issue(row.OriginIssueID), Revision: row.Revision, RegisteredBy: labels.principal(inputProjectionHeaderActor(row)), CreatedAt: inputTime(row.CreatedAt), UpdatedAt: inputTime(row.UpdatedAt), ArchivedAt: timestamp(row.ArchivedAt), VersionTotal: counts[id], ReferenceTotal: refs[id], CanEdit: manager, CanSubmit: canSubmit && !row.ArchivedAt.Valid, CanArchive: manager && !row.ArchivedAt.Valid, CanUnarchive: manager && row.ArchivedAt.Valid, BlockedReasons: []string{}}
		if row.CurrentVersionID.Valid {
			v, ok := versions[row.CurrentVersionID]
			if !ok || v.InputID != dto.ID {
				return nil, inputProjectionMissing()
			}
			dto.CurrentVersion = &v
		}
		if row.ArchivedAt.Valid {
			dto.BlockedReasons = append(dto.BlockedReasons, "input_archived")
		}
		if !canSubmit {
			dto.BlockedReasons = append(dto.BlockedReasons, "permission_revoked")
		}
		out = append(out, dto)
	}
	return out, nil
}
func (s *IssueService) inputVersions(ctx context.Context, q *db.Queries, p CockpitInputRead, located []db.CockpitInputVersion) ([]CockpitInputVersionMetadata, error) {
	ids, err := inputProjectionIDs(p, located, func(r db.CockpitInputVersion) (pgtype.UUID, pgtype.UUID) { return r.ID, r.WorkspaceID })
	if err != nil {
		return nil, err
	}
	out := []CockpitInputVersionMetadata{}
	if len(ids) == 0 {
		return out, nil
	}
	a, err := inputReadPrincipal(ctx, q, p)
	if err != nil {
		return nil, err
	}
	items, err := s.inputVersionProjectionByIDs(ctx, q, p, a, ids)
	if err != nil {
		return nil, err
	}
	for _, row := range located {
		v, ok := items[row.ID]
		if !ok || row.InputID.Valid && v.InputID != util.UUIDToString(row.InputID) {
			return nil, inputProjectionMissing()
		}
		out = append(out, v)
	}
	return out, nil
}

func (s *IssueService) inputVersionProjectionByIDs(ctx context.Context, q *db.Queries, p CockpitInputRead, a cockpitInputAuthority, ids []pgtype.UUID) (map[pgtype.UUID]CockpitInputVersionMetadata, error) {
	out := map[pgtype.UUID]CockpitInputVersionMetadata{}
	if len(ids) == 0 {
		return out, nil
	}
	if len(ids) > 100 {
		return nil, inputError("invalid_input", "The version projection exceeds its bounded batch.")
	}
	rows, err := q.ReadCockpitInputVersions(ctx, db.ReadCockpitInputVersionsParams{WorkspaceID: p.WorkspaceID, Ids: ids})
	if err != nil {
		return nil, err
	}
	metadata := map[pgtype.UUID]db.ReadCockpitInputVersionsRow{}
	heads, issues, attachments, artifacts, artifactVersions := []pgtype.UUID{}, []pgtype.UUID{}, []pgtype.UUID{}, []pgtype.UUID{}, []pgtype.UUID{}
	actors := []inputProjectionActor{}
	permissionRows := []db.CockpitInputVersion{}
	for _, v := range rows {
		if v.WorkspaceID != p.WorkspaceID {
			return nil, inputProjectionMissing()
		}
		metadata[v.ID] = v
		heads = append(heads, v.InputID)
		actors = append(actors, inputProjectionVersionActor(v))
		issues = append(issues, v.SourceAttachmentIssueID)
		attachments = append(attachments, v.SourceAttachmentID)
		artifacts = append(artifacts, v.SourceArtifactID)
		artifactVersions = append(artifactVersions, v.SourceArtifactVersionID)
		permissionRows = append(permissionRows, db.CockpitInputVersion{ID: v.ID, WorkspaceID: v.WorkspaceID, InputID: v.InputID})
	}
	allowed, err := inputReadableVersions(ctx, q, p, a, permissionRows)
	if err != nil {
		return nil, err
	}
	for _, id := range ids {
		if _, ok := metadata[id]; !ok || !allowed[id] {
			return nil, inputProjectionMissing()
		}
	}
	headerRows, err := inputProjectionHeadMap(ctx, q, p, heads)
	if err != nil {
		return nil, err
	}
	labels, err := loadInputProjectionLabels(ctx, q, p, actors, issues)
	if err != nil {
		return nil, err
	}
	attachmentRows := map[pgtype.UUID]db.ReadCockpitInputSourceAttachmentsRow{}
	for _, batch := range inputProjectionChunks(attachments) {
		found, e := q.ReadCockpitInputSourceAttachments(ctx, db.ReadCockpitInputSourceAttachmentsParams{WorkspaceID: p.WorkspaceID, Ids: batch})
		if e != nil {
			return nil, e
		}
		for _, v := range found {
			attachmentRows[v.ID] = v
		}
	}
	artifactRows := map[pgtype.UUID]db.ReadCockpitInputSourceArtifactsRow{}
	for _, batch := range inputProjectionChunks(artifacts) {
		found, e := q.ReadCockpitInputSourceArtifacts(ctx, db.ReadCockpitInputSourceArtifactsParams{WorkspaceID: p.WorkspaceID, Ids: batch})
		if e != nil {
			return nil, e
		}
		for _, v := range found {
			artifactRows[v.ID] = v
		}
	}
	artifactVersionRows := map[pgtype.UUID]db.ReadCockpitInputSourceArtifactVersionsRow{}
	for _, batch := range inputProjectionChunks(artifactVersions) {
		found, e := q.ReadCockpitInputSourceArtifactVersions(ctx, db.ReadCockpitInputSourceArtifactVersionsParams{WorkspaceID: p.WorkspaceID, Ids: batch})
		if e != nil {
			return nil, e
		}
		for _, v := range found {
			artifactVersionRows[v.ID] = v
		}
	}
	latestRows, err := q.ReadCockpitInputLatestTransfers(ctx, db.ReadCockpitInputLatestTransfersParams{WorkspaceID: p.WorkspaceID, Ids: ids})
	if err != nil {
		return nil, err
	}
	latest := map[pgtype.UUID]pgtype.UUID{}
	for _, row := range latestRows {
		latest[row.VersionID] = row.ID
	}
	for _, id := range ids {
		row := metadata[id]
		head := headerRows[row.InputID]
		source := CockpitInputSourceMetadata{Kind: row.SourceKind, AttachmentID: planningUUID(row.SourceAttachmentID), RootID: planningUUID(row.SourceRootID), RelativePath: inputText(row.SourceRelativePath), ArtifactID: planningUUID(row.SourceArtifactID), ArtifactVersionID: planningUUID(row.SourceArtifactVersionID)}
		switch row.SourceKind {
		case "upload":
			source.SourceUnavailableReason = "local_source_not_checked"
		case "attachment":
			source.Issue = labels.issue(row.SourceAttachmentIssueID)
			attachment, ok := attachmentRows[row.SourceAttachmentID]
			source.SourceAvailable = ok && attachment.IssueID == row.SourceAttachmentIssueID && source.Issue != nil
			if !source.SourceAvailable {
				source.SourceUnavailableReason = "source_deleted"
			}
		case "artifact_version":
			artifact, headOK := artifactRows[row.SourceArtifactID]
			version, versionOK := artifactVersionRows[row.SourceArtifactVersionID]
			if headOK {
				source.ArtifactTitle = artifact.Title
			}
			if versionOK && version.ArtifactID == row.SourceArtifactID {
				number, decision := version.VersionNumber, version.Decision
				source.ArtifactVersionNumber = &number
				source.ArtifactDecision = &decision
			}
			source.SourceAvailable = headOK && versionOK && version.ArtifactID == row.SourceArtifactID && version.CaptureStatus == "ready"
			if !source.SourceAvailable {
				source.SourceUnavailableReason = "source_unavailable"
			}
		case "nas_file":
			source.SourceAvailable, source.SourceUnavailableReason = s.inputProjectionNASSource(row)
		default:
			source.SourceUnavailableReason = "unsupported_source"
		}
		dto := CockpitInputVersionMetadata{WorkspaceID: util.UUIDToString(row.WorkspaceID), InputID: util.UUIDToString(row.InputID), ID: util.UUIDToString(row.ID), VersionNumber: row.VersionNumber, SubmissionKey: util.UUIDToString(row.SubmissionKey), Revision: row.Revision, PayloadKind: row.PayloadKind, Source: source, SubmittedBy: labels.principal(inputProjectionVersionActor(row)), Filename: row.Filename, ContentType: row.ContentType, DeclaredSizeBytes: inputInt(row.DeclaredSizeBytes), SizeBytes: inputInt(row.PinnedSizeBytes), ContentHash: inputText(row.ContentHash), CaptureState: row.CaptureState, CaptureErrorCode: row.CaptureErrorCode, Availability: row.Availability, CheckedAt: timestamp(row.CheckedAt), UnavailableReason: row.VerificationErrorCode, ActiveTransferID: planningUUID(row.ActiveTransferID), AcceptedTransferID: planningUUID(row.AcceptedTransferID), CurrentTransferID: planningUUID(row.CurrentTransferID), LatestTransferID: planningUUID(latest[row.ID]), CreatedAt: inputTime(row.CreatedAt), ReadyAt: timestamp(row.ReadyAt), AllowedRestartModes: []string{}, BlockedReasons: []string{}}
		inputProjectionVersionActions(&dto, p, a, head, row, s.inputFileCaptureAvailable(), s.CockpitInputCapturer != nil && storage.SupportsPrivateArtifactFiles(s.CockpitInputStorage))
		out[id] = dto
	}
	return out, nil
}
func (s *IssueService) inputProjectionNASSource(v db.ReadCockpitInputVersionsRow) (bool, string) {
	if s.CockpitInputConfigurationError != "" {
		return false, s.CockpitInputConfigurationError
	}
	if s.CockpitInputNAS == nil {
		return false, "input_scope_not_configured"
	}
	root, err := s.CockpitInputNAS.InputRoot(util.UUIDToString(v.WorkspaceID))
	if err != nil {
		return false, "input_scope_not_configured"
	}
	if root.RootID != util.UUIDToString(v.SourceRootID) || !v.SourceRootPath.Valid || v.SourceRootPath.String != root.Path || !v.SourceRootConfigHash.Valid || v.SourceRootConfigHash.String != root.RootConfigHash {
		return false, "root_config_changed"
	}
	relative := v.SourceRelativePath.String
	if !v.SourceRelativePath.Valid || relative == "" || !filepath.IsLocal(relative) || filepath.Clean(relative) != relative || strings.Contains(relative, "\\") {
		return false, "source_unavailable"
	}
	for _, scope := range root.Subpaths {
		within, err := filepath.Rel(scope, relative)
		if err == nil && filepath.IsLocal(within) {
			return true, ""
		}
	}
	return false, "input_scope_not_configured"
}
func inputProjectionVersionActions(dto *CockpitInputVersionMetadata, p CockpitInputRead, a cockpitInputAuthority, h db.ReadCockpitInputHeadersRow, v db.ReadCockpitInputVersionsRow, privateInputs, privateArtifacts bool) {
	if !inputProjectionKnownActor(v.ActorType) || !inputProjectionKnownCapture(v.CaptureState) || !inputProjectionKnownAvailability(v.Availability) || !inputProjectionKnownSource(v.SourceKind) || (v.PayloadKind != "file" && v.PayloadKind != "text") {
		dto.BlockedReasons = append(dto.BlockedReasons, "unsupported_input_state")
		return
	}
	manager := inputProjectionManager(p, a, h)
	pin := inputProjectionHasPin(v)
	ready := v.CaptureState == "ready" && pin
	sameMachine := p.ActorSource == "task_token" && inputLiveAuthority(p, a) && inputSameSource(v.SourceAgentID, v.SourceIssueID, v.AuthorizingUserID, a)
	contentCap := privateInputs
	if !v.CurrentTransferID.Valid && v.SourceKind == "artifact_version" {
		contentCap = dto.Source.SourceAvailable && (v.PayloadKind == "text" || privateArtifacts)
	}
	dto.CanDownload = ready && contentCap && v.Availability != "unavailable"
	dto.CanVerify = ready && contentCap && !v.VerificationDueAt.Valid && !(v.VerificationLeaseExpiresAt.Valid && v.VerificationLeaseExpiresAt.Time.After(time.Now()))
	dto.CanReference = ready && p.ActorSource == "human"
	if !contentCap {
		reason := "private_storage_required"
		if v.SourceKind == "artifact_version" && !v.CurrentTransferID.Valid && !dto.Source.SourceAvailable {
			reason = dto.Source.SourceUnavailableReason
		}
		dto.BlockedReasons = append(dto.BlockedReasons, reason)
	}
	if v.Availability == "unavailable" && v.VerificationErrorCode != "" {
		dto.BlockedReasons = append(dto.BlockedReasons, v.VerificationErrorCode)
	}
	if v.ActiveTransferID.Valid {
		dto.BlockedReasons = append(dto.BlockedReasons, "transfer_in_progress")
		return
	}
	if privateInputs {
		if manager {
			if pin {
				dto.AllowedRestartModes = append(dto.AllowedRestartModes, "upload_matching_bytes")
			}
			if v.SourceKind == "upload" && !pin || v.SourceKind != "upload" && dto.Source.SourceAvailable && (v.SourceKind != "artifact_version" || v.PayloadKind == "text" || privateArtifacts) {
				dto.AllowedRestartModes = append(dto.AllowedRestartModes, "retry_source")
			}
		} else if sameMachine && (v.SourceKind == "upload" || v.SourceKind == "attachment" && v.SourceAttachmentIssueID == a.Run.IssueID && dto.Source.SourceAvailable) {
			dto.AllowedRestartModes = append(dto.AllowedRestartModes, "retry_source")
		}
	}
	dto.CanRestart = len(dto.AllowedRestartModes) > 0
}

func (s *IssueService) inputTransfers(ctx context.Context, q *db.Queries, p CockpitInputRead, located []db.CockpitInputTransfer) ([]CockpitInputTransferMetadata, error) {
	ids, err := inputProjectionIDs(p, located, func(r db.CockpitInputTransfer) (pgtype.UUID, pgtype.UUID) { return r.ID, r.WorkspaceID })
	if err != nil {
		return nil, err
	}
	out := []CockpitInputTransferMetadata{}
	if len(ids) == 0 {
		return out, nil
	}
	a, err := inputReadPrincipal(ctx, q, p)
	if err != nil {
		return nil, err
	}
	rows, err := q.ReadCockpitInputTransfers(ctx, db.ReadCockpitInputTransfersParams{WorkspaceID: p.WorkspaceID, Ids: ids})
	if err != nil {
		return nil, err
	}
	byID := map[pgtype.UUID]db.ReadCockpitInputTransfersRow{}
	versionIDs, headIDs := []pgtype.UUID{}, []pgtype.UUID{}
	actors := []inputProjectionActor{}
	for _, r := range rows {
		if r.WorkspaceID != p.WorkspaceID {
			return nil, inputProjectionMissing()
		}
		byID[r.ID] = r
		versionIDs = append(versionIDs, r.VersionID)
		headIDs = append(headIDs, r.InputID)
		actors = append(actors, inputProjectionTransferActor(r))
	}
	versions, err := s.inputVersionProjectionByIDs(ctx, q, p, a, inputUniqueIDs(versionIDs))
	if err != nil {
		return nil, err
	}
	heads, err := inputProjectionHeadMap(ctx, q, p, headIDs)
	if err != nil {
		return nil, err
	}
	labels, err := loadInputProjectionLabels(ctx, q, p, actors, nil)
	if err != nil {
		return nil, err
	}
	for _, want := range located {
		row, ok := byID[want.ID]
		if !ok || want.InputID.Valid && want.InputID != row.InputID || want.VersionID.Valid && want.VersionID != row.VersionID {
			return nil, inputProjectionMissing()
		}
		version, ok := versions[row.VersionID]
		if !ok || version.InputID != util.UUIDToString(row.InputID) {
			return nil, inputProjectionMissing()
		}
		dto := CockpitInputTransferMetadata{WorkspaceID: util.UUIDToString(row.WorkspaceID), InputID: util.UUIDToString(row.InputID), VersionID: util.UUIDToString(row.VersionID), ID: util.UUIDToString(row.ID), TransferNumber: row.TransferNumber, CommandKey: util.UUIDToString(row.CommandKey), Kind: row.Kind, Mode: row.Mode, State: row.State, Revision: row.Revision, Principal: labels.principal(inputProjectionTransferActor(row)), ReceivedBytes: inputInt(row.BytesReceived), ExpectedBytes: row.ExpectedBytes, PinnedSizeBytes: inputInt(row.PinnedSizeBytes), ContentHash: inputText(row.ContentHash), SessionExpiresAt: timestamp(row.SessionExpiresAt), LeaseExpiresAt: timestamp(row.LeaseExpiresAt), CreatedAt: inputTime(row.CreatedAt), FinishedAt: timestamp(row.FinishedAt), ErrorCode: row.ErrorCode, BlockedReasons: []string{}}
		inputProjectionTransferActions(&dto, p, a, heads[row.InputID], row, version, s.inputFileCaptureAvailable(), time.Now())
		out = append(out, dto)
	}
	return out, nil
}
func inputProjectionExactTransferActor(p CockpitInputRead, a cockpitInputAuthority, t db.ReadCockpitInputTransfersRow) bool {
	if p.ActorSource == "human" {
		return t.ActorType.String == "member" && t.ActorID == p.CredentialOwnerID && t.CredentialOwnerUserID == p.CredentialOwnerID && t.AuthorizingUserID == p.CredentialOwnerID
	}
	return p.ActorSource == "task_token" && t.ActorType.String == "agent" && t.ActorID == p.AgentID && t.CredentialOwnerUserID == p.CredentialOwnerID && t.SourceAgentID == p.AgentID && t.SourceRunID == p.RunID && t.SourceRuntimeID == a.Run.RuntimeID && t.SourceIssueID == a.Run.IssueID && t.AuthorizingUserID == a.Run.OriginatorUserID
}
func inputProjectionTransferActions(dto *CockpitInputTransferMetadata, p CockpitInputRead, a cockpitInputAuthority, h db.ReadCockpitInputHeadersRow, t db.ReadCockpitInputTransfersRow, v CockpitInputVersionMetadata, privateInputs bool, now time.Time) {
	if !inputProjectionKnownTransfer(t.State) || !inputProjectionKnownActor(t.ActorType.String) || (t.Kind != "direct_upload" && t.Kind != "source_capture") || (t.Mode != "initial" && t.Mode != "retry_source" && t.Mode != "upload_matching_bytes") {
		dto.BlockedReasons = append(dto.BlockedReasons, "unsupported_input_state")
		return
	}
	manager := inputProjectionManager(p, a, h)
	versionSource := v.SubmittedBy.AgentID != nil && v.SubmittedBy.IssueID != nil && *v.SubmittedBy.AgentID == util.UUIDToString(a.Run.AgentID) && *v.SubmittedBy.IssueID == util.UUIDToString(a.Run.IssueID) && v.SubmittedBy.AuthorizingUserID == util.UUIDToString(a.Run.OriginatorUserID)
	ownLive := p.ActorSource == "task_token" && inputLiveAuthority(p, a) && versionSource
	exact := inputProjectionExactTransferActor(p, a, t)
	active := v.ActiveTransferID != nil && *v.ActiveTransferID == dto.ID
	latest := v.LatestTransferID != nil && *v.LatestTransferID == dto.ID
	dto.CanUpload = active && latest && privateInputs && t.Kind == "direct_upload" && t.State == "awaiting_bytes" && t.SessionExpiresAt.Valid && now.Before(t.SessionExpiresAt.Time) && exact && (manager || ownLive)
	pin := t.ContentPinAt.Valid && t.PinnedSizeBytes.Valid && t.PinnedSizeBytes.Int64 >= 0 && t.ContentHash.Valid && len(t.ContentHash.String) == 64
	accepted := pin && t.IoFinishedAt.Valid && t.IoOutcome.Valid && t.IoOutcome.String == "verified"
	retainedMachine := p.ActorSource == "task_token" && exact && (a.Run.Status == "completed" || a.Run.Status == "failed" || a.Run.Status == "cancelled")
	dto.CanFinalize = active && privateInputs && t.State == "awaiting_finalize" && accepted && (manager || ownLive || retainedMachine)
	dto.CanAbandon = active && !inputProjectionTerminal(t.State) && (manager || ownLive)
	dto.CanRestart = latest && v.CanRestart
	if !privateInputs {
		dto.BlockedReasons = append(dto.BlockedReasons, "private_storage_required")
	}
	if t.Kind == "direct_upload" && t.State == "awaiting_bytes" && t.SessionExpiresAt.Valid && !now.Before(t.SessionExpiresAt.Time) {
		dto.BlockedReasons = append(dto.BlockedReasons, "session_expired")
	}
	if !manager && !ownLive && !retainedMachine {
		dto.BlockedReasons = append(dto.BlockedReasons, "permission_revoked")
	}
}


// Principal DTOs can come from retained receipts. Invalid identities are an
// integrity failure, never anonymous identities or a missing-object response.
func inputParsePrincipalIDs(p CockpitInputPrincipal) (inputProjectionActor, error) {
	out := inputProjectionActor{kind: p.ActorType}
	if p.ActorType != "member" && p.ActorType != "agent" {
		return out, inputError("input_integrity_error", "The retained input principal kind is invalid.")
	}
	for _, field := range []struct {
		value  string
		target *pgtype.UUID
	}{
		{p.ActorID, &out.actor}, {p.CredentialOwnerUserID, &out.credential}, {p.AuthorizingUserID, &out.authorizer},
	} {
		id, err := util.ParseUUID(field.value)
		if err != nil || !id.Valid {
			return out, inputError("input_integrity_error", "The retained input principal identity is invalid.")
		}
		*field.target = id
	}
	for _, field := range []struct {
		value  *string
		target *pgtype.UUID
	}{
		{p.AgentID, &out.agent}, {p.RunID, &out.run}, {p.IssueID, &out.issue}, {p.RuntimeID, &out.runtime},
	} {
		if field.value == nil {
			continue
		}
		id, err := util.ParseUUID(*field.value)
		if err != nil || !id.Valid {
			return out, inputError("input_integrity_error", "The retained input task identity is invalid.")
		}
		*field.target = id
	}
	return out, nil
}
