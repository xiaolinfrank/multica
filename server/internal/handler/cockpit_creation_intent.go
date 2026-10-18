package handler

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type cockpitCreationCommand struct {
	WorkspaceID, ActorID, Key pgtype.UUID
	Kind, Hash                string
}
type cockpitCreationFailure struct {
	status  int
	message string
}

func (e *cockpitCreationFailure) Error() string { return e.message }

type CockpitNodeCreateRequest struct {
	CockpitNodeRequest
	CreationKey *string `json:"creation_key"`
	AutoCode    *bool   `json:"auto_code"`
}
type CockpitNodeCreateResponse struct {
	CockpitNodeResponse
	WorkspaceID string `json:"workspace_id"`
	CreationKey string `json:"creation_key,omitempty"`
	Replayed    bool   `json:"replayed"`
}

// Canonicalize only submitted fields, before allocation or mutable lookups.
// Adding a future optional request field must not change an old command hash.
func (h *Handler) prepareCockpitCreation(w http.ResponseWriter, r *http.Request, kind string, key *string, body any) (cockpitContext, *cockpitCreationCommand, bool) {
	ws := h.resolveWorkspaceID(r)
	id, ok := parseUUIDOrBadRequest(w, ws, "workspace id")
	if !ok {
		return cockpitContext{}, nil, false
	}
	member, ok := h.requireWorkspaceMember(w, r, ws, "workspace not found")
	if !ok {
		return cockpitContext{}, nil, false
	}
	cc := cockpitContext{workspaceID: id, member: member}
	if key == nil {
		return cc, &cockpitCreationCommand{WorkspaceID: id, ActorID: member.UserID, Kind: kind}, true
	}
	commandKey, ok := parseUUIDOrBadRequest(w, *key, "creation_key")
	if !ok {
		return cc, nil, false
	}
	payload, err := json.Marshal(body)
	var fields map[string]any
	if err == nil {
		err = json.Unmarshal(payload, &fields)
	}
	if err != nil || fields == nil {
		writeError(w, 400, "invalid creation request")
		return cc, nil, false
	}
	delete(fields, "creation_key")
	payload, err = json.Marshal(fields)
	if err != nil {
		writeError(w, 400, "invalid creation request")
		return cc, nil, false
	}
	command := &cockpitCreationCommand{WorkspaceID: id, ActorID: member.UserID, Key: commandKey, Kind: kind, Hash: fmt.Sprintf("%x", sha256.Sum256(payload))}
	receipt, err := readCockpitCreationReplay(r.Context(), h.Queries, command)
	if err != nil {
		writeCockpitCreationError(w, err)
		return cc, nil, false
	}
	if receipt != nil {
		writeJSON(w, http.StatusOK, receipt)
		return cc, nil, false
	}
	return cc, command, true
}
func writeCockpitCreationError(w http.ResponseWriter, err error) {
	var failure *cockpitCreationFailure
	if errors.As(err, &failure) {
		writeError(w, failure.status, failure.message)
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, 404, "cockpit or creation target no longer exists")
		return
	}
	writeError(w, 500, "failed to process cockpit creation")
}
func readCockpitCreationReplay(ctx context.Context, q *db.Queries, command *cockpitCreationCommand) (json.RawMessage, error) {
	if command == nil || !command.Key.Valid {
		return nil, nil
	}
	row, err := q.GetCockpitCreationIntent(ctx, db.GetCockpitCreationIntentParams{WorkspaceID: command.WorkspaceID, ResourceKind: command.Kind, CreationKey: command.Key})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if row.ActorID != command.ActorID || row.RequestHash != command.Hash {
		return nil, &cockpitCreationFailure{409, "creation_key already belongs to a different request or actor"}
	}
	exists, err := q.CockpitCreationResourceExists(ctx, db.CockpitCreationResourceExistsParams{WorkspaceID: command.WorkspaceID, ResourceKind: command.Kind, ResourceID: row.ResourceID})
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, &cockpitCreationFailure{410, "the object created by this key no longer exists; this creation key cannot be reused"}
	}
	var receipt map[string]json.RawMessage
	if err = json.Unmarshal(row.Receipt, &receipt); err != nil {
		return nil, err
	}
	var resourceID string
	if err = json.Unmarshal(receipt["id"], &resourceID); err != nil || resourceID != uuidToString(row.ResourceID) {
		return nil, fmt.Errorf("creation receipt identity does not match its resource")
	}
	receipt["replayed"] = json.RawMessage("true")
	return json.Marshal(receipt)
}
func saveCockpitCreationReceipt(ctx context.Context, q *db.Queries, command *cockpitCreationCommand, resource pgtype.UUID, receipt any) error {
	if command == nil || !command.Key.Valid {
		return nil
	}
	data, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	return q.CreateCockpitCreationIntent(ctx, db.CreateCockpitCreationIntentParams{WorkspaceID: command.WorkspaceID, ResourceKind: command.Kind, CreationKey: command.Key, RequestHash: command.Hash, ActorID: command.ActorID, ResourceID: resource, Receipt: data})
}

// Manual creates may initialize their board atomically. Archive adoption must
// instead keep using the exact board the user inspected before filesystem I/O.
func (h *Handler) beginCockpitCreation(ctx context.Context, ws, expectedBoard pgtype.UUID, command *cockpitCreationCommand) (pgx.Tx, *db.Queries, db.Cockpit, json.RawMessage, error) {
	var board db.Cockpit
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return nil, nil, board, nil, err
	}
	q := h.Queries.WithTx(tx)
	fail := func(err error) (pgx.Tx, *db.Queries, db.Cockpit, json.RawMessage, error) {
		_ = tx.Rollback(ctx)
		return nil, nil, board, nil, err
	}
	if _, err = q.LockWorkspaceForChatSessionCreate(ctx, ws); err != nil {
		return fail(err)
	}
	if command == nil || !command.ActorID.Valid {
		return fail(&cockpitCreationFailure{403, "creation requires a workspace member"})
	}
	if _, err = q.LockCockpitCreationMember(ctx, db.LockCockpitCreationMemberParams{WorkspaceID: ws, UserID: command.ActorID}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return fail(&cockpitCreationFailure{404, "workspace membership no longer exists"})
		}
		return fail(err)
	}
	receipt, err := readCockpitCreationReplay(ctx, q, command)
	if err != nil {
		return fail(err)
	}
	if receipt != nil {
		return tx, q, board, receipt, nil
	}
	board, err = q.GetCockpitByWorkspace(ctx, ws)
	if errors.Is(err, pgx.ErrNoRows) && !expectedBoard.Valid {
		board, err = q.CreateCockpit(ctx, db.CreateCockpitParams{WorkspaceID: ws})
	}
	if err != nil {
		return fail(err)
	}
	currentID, err := q.LockCockpitForWorkspaceChanges(ctx, ws)
	if err != nil {
		return fail(err)
	}
	if currentID != board.ID || (expectedBoard.Valid && currentID != expectedBoard) {
		return fail(pgx.ErrNoRows)
	}
	receipt, err = readCockpitCreationReplay(ctx, q, command)
	if err != nil {
		return fail(err)
	}
	return tx, q, board, receipt, nil
}
