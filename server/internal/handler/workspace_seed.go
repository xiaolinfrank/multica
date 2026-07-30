package handler

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/seed"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

const (
	seedHTTPTimeout    = 30 * time.Second
	seedOverallTimeout = 8 * time.Minute

	// seedPreferredProvider is the provider preset agents bind to when the
	// registering daemon offers it. The daemon builds its registration batch by
	// iterating a Go map, so batch order is random; without a preference the
	// first online entry wins and preset agents end up bound to an arbitrary
	// provider (hermes, openclaw, …) instead of Claude Code.
	seedPreferredProvider = "claude"
)

// preferSeedRuntime decides whether the runtime row being registered should
// become the seed binding: any online runtime fills an empty slot, but only
// the preferred provider displaces an already-picked non-preferred one. Once
// the preferred provider is picked, nothing else displaces it.
func preferSeedRuntime(currentProvider string, currentValid bool, candidateOnline bool, candidateProvider string) bool {
	if !candidateOnline {
		return false
	}
	if !currentValid {
		return true
	}
	return currentProvider != seedPreferredProvider && candidateProvider == seedPreferredProvider
}

// seedDefaultWorkspaceTeam imports the embedded preset (skills + agents + MCP +
// avatars + squads) into a freshly-bootstrapped workspace, binding every agent
// to runtimeID. It is meant to run in its own goroutine off DaemonRegister, so
// it builds a fresh background context — the request's is cancelled the moment
// register returns.
//
// Best-effort and idempotent: skills/agents are reused by name (so a partial
// run tops up rather than duplicating), and squads — which nothing else creates
// — are only written once every skill/agent they reference is in place. That
// makes "the workspace has at least one squad" a reliable "fully seeded" marker:
// a GitHub fetch hiccup leaves the squads unwritten, and the next register
// retries the whole flow.
func (h *Handler) seedDefaultWorkspaceTeam(wsID, runtimeID pgtype.UUID, runtimeMode string, ownerID pgtype.UUID) {
	defer func() {
		if rec := recover(); rec != nil {
			slog.Error("seed: panic recovered", "panic", rec, "workspace_id", uuidToString(wsID))
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), seedOverallTimeout)
	defer cancel()

	preset, err := seed.LoadPreset()
	if err != nil {
		slog.Error("seed: load preset failed", "error", err)
		return
	}

	// Idempotency gate: a workspace that already has a squad is fully seeded.
	squads, err := h.Queries.ListAllSquads(ctx, wsID)
	if err != nil {
		slog.Warn("seed: list squads failed", "error", err, "workspace_id", uuidToString(wsID))
		return
	}
	if len(squads) > 0 {
		return
	}

	slog.Info("seed: bootstrapping default team", "workspace_id", uuidToString(wsID), "preset", preset.Preset)
	httpClient := &http.Client{Timeout: seedHTTPTimeout}

	// complete tracks whether every skill, agent, and binding landed. Squads are
	// deferred unless it stays true, keeping the gate above honest.
	complete := true
	skillIDByName := make(map[string]pgtype.UUID)

	for i := range preset.SkillsInline {
		s := &preset.SkillsInline[i]
		id, err := h.seedInlineSkill(ctx, wsID, ownerID, s)
		if err != nil {
			slog.Warn("seed: inline skill failed", "skill", s.Name, "error", err)
			complete = false
			continue
		}
		skillIDByName[s.Name] = id
	}
	for i := range preset.SkillsImport {
		s := &preset.SkillsImport[i]
		id, err := h.seedImportedSkill(ctx, httpClient, wsID, ownerID, s)
		if err != nil {
			slog.Warn("seed: import skill failed", "skill", s.Name, "url", s.SourceURL, "error", err)
			complete = false
			continue
		}
		skillIDByName[s.Name] = id
	}

	existing, err := h.Queries.ListAgents(ctx, wsID)
	if err != nil {
		slog.Warn("seed: list agents failed", "error", err, "workspace_id", uuidToString(wsID))
		return
	}
	agentIDByName := make(map[string]pgtype.UUID)
	for _, a := range existing {
		if !a.ArchivedAt.Valid {
			agentIDByName[a.Name] = a.ID
		}
	}

	for i := range preset.Agents {
		a := &preset.Agents[i]
		id, ok := agentIDByName[a.Name]
		if !ok {
			created, err := h.Queries.CreateAgent(ctx, seedAgentParams(wsID, runtimeID, runtimeMode, ownerID, a))
			if err != nil {
				slog.Warn("seed: create agent failed", "agent", a.Name, "error", err)
				complete = false
				continue
			}
			id = created.ID
			agentIDByName[a.Name] = id
			// permission_mode='public_to' only grants anything once a matching
			// target row exists — canInvokeAgent OR-matches the allow-list and
			// admits nobody on an empty one. target_id must be the workspace id,
			// not NULL, or the UNIQUE(agent_id, target_type, target_id) dedup
			// stops working (Postgres treats NULLs as distinct).
			if err := replaceInvocationTargetsWithQueries(ctx, h.Queries, id, ownerID, []targetSpec{
				{targetType: "workspace", targetID: wsID},
			}); err != nil {
				slog.Warn("seed: grant workspace invocation target failed", "agent", a.Name, "error", err)
				complete = false
			}
		}
		for _, sn := range a.SkillNames {
			sid, ok := skillIDByName[sn]
			if !ok {
				complete = false
				continue
			}
			if err := h.Queries.AddAgentSkill(ctx, db.AddAgentSkillParams{AgentID: id, SkillID: sid}); err != nil {
				slog.Warn("seed: bind skill failed", "agent", a.Name, "skill", sn, "error", err)
				complete = false
			}
		}
	}

	if !complete {
		slog.Warn("seed: partial run, deferring squads to next register",
			"workspace_id", uuidToString(wsID), "skills", len(skillIDByName), "agents", len(agentIDByName))
		return
	}

	for i := range preset.Squads {
		sq := &preset.Squads[i]
		if err := h.seedSquad(ctx, wsID, ownerID, sq, agentIDByName); err != nil {
			slog.Warn("seed: create squad failed", "squad", sq.Name, "error", err)
		}
	}
	slog.Info("seed: default team complete", "workspace_id", uuidToString(wsID),
		"skills", len(skillIDByName), "agents", len(agentIDByName), "squads", len(preset.Squads))
}

func seedAgentParams(wsID, runtimeID pgtype.UUID, runtimeMode string, ownerID pgtype.UUID, a *seed.PresetAgent) db.CreateAgentParams {
	maxTasks := a.MaxConcurrentTasks
	if maxTasks <= 0 {
		maxTasks = 1
	}
	var mc []byte
	if len(a.McpConfig) > 0 {
		mc = []byte(a.McpConfig)
	}
	return db.CreateAgentParams{
		WorkspaceID:   wsID,
		Name:          a.Name,
		Description:   a.Description,
		Instructions:  a.Instructions,
		AvatarUrl:     pgtype.Text{String: a.AvatarURL, Valid: a.AvatarURL != ""},
		RuntimeMode:   runtimeMode,
		RuntimeConfig: []byte("{}"),
		RuntimeID:     runtimeID,
		Visibility:    "workspace",
		// Invocation permission is authorized by permission_mode + targets since
		// MUL-3963; visibility above is only the derived legacy field. Omitting
		// this compiles and stores fine but COALESCEs to 'private', which would
		// make every seeded agent owner-only — other members could @ or assign
		// them and get silence, with the UI still showing "workspace". The
		// matching workspace target row is inserted by seedAgent.
		PermissionMode:     "public_to",
		MaxConcurrentTasks: maxTasks,
		OwnerID:            ownerID,
		CustomEnv:          []byte("{}"),
		CustomArgs:         []byte("[]"),
		McpConfig:          mc,
		Model:              pgtype.Text{},
		ThinkingLevel:      pgtype.Text{},
	}
}

func (h *Handler) seedInlineSkill(ctx context.Context, wsID, ownerID pgtype.UUID, s *seed.PresetSkillInline) (pgtype.UUID, error) {
	if ex, err := h.Queries.GetSkillByWorkspaceAndName(ctx, db.GetSkillByWorkspaceAndNameParams{WorkspaceID: wsID, Name: s.Name}); err == nil {
		return ex.ID, nil
	} else if !isNotFound(err) {
		return pgtype.UUID{}, err
	}
	files := make([]CreateSkillFileRequest, 0, len(s.Files))
	for _, f := range s.Files {
		if !validateFilePath(f.Path) {
			continue
		}
		files = append(files, CreateSkillFileRequest{Path: f.Path, Content: f.Content})
	}
	resp, err := h.createSkillWithFiles(ctx, skillCreateInput{
		WorkspaceID: wsID,
		CreatorID:   ownerID,
		Name:        s.Name,
		Description: s.Description,
		Content:     s.Content,
		Config:      map[string]any{},
		Files:       files,
	})
	if err != nil {
		return pgtype.UUID{}, err
	}
	return parseUUID(resp.ID), nil
}

func (h *Handler) seedImportedSkill(ctx context.Context, httpClient *http.Client, wsID, ownerID pgtype.UUID, s *seed.PresetSkillImport) (pgtype.UUID, error) {
	// Reuse by the bundle's declared name first (preset names are the live
	// skill names, exported post-import, so they already match the frontmatter).
	if ex, err := h.Queries.GetSkillByWorkspaceAndName(ctx, db.GetSkillByWorkspaceAndNameParams{WorkspaceID: wsID, Name: s.Name}); err == nil {
		return ex.ID, nil
	} else if !isNotFound(err) {
		return pgtype.UUID{}, err
	}

	source, normalized, err := detectImportSource(s.SourceURL)
	if err != nil {
		return pgtype.UUID{}, err
	}
	var imported *importedSkill
	for attempt := 0; attempt < 2; attempt++ {
		switch source {
		case sourceClawHub:
			imported, err = fetchFromClawHub(ctx, httpClient, normalized)
		case sourceSkillsSh:
			imported, err = fetchFromSkillsSh(ctx, httpClient, normalized)
		case sourceGitHub:
			imported, err = fetchFromGitHub(ctx, httpClient, normalized)
		}
		if err == nil {
			break
		}
	}
	if err != nil {
		return pgtype.UUID{}, err
	}

	name := sanitizeNullBytes(imported.name)
	if name == "" {
		name = s.Name
	}
	// The frontmatter name can differ from the declared one; reuse if it exists.
	if ex, err := h.Queries.GetSkillByWorkspaceAndName(ctx, db.GetSkillByWorkspaceAndNameParams{WorkspaceID: wsID, Name: name}); err == nil {
		return ex.ID, nil
	} else if !isNotFound(err) {
		return pgtype.UUID{}, err
	}

	files := make([]CreateSkillFileRequest, 0, len(imported.files))
	for _, f := range imported.files {
		if !validateFilePath(f.path) {
			continue
		}
		files = append(files, CreateSkillFileRequest{Path: f.path, Content: f.content})
	}
	config := map[string]any{}
	if imported.origin != nil {
		config["origin"] = imported.origin
	}
	resp, err := h.createSkillWithFiles(ctx, skillCreateInput{
		WorkspaceID: wsID,
		CreatorID:   ownerID,
		Name:        name,
		Description: imported.description,
		Content:     imported.content,
		Config:      config,
		Files:       files,
	})
	if err != nil {
		return pgtype.UUID{}, err
	}
	return parseUUID(resp.ID), nil
}

func (h *Handler) seedSquad(ctx context.Context, wsID, ownerID pgtype.UUID, sq *seed.PresetSquad, agentIDByName map[string]pgtype.UUID) error {
	leaderID, ok := agentIDByName[sq.LeaderName]
	if !ok {
		return fmt.Errorf("leader %q missing", sq.LeaderName)
	}
	squad, err := h.Queries.CreateSquad(ctx, db.CreateSquadParams{
		WorkspaceID: wsID,
		Name:        sq.Name,
		Description: sq.Description,
		LeaderID:    leaderID,
		CreatorID:   ownerID,
		AvatarUrl:   pgtype.Text{},
	})
	if err != nil {
		return err
	}
	if _, err := h.Queries.AddSquadMember(ctx, db.AddSquadMemberParams{
		SquadID:    squad.ID,
		MemberType: "agent",
		MemberID:   leaderID,
		Role:       "leader",
	}); err != nil {
		return err
	}
	for _, m := range sq.MemberNames {
		if m == sq.LeaderName {
			continue
		}
		mid, ok := agentIDByName[m]
		if !ok {
			continue
		}
		if _, err := h.Queries.AddSquadMember(ctx, db.AddSquadMemberParams{
			SquadID:    squad.ID,
			MemberType: "agent",
			MemberID:   mid,
			Role:       "",
		}); err != nil {
			slog.Warn("seed: add squad member failed", "squad", sq.Name, "member", m, "error", err)
		}
	}
	return nil
}
