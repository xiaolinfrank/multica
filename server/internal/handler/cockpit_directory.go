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
	Entries          []CockpitDirectoryUpsertEntry `json:"entries"`
	OnlyUnknownNames bool                          `json:"only_unknown_names"`
}

type CockpitDirectoryUpsertEntry struct {
	Party         *string `json:"party"`
	Name          *string `json:"name"`
	Position      *string `json:"position"`
	ClearPosition bool    `json:"clear_position"`
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
	compact, ok := directoryCompactMode(w, r)
	if !ok {
		return
	}
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	var req CockpitDirectoryUpsertRequest
	if _, ok := decodeCockpitBody(w, r, &req); !ok {
		return
	}
	h.upsertCockpitDirectoryCompact(w, r, cc, req, compact)
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
	compact, ok := directoryCompactMode(w, r)
	if !ok {
		return
	}
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	var req CockpitDirectoryDeleteRequest
	if _, ok := decodeCockpitBody(w, r, &req); !ok {
		return
	}
	h.deleteCockpitDirectoryCompact(w, r, cc, req, compact)
}
