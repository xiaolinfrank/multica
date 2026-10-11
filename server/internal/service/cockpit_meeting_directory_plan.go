package service

import (
	"context"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/cockpitnas"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func directoryBinding(m db.CockpitMeeting) CockpitDirectoryBinding {
	return CockpitDirectoryBinding{NASDir: m.NasDir, Revision: m.NasDirRevision}
}
func directoryPrincipalFacts(p CockpitDirectoryPrincipal) any {
	return []any{p.Source, p.ActorType, p.ActorID, p.CredentialOwnerUserID, p.AuthorizingUserID, p.ConfirmedByUserID, p.RunID, p.IssueID, p.AgentID, p.RuntimeID, p.RelationKind, p.AgendaReferenceID}
}
func directoryPreviewToken(v CockpitDirectoryPreview, extra any) string {
	var principal any
	if v.Principal != nil {
		principal = directoryPrincipalFacts(*v.Principal)
	}
	return planningHash([]any{v.WorkspaceID, v.MeetingID, v.Target, v.PlanHash, v.ObservedBinding, v.BindAfterBase, principal, extra})
}
func directoryPlan(t cockpitnas.PreparationTarget, partitions []string) ([]CockpitDirectoryPreviewStep, string, error) {
	if len(partitions) > 16 {
		return nil, "", directoryError("invalid_input", "Choose at most 16 directory partitions.")
	}
	unique := map[string]bool{}
	for _, p := range partitions {
		if p == "" || p == "." || p == ".." || filepath.Base(p) != p || strings.ContainsAny(p, "/\\") || len(p) > 255 || !templateText(p, 255) || unique[p] {
			return nil, "", directoryError("invalid_input", "Partition names must be distinct, single directory names.")
		}
		unique[p] = true
	}
	// The deployment scope itself must already exist. Only its descendants are steps.
	paths := []string{}
	current := t.RelativeDirectory
	for current != t.PrepareSubpath {
		paths = append(paths, current)
		parent := filepath.Dir(current)
		if parent == current || len(paths) > 16 {
			return nil, "", directoryError("invalid_input", "The target is outside the configured preparation scope.")
		}
		current = parent
	}
	for i, j := 0, len(paths)-1; i < j; i, j = i+1, j-1 {
		paths[i], paths[j] = paths[j], paths[i]
	}
	if len(paths) == 0 {
		paths = append(paths, t.RelativeDirectory)
	}
	steps := []CockpitDirectoryPreviewStep{}
	for i, path := range paths {
		var parent *int32
		if i > 0 {
			v := int32(i - 1)
			parent = &v
		}
		kind := "ancestor"
		if path == t.RelativeDirectory {
			kind = "base"
		}
		steps = append(steps, CockpitDirectoryPreviewStep{Position: int32(i), ParentPosition: parent, Kind: kind, Label: filepath.Base(path), RelativePath: path, PathHash: planningHash([]string{t.RootID, path}), PlannedState: "unknown"})
	}
	base := int32(len(steps) - 1)
	for _, part := range partitions {
		path := filepath.Join(t.RelativeDirectory, part)
		steps = append(steps, CockpitDirectoryPreviewStep{Position: int32(len(steps)), ParentPosition: &base, Kind: "partition", Label: part, RelativePath: path, PathHash: planningHash([]string{t.RootID, path}), PlannedState: "unknown"})
	}
	if len(steps) > 32 {
		return nil, "", directoryError("invalid_input", "A directory plan may contain at most 32 fixed steps.")
	}
	// No mutable binding, existence observation, mode, names or principal enters the natural plan identity.
	return steps, planningHash([]any{t.RootID, t.RootPath, t.RelativeDirectory, partitions}), nil
}
func (s *IssueService) inspectDirectoryPreview(ctx context.Context, v *CockpitDirectoryPreview, t cockpitnas.PreparationTarget) {
	paths := make([]string, len(v.Steps))
	for i, x := range v.Steps {
		paths[i] = x.RelativePath
	}
	ioCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	inspections, err := s.CockpitDirectoryPreparer.InspectPreparation(ioCtx, t, paths)
	byPath := map[string]cockpitnas.PreparationInspection{}
	if err == nil {
		for _, x := range inspections {
			byPath[x.RelativePath] = x
		}
	}
	v.Counts = CockpitDirectoryPreviewCounts{Total: int32(len(paths))}
	for i := range v.Steps {
		x := &v.Steps[i]
		if err != nil {
			x.PlannedState = "unknown"
			x.ErrorCode = directoryCode(err)
		} else if observation, ok := byPath[x.RelativePath]; ok {
			x.PlannedState = observation.State
			x.ErrorCode = observation.ErrorCode
		} else {
			x.PlannedState = "unknown"
			x.ErrorCode = "read_unavailable"
		}
		switch x.PlannedState {
		case "exists":
			v.Counts.Exists++
		case "missing":
			v.Counts.Missing++
		case "conflict":
			v.Counts.Conflict++
		default:
			v.Counts.Unknown++
		}
	}
	if v.Counts.Conflict > 0 || v.Counts.Unknown > 0 {
		v.BlockedReasons = append(v.BlockedReasons, "directory_inspection_required")
	}
	v.CanConfirm = len(v.BlockedReasons) == 0 && v.Principal != nil
}
func (s *IssueService) PreviewCockpitMeetingDirectory(ctx context.Context, p CockpitDirectoryRead, in CockpitDirectoryPreviewInput) (CockpitDirectoryPreview, error) {
	out := CockpitDirectoryPreview{WorkspaceID: util.UUIDToString(p.WorkspaceID), MeetingID: util.UUIDToString(p.MeetingID), Steps: []CockpitDirectoryPreviewStep{}, BlockedReasons: []string{}, CheckedAt: directoryTime()}
	if p.ActorSource == "cloud_pat" {
		return out, directoryError("task_context_required", "A cloud-node credential may only read existing directory plans.")
	}
	if (in.Mode != "prepare" && in.Mode != "repair") || in.ObservedBindingRevision < 1 {
		return out, directoryError("invalid_input", "A preparation mode and observed binding revision are required.")
	}
	tx, q, m, err := s.directoryRead(ctx, p)
	if err != nil {
		return out, err
	}
	out.ObservedBinding = directoryBinding(m)
	out.BindAfterBase = in.BindAfterBase
	principal, principalErr := directoryPrincipal(ctx, q, p, false)
	_ = tx.Rollback(ctx)
	if principalErr != nil {
		out.BlockedReasons = append(out.BlockedReasons, directoryCode(principalErr))
	} else {
		out.Principal = &principal
	}
	if err = directoryNewPreparation(m); err != nil {
		out.BlockedReasons = append(out.BlockedReasons, directoryCode(err))
	}
	if m.NasDir != in.ObservedNASDir || m.NasDirRevision != in.ObservedBindingRevision {
		out.BlockedReasons = append(out.BlockedReasons, "binding_changed")
	}
	if s.CockpitDirectoryConfigurationError != "" {
		return out, directoryError("prepare_configuration_invalid", "The deployment's directory configuration is invalid.")
	}
	if s.CockpitDirectoryPreparer == nil {
		return out, directoryError("prepare_not_configured", "Directory preparation is not configured.")
	}
	t, err := s.CockpitDirectoryPreparer.ResolvePreparation(out.WorkspaceID, in.RootID, in.RelativeDirectory)
	if err != nil {
		return out, directoryConvertError(err)
	}
	out.Target = directoryTarget(t)
	if !in.BindAfterBase && m.NasDir != t.Directory {
		out.BlockedReasons = append(out.BlockedReasons, "binding_changed")
	}
	out.Steps, out.PlanHash, err = directoryPlan(t, in.Partitions)
	if err != nil {
		return out, err
	}
	s.inspectDirectoryPreview(ctx, &out, t)
	if out.Principal != nil {
		out.ContextToken = directoryPreviewToken(out, nil)
	}
	return out, nil
}
func directorySelectedSteps(all []db.CockpitMeetingDirectoryStep, ids []string) ([]db.CockpitMeetingDirectoryStep, error) {
	if len(ids) == 0 || len(ids) > 32 {
		return nil, directoryError("invalid_input", "Choose between 1 and 32 unfinished steps.")
	}
	wanted := map[string]bool{}
	for _, id := range ids {
		v, e := util.ParseUUID(id)
		if e != nil || !v.Valid || wanted[id] {
			return nil, directoryError("invalid_input", "Step IDs must be distinct UUIDs.")
		}
		wanted[id] = true
	}
	out := []db.CockpitMeetingDirectoryStep{}
	for _, st := range all {
		if wanted[util.UUIDToString(st.ID)] {
			if st.State == "satisfied" || st.State == "abandoned" || st.State == "running" {
				return nil, directoryError("step_not_retryable", "Select unfinished steps without an active attempt.")
			}
			out = append(out, st)
		}
	}
	if len(out) != len(ids) {
		return nil, directoryError("not_found", "A selected directory step is unavailable.")
	}
	return out, nil
}
func directoryRetryExtra(o db.CockpitMeetingDirectoryOperation, steps []db.CockpitMeetingDirectoryStep) any {
	facts := []any{o.ID, o.Revision}
	for _, st := range steps {
		facts = append(facts, []any{st.ID, st.Revision, st.GrantCommandKey, st.GrantRevision})
	}
	return facts
}
func directoryControlAuthority(member db.Member, principal CockpitDirectoryPrincipal, o db.CockpitMeetingDirectoryOperation) (responsible, manager bool) {
	if principal.Source == "human" {
		id, _ := util.ParseUUID(principal.ActorID)
		return id == o.ResponsibleUserID, id == o.AuthorizingUserID || member.Role == "owner" || member.Role == "admin"
	}
	if principal.Source == "task_token" && principal.AgentID != nil && principal.IssueID != nil {
		return principal.AuthorizingUserID == util.UUIDToString(o.AuthorizingUserID) && principal.AuthorizingUserID == util.UUIDToString(o.ResponsibleUserID) && *principal.AgentID == util.UUIDToString(o.SourceAgentID) && *principal.IssueID == util.UUIDToString(o.SourceIssueID), false
	}
	return false, false
}
func (s *IssueService) PreviewCockpitDirectoryRetry(ctx context.Context, p CockpitDirectoryQuery, in CockpitDirectoryRetryPreviewInput) (CockpitDirectoryRetryPreview, error) {
	out := CockpitDirectoryRetryPreview{OperationID: util.UUIDToString(p.OperationID), StepIDs: append([]string{}, in.StepIDs...)}
	tx, q, m, err := s.directoryRead(ctx, p.CockpitDirectoryRead)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	o, err := q.GetCockpitDirectoryOperation(ctx, db.GetCockpitDirectoryOperationParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: p.OperationID})
	if err != nil {
		return out, directoryConvertError(err)
	}
	all, err := q.ListCockpitDirectorySteps(ctx, db.ListCockpitDirectoryStepsParams{WorkspaceID: p.WorkspaceID, OperationID: o.ID})
	if err != nil {
		return out, err
	}
	steps, err := directorySelectedSteps(all, in.StepIDs)
	if err != nil {
		return out, err
	}
	baseErr := directoryRetryBaseGrant(ctx, q, p.CockpitDirectoryRead, m, o, all, steps)
	principal, pe := directoryPrincipal(ctx, q, p.CockpitDirectoryRead, false)
	member, err := directoryMembership(ctx, q, p.CockpitDirectoryRead)
	if err != nil {
		return out, err
	}
	_ = tx.Rollback(ctx)
	out.OperationRevision = o.Revision
	v := CockpitDirectoryPreview{WorkspaceID: util.UUIDToString(p.WorkspaceID), MeetingID: util.UUIDToString(p.MeetingID), PlanHash: o.PlanHash, ObservedBinding: directoryBinding(m), BindAfterBase: o.BindAfterBase, BlockedReasons: []string{}, Steps: []CockpitDirectoryPreviewStep{}, CheckedAt: directoryTime()}
	if baseErr != nil {
		v.BlockedReasons = append(v.BlockedReasons, directoryCode(baseErr))
	}
	if pe != nil {
		v.BlockedReasons = append(v.BlockedReasons, directoryCode(pe))
	} else {
		v.Principal = &principal
		responsible, _ := directoryControlAuthority(member, principal, o)
		if !responsible {
			v.BlockedReasons = append(v.BlockedReasons, "permission_revoked")
		}
	}
	if o.FinishedAt.Valid {
		v.BlockedReasons = append(v.BlockedReasons, "operation_finished")
	}
	if err = directoryExistingPreparation(m, o); err != nil {
		v.BlockedReasons = append(v.BlockedReasons, directoryCode(err))
	}
	if s.CockpitDirectoryConfigurationError != "" {
		return out, directoryError("prepare_configuration_invalid", "The directory configuration is invalid.")
	}
	if s.CockpitDirectoryPreparer == nil {
		return out, directoryError("prepare_not_configured", "Directory preparation is not configured.")
	}
	t, err := s.CockpitDirectoryPreparer.ResolvePreparation(v.WorkspaceID, util.UUIDToString(o.RootID), o.RelativeDirectory)
	if err != nil {
		return out, directoryConvertError(err)
	}
	if t.RootPath != o.RootPath || t.Directory != o.Directory {
		return out, directoryError("root_target_changed", "The physical root moved. Create a new plan for a different target.")
	}
	v.Target = directoryTarget(t)
	positions := map[pgtype.UUID]int32{}
	for _, st := range all {
		positions[st.ID] = st.Position
	}
	for _, st := range steps {
		var parent *int32
		if st.ParentStepID.Valid {
			pos := positions[st.ParentStepID]
			parent = &pos
		}
		v.Steps = append(v.Steps, CockpitDirectoryPreviewStep{StepID: planningUUID(st.ID), Position: st.Position, ParentPosition: parent, Kind: st.Kind, Label: st.Label, RelativePath: st.RelativePath, PathHash: st.PathHash})
	}
	sort.Slice(v.Steps, func(i, j int) bool { return v.Steps[i].Position < v.Steps[j].Position })
	s.inspectDirectoryPreview(ctx, &v, t)
	if v.Principal != nil {
		v.ContextToken = directoryPreviewToken(v, directoryRetryExtra(o, steps))
	}
	out.CockpitDirectoryPreview = v
	return out, nil
}
