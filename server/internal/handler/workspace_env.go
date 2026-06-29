package handler

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/logger"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// workspaceEnvActivity* are the activity_log `action` constants for the
// workspace-level shared-env endpoints, mirroring the per-agent ones in
// agent_env.go. Rows are written with issue_id NULL (env access is not tied
// to an issue) so workspace owners retain a forensic trail of who revealed
// or changed the shared secrets.
const (
	workspaceEnvActivityRevealed = "workspace_env_revealed"
	workspaceEnvActivityUpdated  = "workspace_env_updated"
)

// WorkspaceSharedEnvResponse is the wire shape for GET/PUT /api/env/shared.
// Kept distinct from the generic workspace resource so shared secrets can
// never leak back into a workspace list/get response by accident.
type WorkspaceSharedEnvResponse struct {
	SharedEnv map[string]string `json:"shared_env"`
}

// UpdateWorkspaceSharedEnvRequest is the wire shape for PUT /api/env/shared.
type UpdateWorkspaceSharedEnvRequest struct {
	SharedEnv map[string]string `json:"shared_env"`
}

// authorizeWorkspaceEnv enforces the same contract as authorizeAgentEnv but
// for the workspace-scoped shared-env endpoints: the actor must be a human
// member (agent-token actors are rejected outright, even if their backing
// member is an owner/admin) and must hold the owner or admin role. Returns
// the resolved workspace and the authenticated member on success; all
// non-2xx branches write their own response and return ok=false.
func (h *Handler) authorizeWorkspaceEnv(w http.ResponseWriter, r *http.Request) (db.Workspace, db.Member, bool) {
	workspaceID := h.resolveWorkspaceID(r)

	userID := requestUserID(r)
	if actorType, _ := h.resolveActor(r, userID, workspaceID); actorType == "agent" {
		writeError(w, http.StatusForbidden, "agents may not access env management endpoints")
		return db.Workspace{}, db.Member{}, false
	}

	member, ok := h.requireWorkspaceRole(w, r, workspaceID, "workspace not found", "owner", "admin")
	if !ok {
		return db.Workspace{}, db.Member{}, false
	}

	ws, err := h.Queries.GetWorkspace(r.Context(), parseUUID(workspaceID))
	if err != nil {
		writeError(w, http.StatusNotFound, "workspace not found")
		return db.Workspace{}, db.Member{}, false
	}

	return ws, member, true
}

// GetWorkspaceSharedEnv returns the plaintext workspace shared_env map after
// gating through authorizeWorkspaceEnv. Every successful reveal writes a
// `workspace_env_revealed` row (keys only, never values). Audit is
// fail-closed: if the row can't be persisted we refuse to serve the
// plaintext, matching GetAgentEnv — an unrecordable reveal is treated as an
// unaudited reveal and rejected.
func (h *Handler) GetWorkspaceSharedEnv(w http.ResponseWriter, r *http.Request) {
	ws, member, ok := h.authorizeWorkspaceEnv(w, r)
	if !ok {
		return
	}

	sharedEnv := unmarshalSharedEnv(ws)

	revealedKeys := sortedKeys(sharedEnv)
	details, _ := json.Marshal(map[string]any{
		"revealed_keys": revealedKeys,
		"key_count":     len(revealedKeys),
	})
	if _, err := h.Queries.CreateActivity(r.Context(), db.CreateActivityParams{
		WorkspaceID: ws.ID,
		IssueID:     pgtype.UUID{}, // env access is not tied to an issue
		ActorType:   pgtype.Text{String: "member", Valid: true},
		ActorID:     parseUUID(uuidToString(member.UserID)),
		Action:      workspaceEnvActivityRevealed,
		Details:     details,
	}); err != nil {
		slog.Error("workspace_env_revealed audit write failed; refusing to serve plaintext",
			append(logger.RequestAttrs(r), "error", err, "workspace_id", uuidToString(ws.ID))...)
		writeError(w, http.StatusInternalServerError, "audit log write failed; refusing to serve env without a recorded reveal")
		return
	}

	writeJSON(w, http.StatusOK, WorkspaceSharedEnvResponse{SharedEnv: sharedEnv})
}

// UpdateWorkspaceSharedEnv replaces the workspace shared_env wholesale,
// honouring the **** sentinel per key (see mergeAgentEnv) so a partially
// revealed map round-tripped from the UI cannot overwrite real secrets with
// the masked placeholder. Persist + audit run in one transaction so they
// commit or roll back together.
func (h *Handler) UpdateWorkspaceSharedEnv(w http.ResponseWriter, r *http.Request) {
	ws, member, ok := h.authorizeWorkspaceEnv(w, r)
	if !ok {
		return
	}

	var req UpdateWorkspaceSharedEnvRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.SharedEnv == nil {
		req.SharedEnv = map[string]string{}
	}

	existing := unmarshalSharedEnv(ws)
	merged, audit := mergeAgentEnv(existing, req.SharedEnv)

	envBytes, err := json.Marshal(merged)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to encode env")
		return
	}

	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		slog.Error("workspace_env update: begin tx failed",
			append(logger.RequestAttrs(r), "error", err, "workspace_id", uuidToString(ws.ID))...)
		writeError(w, http.StatusInternalServerError, "failed to update env")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)

	if _, err := qtx.UpdateWorkspaceSharedEnv(r.Context(), db.UpdateWorkspaceSharedEnvParams{
		ID:        ws.ID,
		SharedEnv: envBytes,
	}); err != nil {
		slog.Warn("update workspace shared_env failed",
			append(logger.RequestAttrs(r), "error", err, "workspace_id", uuidToString(ws.ID))...)
		writeError(w, http.StatusInternalServerError, "failed to update env")
		return
	}

	auditDetails := map[string]any{
		"added_keys":     audit.added,
		"removed_keys":   audit.removed,
		"changed_keys":   audit.changed,
		"preserved_keys": audit.preserved,
	}
	details, _ := json.Marshal(auditDetails)
	if _, err := qtx.CreateActivity(r.Context(), db.CreateActivityParams{
		WorkspaceID: ws.ID,
		IssueID:     pgtype.UUID{},
		ActorType:   pgtype.Text{String: "member", Valid: true},
		ActorID:     parseUUID(uuidToString(member.UserID)),
		Action:      workspaceEnvActivityUpdated,
		Details:     details,
	}); err != nil {
		slog.Error("workspace_env_updated audit write failed; rolling back update",
			append(logger.RequestAttrs(r), "error", err, "workspace_id", uuidToString(ws.ID))...)
		writeError(w, http.StatusInternalServerError, "audit log write failed; env update rolled back")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("workspace_env update: tx commit failed",
			append(logger.RequestAttrs(r), "error", err, "workspace_id", uuidToString(ws.ID))...)
		writeError(w, http.StatusInternalServerError, "failed to update env")
		return
	}

	writeJSON(w, http.StatusOK, WorkspaceSharedEnvResponse{SharedEnv: merged})
}

// unmarshalSharedEnv decodes a workspace's stored shared_env JSONB into a
// map, returning an empty (never nil) map so callers can iterate safely.
func unmarshalSharedEnv(ws db.Workspace) map[string]string {
	out := map[string]string{}
	if len(ws.SharedEnv) == 0 {
		return out
	}
	if err := json.Unmarshal(ws.SharedEnv, &out); err != nil {
		slog.Warn("failed to unmarshal workspace shared_env", "workspace_id", uuidToString(ws.ID), "error", err)
		return map[string]string{}
	}
	if out == nil {
		return map[string]string{}
	}
	return out
}
