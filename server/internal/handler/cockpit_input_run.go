package handler

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/service"
)

func (h *Handler) cockpitInputClaim(w http.ResponseWriter, r *http.Request, q *service.CockpitInputQuery, taskID, runtimeID, dispatched string) bool {
	if r.Header.Get("X-Actor-Source") != "cloud_pat" && middleware.DaemonWorkspaceIDFromContext(r.Context()) == "" {
		writeError(w, http.StatusForbidden, "A runtime credential is required for a dispatched claim.")
		return false
	}
	if _, ok := parseUUIDOrBadRequest(w, taskID, "task_id"); !ok {
		return false
	}
	if _, ok := parseUUIDOrBadRequest(w, runtimeID, "runtime_id"); !ok {
		return false
	}
	at, err := time.Parse(time.RFC3339Nano, dispatched)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid dispatched_at")
		return false
	}
	runtime, ok := h.requireDaemonRuntimeAccess(w, r, runtimeID)
	if !ok {
		return false
	}
	if daemonID := middleware.DaemonIDFromContext(r.Context()); daemonID != "" && (!runtime.DaemonID.Valid || runtime.DaemonID.String != daemonID) {
		writeError(w, http.StatusForbidden, "This daemon does not own the runtime.")
		return false
	}
	task, workspaceID, ok := h.requireDaemonTaskAccessWithWorkspace(w, r, taskID)
	if !ok {
		return false
	}
	if workspaceID != uuidToString(q.WorkspaceID) || runtime.WorkspaceID != q.WorkspaceID || task.RuntimeID != runtime.ID || !task.DispatchedAt.Valid || !at.Equal(task.DispatchedAt.Time) || !task.IssueID.Valid || task.ChatSessionID.Valid || (task.Status != "dispatched" && task.Status != "running" && task.Status != "waiting_local_directory") {
		writeError(w, http.StatusConflict, "The exact task claim is no longer current.")
		return false
	}
	if q.CredentialOwnerID.Valid && q.CredentialOwnerID != runtime.OwnerID {
		writeError(w, http.StatusForbidden, "This credential does not own the runtime.")
		return false
	}
	q.ActorSource = "daemon_claim"
	q.TrustedDaemonID = middleware.DaemonIDFromContext(r.Context())
	q.CredentialOwnerID = runtime.OwnerID
	q.AgentID = task.AgentID
	q.RunID = task.ID
	q.TaskID = task.ID
	q.RuntimeID = runtime.ID
	q.ClaimDispatchedAt = pgtype.Timestamptz{Time: at, Valid: true}
	return true
}
func (h *Handler) GetCockpitRunInputManifest(w http.ResponseWriter, r *http.Request) {
	api, q, ok := h.cockpitInputRunRequest(w, r, "runtime_id", "dispatched_at")
	if !ok {
		return
	}
	q.TaskID, ok = parseUUIDOrBadRequest(w, chi.URLParam(r, "taskId"), "task_id")
	if !ok {
		return
	}
	if q.ActorSource == "daemon_claim" || r.URL.Query().Has("runtime_id") || r.URL.Query().Has("dispatched_at") {
		if !h.cockpitInputClaim(w, r, &q, uuidToString(q.TaskID), r.URL.Query().Get("runtime_id"), r.URL.Query().Get("dispatched_at")) {
			return
		}
	}
	out, err := api.GetCockpitRunInputManifest(r.Context(), q)
	writeCockpitInputResult(w, r, out, err)
}
func (h *Handler) RecordCockpitRunInputPreparation(w http.ResponseWriter, r *http.Request) {
	api, q, ok := h.cockpitInputRunRequest(w, r, "runtime_id")
	if !ok {
		return
	}
	var in service.CockpitRunInputPreparationInput
	if !decodeCockpitInputBody(w, r, &in) {
		return
	}
	if !h.cockpitInputClaim(w, r, &q, chi.URLParam(r, "taskId"), r.URL.Query().Get("runtime_id"), in.DispatchedAt) {
		return
	}
	out, err := api.RecordCockpitRunInputPreparation(r.Context(), q, in)
	writeCockpitInputResult(w, r, out, err)
}
func (h *Handler) cockpitInputRunRequest(w http.ResponseWriter, r *http.Request, keys ...string) (service.CockpitInputAPI, service.CockpitInputQuery, bool) {
	return h.cockpitInputScopedRequest(w, r, true, keys...)
}

func (h *Handler) cockpitInputOptionalClaim(w http.ResponseWriter, r *http.Request, q *service.CockpitInputQuery) bool {
	values := r.URL.Query()
	if q.ActorSource != "daemon_claim" && !values.Has("task_id") && !values.Has("runtime_id") && !values.Has("dispatched_at") {
		return true
	}
	return h.cockpitInputClaim(w, r, q, values.Get("task_id"), values.Get("runtime_id"), values.Get("dispatched_at"))
}
