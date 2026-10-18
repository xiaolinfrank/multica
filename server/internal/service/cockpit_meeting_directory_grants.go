package service

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// The one accepted transition is proven by the fixed base step's successful
// attempt and its exact retained grant. Only observations matching that grant
// share the transition; partial retry cannot rebase unselected older grants.
func directoryEffectiveBinding(o db.CockpitMeetingDirectoryOperation, g CockpitDirectoryGrant, base *CockpitDirectoryBinding) CockpitDirectoryBinding {
	b := g.ObservedBinding
	if o.AcceptedBindingRevision.Valid && o.BindAfterBase && base != nil && base.NASDir != o.Directory && o.AcceptedBindingRevision.Int64 == base.Revision+1 && b == *base {
		return CockpitDirectoryBinding{NASDir: o.Directory, Revision: o.AcceptedBindingRevision.Int64}
	}
	return b
}
func directoryAcceptedBindings(ctx context.Context, q *db.Queries, ws pgtype.UUID, operations []db.CockpitMeetingDirectoryOperation) (map[pgtype.UUID]CockpitDirectoryBinding, error) {
	ids := []pgtype.UUID{}
	expected := map[pgtype.UUID]db.CockpitMeetingDirectoryOperation{}
	for _, o := range operations {
		if o.AcceptedBindingRevision.Valid {
			ids = append(ids, o.ID)
			expected[o.ID] = o
		}
	}
	result := map[pgtype.UUID]CockpitDirectoryBinding{}
	if len(ids) == 0 {
		return result, nil
	}
	rows, err := q.ReadCockpitDirectoryAcceptedBindings(ctx, db.ReadCockpitDirectoryAcceptedBindingsParams{WorkspaceID: ws, Column2: ids})
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		o, ok := expected[r.OperationID]
		if !ok {
			return nil, fmt.Errorf("accepted base belongs to another directory operation")
		}
		var g CockpitDirectoryGrant
		if err = json.Unmarshal(r.Grant, &g); err != nil {
			return nil, err
		}
		if g.CommandKey != util.UUIDToString(r.GrantCommandKey) || g.Revision != r.GrantRevision || g.TargetHash != o.TargetHash || g.ObservedBinding.Revision+1 != o.AcceptedBindingRevision.Int64 || g.ObservedBinding.NASDir == o.Directory {
			return nil, fmt.Errorf("accepted directory binding lacks its exact successful base grant")
		}
		if _, dup := result[r.OperationID]; dup {
			return nil, fmt.Errorf("directory operation has more than one accepted base")
		}
		result[r.OperationID] = g.ObservedBinding
	}
	if len(result) != len(expected) {
		return nil, fmt.Errorf("accepted directory binding is missing its successful attempt")
	}
	return result, nil
}

// Read and write callers use the same exact-grant checks. Permission facts are
// collected once for the whole bounded page, rather than once for each card.
func (s *IssueService) ValidateCockpitDirectoryGrants(ctx context.Context, q *db.Queries, p CockpitDirectoryRead, m db.CockpitMeeting, operations []db.CockpitMeetingDirectoryOperation, steps []db.CockpitMeetingDirectoryStep, grants map[pgtype.UUID]CockpitDirectoryGrant) (map[pgtype.UUID][]string, error) {
	result := map[pgtype.UUID][]string{}
	byID := map[pgtype.UUID]db.CockpitMeetingDirectoryOperation{}
	for _, o := range operations {
		byID[o.ID] = o
		result[o.ID] = []string{}
	}
	type identity struct {
		UserID  string  `json:"user_id"`
		AgentID *string `json:"agent_id"`
	}
	identities := []identity{}
	seen := map[string]bool{}
	for _, step := range steps {
		if step.State == "satisfied" || step.State == "abandoned" {
			continue
		}
		g, ok := grants[step.GrantCommandKey]
		if !ok {
			return nil, fmt.Errorf("directory step has no retained grant")
		}
		var agent *string
		if g.Kind == "delegated_task" {
			agent = g.Principal.AgentID
		}
		i := identity{UserID: g.ResponsibleUserID, AgentID: agent}
		key := planningHash(i)
		if !seen[key] {
			seen[key] = true
			identities = append(identities, i)
		}
	}
	permissions := map[string]bool{}
	if len(identities) > 0 {
		rows, err := q.ReadCockpitDirectoryPermissionFacts(ctx, db.ReadCockpitDirectoryPermissionFactsParams{WorkspaceID: p.WorkspaceID, Identities: directoryRaw(identities)})
		if err != nil {
			return nil, err
		}
		for _, r := range rows {
			allowed := r.MemberExists
			if r.AgentID.Valid {
				allowed = allowed && r.Status.Valid && cockpitAssignableAgentStatus(r.Status.String) && r.PermissionMode.Valid && memberInvocationFactsAllowed(r.OwnerID, r.UserID, r.PermissionMode.String, true, r.WorkspaceTarget, r.MemberTarget)
			}
			permissions[planningHash(identity{UserID: util.UUIDToString(r.UserID), AgentID: planningUUID(r.AgentID)})] = allowed
		}
	}
	accepted, err := directoryAcceptedBindings(ctx, q, p.WorkspaceID, operations)
	if err != nil {
		return nil, err
	}
	add := func(id pgtype.UUID, code string) {
		for _, old := range result[id] {
			if old == code {
				return
			}
		}
		result[id] = append(result[id], code)
	}
	for _, step := range steps {
		if step.State == "satisfied" || step.State == "abandoned" {
			continue
		}
		o, ok := byID[step.OperationID]
		if !ok || o.WorkspaceID != p.WorkspaceID || o.MeetingID != m.ID {
			return nil, ErrCockpitWorkflowForbidden
		}
		g := grants[step.GrantCommandKey]
		if g.CommandKey != util.UUIDToString(step.GrantCommandKey) || g.Revision != step.GrantRevision || g.TargetHash != o.TargetHash {
			return nil, fmt.Errorf("directory step grant does not match its fixed identity")
		}
		if g.Kind != "human" && g.Kind != "delegated_task" {
			add(o.ID, "permission_revoked")
			continue
		}
		if (g.Kind == "human" && (g.Principal.Source != "human" || g.Principal.ActorType != "member" || g.Principal.ActorID != g.ResponsibleUserID || g.Principal.ConfirmedByUserID == nil || *g.Principal.ConfirmedByUserID != g.Principal.ActorID)) ||
			(g.Kind == "delegated_task" && (g.Principal.Source != "task_token" || g.Principal.ActorType != "agent" || g.Principal.AgentID == nil || *g.Principal.AgentID != g.Principal.ActorID || g.Principal.RunID == nil || g.Principal.IssueID == nil || g.Principal.RuntimeID == nil || g.Principal.ConfirmedByUserID != nil)) {
			return nil, fmt.Errorf("directory grant carries inconsistent principal facts")
		}
		var agent *string
		if g.Kind == "delegated_task" {
			agent = g.Principal.AgentID
			if agent == nil {
				add(o.ID, "permission_revoked")
			}
		}
		if g.ResponsibleUserID != util.UUIDToString(o.ResponsibleUserID) || g.Principal.AuthorizingUserID != g.ResponsibleUserID || !permissions[planningHash(identity{UserID: g.ResponsibleUserID, AgentID: agent})] {
			add(o.ID, "permission_revoked")
		}
		if m.OccurrenceState == "cancelled" {
			add(o.ID, "meeting_cancelled")
		}
		var base *CockpitDirectoryBinding
		if b, ok := accepted[o.ID]; ok {
			base = &b
		}
		want := directoryEffectiveBinding(o, g, base)
		if want.NASDir != m.NasDir || want.Revision != m.NasDirRevision {
			add(o.ID, "binding_changed")
		}
		if s.CockpitDirectoryConfigurationError != "" {
			add(o.ID, "prepare_configuration_invalid")
			continue
		}
		if s.CockpitDirectoryPreparer == nil {
			add(o.ID, "prepare_not_configured")
			continue
		}
		current, err := s.CockpitDirectoryPreparer.ResolvePreparation(util.UUIDToString(p.WorkspaceID), util.UUIDToString(o.RootID), o.RelativeDirectory)
		if err != nil {
			add(o.ID, directoryCode(err))
			continue
		}
		if current.RootPath != o.RootPath || current.Directory != o.Directory || current.RootConfigHash != g.RootConfigHash {
			add(o.ID, "root_config_changed")
		}
		rel, scopeErr := filepath.Rel(filepath.Join(current.RootPath, current.PrepareSubpath), filepath.Join(current.RootPath, step.RelativePath))
		if scopeErr != nil || !filepath.IsLocal(rel) {
			add(o.ID, "prepare_path_outside_scope")
		}
	}
	for id := range result {
		sort.Strings(result[id])
	}
	return result, nil
}
