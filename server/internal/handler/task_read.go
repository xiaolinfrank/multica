package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// loadTaskForRead shares the task metadata and transcript privacy boundary.
// Chat tasks belong to their creator; other tasks use agent VIEW permissions,
// independently of INVOKE or cancellation eligibility.
func (h *Handler) loadTaskForRead(w http.ResponseWriter, r *http.Request) (db.AgentTaskQueue, string, bool) {
	taskID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "taskId"), "task_id")
	if !ok {
		return db.AgentTaskQueue{}, "", false
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return db.AgentTaskQueue{}, "", false
	}
	workspaceID := ctxWorkspaceID(r.Context())
	workspace, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace_id")
	if !ok {
		return db.AgentTaskQueue{}, "", false
	}
	fail := func(err error) (db.AgentTaskQueue, string, bool) {
		if isNotFound(err) {
			writeError(w, http.StatusNotFound, "task not found")
		} else {
			writeError(w, http.StatusInternalServerError, "failed to load task")
		}
		return db.AgentTaskQueue{}, "", false
	}
	task, err := h.Queries.GetAgentTaskInWorkspace(r.Context(), db.GetAgentTaskInWorkspaceParams{ID: taskID, WorkspaceID: workspace})
	if err != nil {
		return fail(err)
	}
	if task.ChatSessionID.Valid {
		session, err := h.Queries.GetChatSessionInWorkspace(r.Context(), db.GetChatSessionInWorkspaceParams{ID: task.ChatSessionID, WorkspaceID: workspace})
		if err != nil {
			return fail(err)
		}
		if uuidToString(session.CreatorID) != userID {
			// A chat transcript belongs to its creator alone; to anyone else it
			// does not exist rather than being merely forbidden.
			writeError(w, http.StatusNotFound, "task not found")
			return db.AgentTaskQueue{}, "", false
		}
	} else if task.DocID.Valid {
		// A doc discussion run has no project to gate it; its transcript follows
		// the agent's own visibility and reads as missing otherwise (MUL-9933).
		agent, err := h.Queries.GetAgentInWorkspace(r.Context(), db.GetAgentInWorkspaceParams{ID: task.AgentID, WorkspaceID: workspace})
		if err != nil {
			return fail(err)
		}
		actorType, actorID := h.resolveActor(r, userID, workspaceID)
		if !h.canAccessPrivateAgent(r.Context(), agent, actorType, actorID, workspaceID) {
			writeError(w, http.StatusNotFound, "task not found")
			return db.AgentTaskQueue{}, "", false
		}
	} else {
		agent, err := h.Queries.GetAgentInWorkspace(r.Context(), db.GetAgentInWorkspaceParams{ID: task.AgentID, WorkspaceID: workspace})
		if err != nil {
			return fail(err)
		}
		actorType, actorID := h.resolveActor(r, userID, workspaceID)
		// Preserve the existing authenticated A2A VIEW policy.
		if actorType != "agent" {
			actor, err := util.ParseUUID(actorID)
			if err != nil {
				writeError(w, http.StatusUnauthorized, "user not authenticated")
				return db.AgentTaskQueue{}, "", false
			}
			allowed, err := service.MemberMayViewAgent(r.Context(), h.Queries, agent, actor, workspace)
			if err != nil {
				return fail(err)
			}
			if !allowed {
				writeError(w, http.StatusForbidden, "you do not have access to this agent")
				return db.AgentTaskQueue{}, "", false
			}
		}
	}
	// A run whose issue sits in a private project the caller cannot see does not
	// exist for them (MUL-8472).
	if !h.requireTaskVisible(w, r, workspaceID, task, http.StatusNotFound, "task not found") {
		return db.AgentTaskQueue{}, "", false
	}
	return task, workspaceID, true
}

// GetTaskByUser reads one exact run without scanning its issue's run history.
func (h *Handler) GetTaskByUser(w http.ResponseWriter, r *http.Request) {
	task, workspaceID, ok := h.loadTaskForRead(w, r)
	if !ok {
		return
	}
	response := taskToResponse(task, workspaceID)
	h.hydrateTaskAttributions(r.Context(), []*TaskAttribution{response.Attribution})
	writeJSON(w, http.StatusOK, response)
}
