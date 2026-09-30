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
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
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
	// "seed" rows are the programme's roster (migration 947): the delete
	// affordance must not touch them. Everything the meeting form filed is
	// "user".
	Source string `json:"source"`
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
			Source:   row.Source,
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

// CockpitDirectoryDeleteRequest names a contact by its identity triple's
// (party, name) — the position is not part of the identity.
type CockpitDirectoryDeleteRequest struct {
	Party *string `json:"party"`
	Name  *string `json:"name"`
}

// DeleteCockpitDirectoryEntry removes one form-filed contact. Seeded roster
// rows refuse the delete: the roster is the programme's canonical list, and
// a wrong name there is corrected by editing, not by deleting.
func (h *Handler) DeleteCockpitDirectoryEntry(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}

	var req CockpitDirectoryDeleteRequest
	if _, ok := decodeCockpitBody(w, r, &req); !ok {
		return
	}
	name := strings.TrimSpace(textOrEmpty(req.Name))
	if name == "" {
		writeError(w, http.StatusBadRequest, "directory entry name is required")
		return
	}
	party := strings.TrimSpace(textOrEmpty(req.Party))

	source, err := h.Queries.GetCockpitDirectoryEntrySource(r.Context(), db.GetCockpitDirectoryEntrySourceParams{
		CockpitID: cc.cockpit.ID,
		Party:     party,
		Name:      name,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "directory entry not found")
		return
	}
	if err != nil {
		slog.Warn("GetCockpitDirectoryEntrySource failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to delete directory entry")
		return
	}
	if source == "seed" {
		writeError(w, http.StatusBadRequest, "preset directory entries cannot be deleted")
		return
	}

	if err := h.Queries.DeleteCockpitDirectoryEntry(r.Context(), db.DeleteCockpitDirectoryEntryParams{
		CockpitID: cc.cockpit.ID,
		Party:     party,
		Name:      name,
	}); err != nil {
		slog.Warn("DeleteCockpitDirectoryEntry failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to delete directory entry")
		return
	}

	// Same answer as the upsert: the whole refreshed book.
	rows, err := h.Queries.ListCockpitDirectory(r.Context(), cc.cockpit.ID)
	if err != nil {
		slog.Warn("ListCockpitDirectory failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load directory")
		return
	}
	resp := cockpitDirectoryToResponse(rows)
	h.publishCockpit(r, cc, "directory", "deleted", resp)
	writeJSON(w, http.StatusOK, resp)
}
