package handler

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type CockpitDirectoryPage struct {
	WorkspaceID string                          `json:"workspace_id"`
	Scope       string                          `json:"scope"`
	Q           string                          `json:"q"`
	Party       *string                         `json:"party"`
	Parties     []string                        `json:"parties"`
	Items       []CockpitDirectoryEntryResponse `json:"items"`
	Total       int64                           `json:"total"`
	NextCursor  *string                         `json:"next_cursor"`
}
type cockpitDirectoryCursor struct {
	Version     int      `json:"v"`
	WorkspaceID string   `json:"w"`
	Q           string   `json:"q"`
	Party       *string  `json:"p"`
	Parties     []string `json:"ps"`
	Size        int32    `json:"s"`
	LastParty   string   `json:"lp"`
	LastName    string   `json:"ln"`
}
type CockpitDirectoryNaturalKey struct {
	Party string `json:"party"`
	Name  string `json:"name"`
}
type CockpitDirectoryCompactReceipt struct {
	WorkspaceID string                          `json:"workspace_id"`
	Scope       string                          `json:"scope"`
	Action      string                          `json:"action"`
	Entries     []CockpitDirectoryEntryResponse `json:"entries"`
	Skipped     []CockpitDirectoryNaturalKey    `json:"skipped"`
	Deleted     []CockpitDirectoryNaturalKey    `json:"deleted"`
}

func directoryTextValid(text string, max int) bool {
	return utf8.ValidString(text) && len(text) <= max && !strings.ContainsRune(text, '\x00')
}
func directoryWorkspaceScope(w http.ResponseWriter, r *http.Request) bool {
	for _, key := range []string{"project", "module", "project_id", "module_id"} {
		if r.URL.Query().Has(key) {
			writeError(w, 400, "the contact directory is shared by the whole workspace")
			return false
		}
	}
	return true
}
func directoryCompactMode(w http.ResponseWriter, r *http.Request) (bool, bool) {
	if !directoryWorkspaceScope(w, r) {
		return false, false
	}
	mode := r.URL.Query().Get("response")
	if mode != "" && mode != "compact" {
		writeError(w, 400, "response must be compact when specified")
		return false, false
	}
	return mode == "compact", true
}
func (h *Handler) ListCockpitDirectoryPage(w http.ResponseWriter, r *http.Request) {
	if !directoryWorkspaceScope(w, r) {
		return
	}
	ws := h.resolveWorkspaceID(r)
	id, ok := parseUUIDOrBadRequest(w, ws, "workspace id")
	if !ok {
		return
	}
	if _, ok = h.requireWorkspaceMember(w, r, ws, "workspace not found"); !ok {
		return
	}
	size, ok := cockpitActionPageSize(w, r)
	if !ok {
		return
	}
	values := r.URL.Query()
	q := strings.TrimSpace(values.Get("q"))
	if !directoryTextValid(q, 200) || len(values["party"]) > 1 || len(values["parties"]) > 20 || (values.Has("party") && values.Has("parties")) {
		writeError(w, 400, "invalid directory filters")
		return
	}
	var party *string
	var parties []string
	filter := []string{}
	if values.Has("party") {
		v := strings.TrimSpace(values.Get("party"))
		if !directoryTextValid(v, 300) {
			writeError(w, 400, "party is too long")
			return
		}
		party = &v
		filter = []string{v}
	}
	if values.Has("parties") {
		parties = make([]string, 0, len(values["parties"]))
		seen := map[string]bool{}
		for _, raw := range values["parties"] {
			v := strings.TrimSpace(raw)
			if !directoryTextValid(v, 300) {
				writeError(w, 400, "party is too long")
				return
			}
			if !seen[v] {
				parties = append(parties, v)
				seen[v] = true
			}
		}
		sort.Strings(parties)
		filter = parties
	}
	after := false
	lastParty, lastName := "", ""
	token := values.Get("cursor")
	if token != "" {
		if len(token) > 16384 {
			writeError(w, 400, "directory cursor is too long")
			return
		}
		var cur cockpitDirectoryCursor
		body, err := base64.RawURLEncoding.DecodeString(token)
		if err != nil || json.Unmarshal(body, &cur) != nil || cur.Version != 1 || cur.WorkspaceID != ws || cur.Q != q || !reflect.DeepEqual(cur.Party, party) || !reflect.DeepEqual(cur.Parties, parties) || cur.Size != int32(size) || !directoryTextValid(cur.LastParty, 300) || !directoryTextValid(cur.LastName, 300) || cur.LastName == "" {
			writeError(w, 400, "directory cursor does not match this page")
			return
		}
		after, lastParty, lastName = true, cur.LastParty, cur.LastName
	}
	filtered := party != nil || parties != nil
	total, err := h.Queries.CountCockpitDirectoryPage(r.Context(), db.CountCockpitDirectoryPageParams{WorkspaceID: id, FilterParties: filtered, Parties: filter, Q: q})
	if err != nil {
		writeError(w, 500, "failed to count directory")
		return
	}
	rows, err := h.Queries.ListCockpitDirectoryPage(r.Context(), db.ListCockpitDirectoryPageParams{WorkspaceID: id, FilterParties: filtered, Parties: filter, Q: q, After: after, AfterParty: lastParty, AfterName: lastName, PageLimit: int32(size + 1)})
	if err != nil {
		writeError(w, 500, "failed to load directory page")
		return
	}
	var next *string
	if len(rows) > int(size) {
		rows = rows[:size]
		last := rows[len(rows)-1]
		b, _ := json.Marshal(cockpitDirectoryCursor{Version: 1, WorkspaceID: ws, Q: q, Party: party, Parties: parties, Size: int32(size), LastParty: last.Party, LastName: last.Name})
		v := base64.RawURLEncoding.EncodeToString(b)
		next = &v
	}
	writeJSON(w, 200, CockpitDirectoryPage{WorkspaceID: ws, Scope: "workspace", Q: q, Party: party, Parties: parties, Items: cockpitDirectoryToResponse(rows).Entries, Total: total, NextCursor: next})
}
func directoryReceipt(cc cockpitContext, action string) CockpitDirectoryCompactReceipt {
	return CockpitDirectoryCompactReceipt{WorkspaceID: uuidToString(cc.workspaceID), Scope: "workspace", Action: action, Entries: []CockpitDirectoryEntryResponse{}, Skipped: []CockpitDirectoryNaturalKey{}, Deleted: []CockpitDirectoryNaturalKey{}}
}
func (h *Handler) upsertCockpitDirectoryCompact(w http.ResponseWriter, r *http.Request, cc cockpitContext, req CockpitDirectoryUpsertRequest, compact bool) {
	if len(req.Entries) > cockpitDirectoryUpsertMax {
		writeError(w, 400, "too many directory entries")
		return
	}
	params := make([]db.UpsertCockpitDirectoryCompactParams, 0, len(req.Entries))
	positions := map[CockpitDirectoryNaturalKey]int{}
	for _, entry := range req.Entries {
		party, name, position := strings.TrimSpace(textOrEmpty(entry.Party)), strings.TrimSpace(textOrEmpty(entry.Name)), strings.TrimSpace(textOrEmpty(entry.Position))
		if name == "" || !directoryTextValid(party, 300) || !directoryTextValid(name, 300) || !directoryTextValid(position, 2000) || (entry.ClearPosition && position != "") || (req.OnlyUnknownNames && entry.ClearPosition) {
			writeError(w, 400, "invalid contact or conflicting clear_position")
			return
		}
		key := CockpitDirectoryNaturalKey{Party: party, Name: name}
		if index, exists := positions[key]; exists {
			if entry.ClearPosition || position != "" {
				params[index].Position = position
				params[index].ClearPosition = entry.ClearPosition
			}
		} else {
			positions[key] = len(params)
			params = append(params, db.UpsertCockpitDirectoryCompactParams{WorkspaceID: cc.workspaceID, CockpitID: cc.cockpit.ID, Party: party, Name: name, Position: position, ClearPosition: entry.ClearPosition, OnlyUnknownNames: req.OnlyUnknownNames})
		}
	}
	tx, q, err := h.beginCockpitReferenceAppend(r.Context(), cc, pgtype.UUID{})
	if writeCockpitReferenceError(w, err) {
		return
	}
	defer tx.Rollback(r.Context())
	result := directoryReceipt(cc, "upserted")
	saved := map[CockpitDirectoryNaturalKey]CockpitDirectoryEntryResponse{}
	skipped := map[CockpitDirectoryNaturalKey]bool{}
	order := []CockpitDirectoryNaturalKey{}
	seen := map[CockpitDirectoryNaturalKey]bool{}
	for _, param := range params {
		key := CockpitDirectoryNaturalKey{Party: param.Party, Name: param.Name}
		if !seen[key] {
			order = append(order, key)
			seen[key] = true
		}
		row, err := q.UpsertCockpitDirectoryCompact(r.Context(), param)
		if errors.Is(err, pgx.ErrNoRows) && req.OnlyUnknownNames {
			if _, ok := saved[key]; !ok {
				skipped[key] = true
			}
			continue
		}
		if err != nil {
			writeError(w, 500, "failed to save directory entry")
			return
		}
		saved[key] = cockpitDirectoryToResponse([]db.CockpitDirectory{row}).Entries[0]
		delete(skipped, key)
	}
	for _, key := range order {
		if row, ok := saved[key]; ok {
			result.Entries = append(result.Entries, row)
		} else if skipped[key] {
			result.Skipped = append(result.Skipped, key)
		}
	}
	var legacy CockpitDirectoryResponse
	if !compact {
		rows, err := q.ListCockpitDirectory(r.Context(), cc.cockpit.ID)
		if err != nil {
			writeError(w, 500, "failed to load directory")
			return
		}
		legacy = cockpitDirectoryToResponse(rows)
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, 500, "failed to save directory")
		return
	}
	if compact {
		h.publishCockpit(r, cc, "directory", "changed", result)
		writeJSON(w, 200, result)
	} else {
		h.publishCockpit(r, cc, "directory", "upserted", legacy)
		writeJSON(w, 200, legacy)
	}
}
func (h *Handler) deleteCockpitDirectoryCompact(w http.ResponseWriter, r *http.Request, cc cockpitContext, req CockpitDirectoryDeleteRequest, compact bool) {
	party, name := strings.TrimSpace(textOrEmpty(req.Party)), strings.TrimSpace(textOrEmpty(req.Name))
	if name == "" || !directoryTextValid(party, 300) || !directoryTextValid(name, 300) {
		writeError(w, 400, "invalid directory natural key")
		return
	}
	tx, q, err := h.beginCockpitReferenceAppend(r.Context(), cc, pgtype.UUID{})
	if writeCockpitReferenceError(w, err) {
		return
	}
	defer tx.Rollback(r.Context())
	row, err := q.LockCockpitDirectoryNaturalKey(r.Context(), db.LockCockpitDirectoryNaturalKeyParams{WorkspaceID: cc.workspaceID, CockpitID: cc.cockpit.ID, Party: party, Name: name})
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, 404, "directory entry not found")
		return
	}
	if err != nil {
		writeError(w, 500, "failed to read directory entry")
		return
	}
	if row.Source != "user" {
		writeError(w, 400, "preset or unknown directory entries cannot be deleted")
		return
	}
	if _, err = q.DeleteCockpitDirectoryCompact(r.Context(), db.DeleteCockpitDirectoryCompactParams{WorkspaceID: cc.workspaceID, CockpitID: cc.cockpit.ID, Party: party, Name: name}); err != nil {
		writeError(w, 500, "failed to delete directory entry")
		return
	}
	var legacy CockpitDirectoryResponse
	if !compact {
		rows, err := q.ListCockpitDirectory(r.Context(), cc.cockpit.ID)
		if err != nil {
			writeError(w, 500, "failed to load directory")
			return
		}
		legacy = cockpitDirectoryToResponse(rows)
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, 500, "failed to delete directory entry")
		return
	}
	if compact {
		result := directoryReceipt(cc, "deleted")
		result.Deleted = append(result.Deleted, CockpitDirectoryNaturalKey{Party: party, Name: name})
		h.publishCockpit(r, cc, "directory", "changed", result)
		writeJSON(w, 200, result)
	} else {
		h.publishCockpit(r, cc, "directory", "deleted", legacy)
		writeJSON(w, 200, legacy)
	}
}
