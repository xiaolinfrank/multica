package handler

// The meeting directory: the programme's contact book.
//
// Parties and attendees on a meeting are free text (migration 929); nothing
// there links the people at the table to the organisations they represent.
// The directory is that link — one row per (cockpit, party, name) with the
// person's 职位 — so the meeting form can offer a unit's people once the unit
// is chosen. It is written two ways, both landing in the same upsert: the
// form's "new contact" row, and the auto-save that files whatever was typed
// when a meeting is created or edited. Both are open to any workspace member,
// like every cockpit write (see the router block).

import (
	"log/slog"
	"net/http"
	"strings"

	"github.com/multica-ai/multica/server/internal/logger"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Larger than any honest save and small enough that a runaway client cannot
// rewrite the book in one request. The link endpoints use the same cap.
const cockpitDirectoryUpsertMax = 200

type CockpitDirectoryEntryResponse struct {
	Party    string `json:"party"`
	Name     string `json:"name"`
	Position string `json:"position"`
}

type CockpitDirectoryResponse struct {
	Entries []CockpitDirectoryEntryResponse `json:"entries"`
}

// CockpitDirectoryUpsertRequest is a batch: the auto-save fires alongside a
// meeting save and may carry several fresh names at once.
type CockpitDirectoryUpsertRequest struct {
	Entries []CockpitDirectoryUpsertEntry `json:"entries"`
}

type CockpitDirectoryUpsertEntry struct {
	Party    *string `json:"party"`
	Name     *string `json:"name"`
	Position *string `json:"position"`
}

func cockpitDirectoryToResponse(rows []db.CockpitDirectory) CockpitDirectoryResponse {
	entries := make([]CockpitDirectoryEntryResponse, 0, len(rows))
	for _, row := range rows {
		entries = append(entries, CockpitDirectoryEntryResponse{
			Party:    row.Party,
			Name:     row.Name,
			Position: row.Position,
		})
	}
	return CockpitDirectoryResponse{Entries: entries}
}

func (h *Handler) ListCockpitDirectory(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	rows, err := h.Queries.ListCockpitDirectory(r.Context(), cc.cockpit.ID)
	if err != nil {
		slog.Warn("ListCockpitDirectory failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load directory")
		return
	}
	writeJSON(w, http.StatusOK, cockpitDirectoryToResponse(rows))
}

func (h *Handler) UpsertCockpitDirectory(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}

	var req CockpitDirectoryUpsertRequest
	if _, ok := decodeCockpitBody(w, r, &req); !ok {
		return
	}
	if len(req.Entries) > cockpitDirectoryUpsertMax {
		writeError(w, http.StatusBadRequest, "too many directory entries")
		return
	}

	// Validate the whole batch before touching the database: a 400 after
	// some rows landed would leave the book changed with no event saying so.
	params := make([]db.UpsertCockpitDirectoryEntryParams, 0, len(req.Entries))
	for _, entry := range req.Entries {
		name := strings.TrimSpace(textOrEmpty(entry.Name))
		if name == "" {
			writeError(w, http.StatusBadRequest, "directory entry name is required")
			return
		}
		params = append(params, db.UpsertCockpitDirectoryEntryParams{
			WorkspaceID: cc.workspaceID,
			CockpitID:   cc.cockpit.ID,
			Party:       strings.TrimSpace(textOrEmpty(entry.Party)),
			Name:        name,
			Position:    strings.TrimSpace(textOrEmpty(entry.Position)),
		})
	}

	// One transaction for the batch: a mid-batch failure must not leave a
	// partial save that no client is told about.
	ctx := r.Context()
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		slog.Warn("UpsertCockpitDirectory begin failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to save directory entry")
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := h.Queries.WithTx(tx)

	for _, param := range params {
		if _, err := qtx.UpsertCockpitDirectoryEntry(ctx, param); err != nil {
			slog.Warn("UpsertCockpitDirectoryEntry failed", append(logger.RequestAttrs(r), "error", err)...)
			writeError(w, http.StatusInternalServerError, "failed to save directory entry")
			return
		}
	}

	// The answer is the whole book, not the rows this call touched: the
	// client keeps one cached list, and a refresh is a few dozen rows.
	rows, err := qtx.ListCockpitDirectory(ctx, cc.cockpit.ID)
	if err != nil {
		slog.Warn("ListCockpitDirectory failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load directory")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		slog.Warn("UpsertCockpitDirectory commit failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to save directory entry")
		return
	}
	resp := cockpitDirectoryToResponse(rows)
	h.publishCockpit(r, cc, "directory", "upserted", resp)
	writeJSON(w, http.StatusOK, resp)
}
