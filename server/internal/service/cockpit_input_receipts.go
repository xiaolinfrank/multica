package service

import (
	"encoding/json"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func inputReceiptID(value string) (pgtype.UUID, error) {
	id, err := util.ParseUUID(value)
	if err != nil || !id.Valid {
		return pgtype.UUID{}, inputError("input_integrity_error", "A stored input receipt has an invalid identity.")
	}
	return id, nil
}
func inputReceiptOptionalID(value *string) (pgtype.UUID, error) {
	if value == nil {
		return pgtype.UUID{}, nil
	}
	return inputReceiptID(*value)
}

func inputCreateReceipt(row db.CockpitInput) (CockpitInputCreateReceipt, error) {
	var r CockpitInputCreateReceipt
	if json.Unmarshal(row.CreationReceipt, &r) != nil {
		return r, inputError("input_integrity_error", "The input registration receipt is unreadable.")
	}
	key, err := inputReceiptID(r.CommandKey)
	if err != nil {
		return r, err
	}
	id, err := inputReceiptID(r.InputID)
	if err != nil {
		return r, err
	}
	project, err := inputReceiptOptionalID(r.ProjectID)
	if err != nil {
		return r, err
	}
	origin, err := inputReceiptOptionalID(r.OriginIssueID)
	if err != nil {
		return r, err
	}
	a, err := inputParsePrincipalIDs(r.Principal)
	if err != nil {
		return r, err
	}
	if key != row.CreationKey || id != row.ID || r.InputRevision != 1 || r.RequestHash != row.RequestHash || project != row.ProjectID || origin != row.OriginIssueID || a.kind != row.ActorType || a.actor != row.ActorID || a.credential != row.CredentialOwnerUserID || a.authorizer != row.AuthorizingUserID || a.agent != row.SourceAgentID || a.run != row.SourceRunID || a.issue != row.SourceIssueID || a.runtime != row.SourceRuntimeID {
		return r, inputError("input_integrity_error", "The registration receipt does not match its original input and principal.")
	}
	return r, nil
}

func inputVersionReceipt(row db.CockpitInputVersion) (CockpitInputVersionReceipt, error) {
	var r CockpitInputVersionReceipt
	if json.Unmarshal(row.SubmissionReceipt, &r) != nil {
		return r, inputError("input_integrity_error", "The input version receipt is unreadable.")
	}
	key, err := inputReceiptID(r.CommandKey)
	if err != nil {
		return r, err
	}
	input, err := inputReceiptID(r.InputID)
	if err != nil {
		return r, err
	}
	version, err := inputReceiptID(r.VersionID)
	if err != nil {
		return r, err
	}
	if _, err = inputReceiptOptionalID(r.TransferID); err != nil {
		return r, err
	}
	a, err := inputParsePrincipalIDs(r.Principal)
	if err != nil {
		return r, err
	}
	if key != row.SubmissionKey || input != row.InputID || version != row.ID || r.VersionNumber != row.VersionNumber || r.RequestHash != row.RequestHash || a.kind != row.ActorType || a.actor != row.ActorID || a.credential != row.CredentialOwnerUserID || a.authorizer != row.AuthorizingUserID || a.agent != row.SourceAgentID || a.run != row.SourceRunID || a.issue != row.SourceIssueID || a.runtime != row.SourceRuntimeID {
		return r, inputError("input_integrity_error", "The version receipt does not match its original content identity and principal.")
	}
	return r, nil
}

func inputStoredTransferReceipt(row db.CockpitInputTransfer, key pgtype.UUID) (CockpitInputTransferReceipt, inputProjectionActor, error) {
	var r CockpitInputTransferReceipt
	var ids inputProjectionActor
	var body []byte
	var storedHash, storedAction string
	switch {
	case row.Mode != "initial" && key == row.CommandKey:
		body, storedHash, storedAction = row.CommandReceipt, row.RequestHash, "input_transfer_restart"
	case key.Valid && key == row.FinalizeKey:
		body, storedHash, storedAction = row.FinalizeReceipt, row.FinalizeHash.String, "input_transfer_finalize"
	case key.Valid && key == row.AbortKey:
		body, storedHash, storedAction = row.AbortReceipt, row.AbortHash.String, "input_transfer_abandon"
	default:
		return r, ids, inputError("not_found", "No confirmed transfer command has this key.")
	}
	if json.Unmarshal(body, &r) != nil {
		return r, ids, inputError("input_integrity_error", "The transfer command receipt is unreadable.")
	}
	command, err := inputReceiptID(r.CommandKey)
	if err != nil {
		return r, ids, err
	}
	input, err := inputReceiptID(r.InputID)
	if err != nil {
		return r, ids, err
	}
	version, err := inputReceiptID(r.VersionID)
	if err != nil {
		return r, ids, err
	}
	transfer, err := inputReceiptID(r.TransferID)
	if err != nil {
		return r, ids, err
	}
	previous, err := inputReceiptOptionalID(r.ReplacesTransferID)
	if err != nil {
		return r, ids, err
	}
	ids, err = inputParsePrincipalIDs(r.Principal)
	if err != nil {
		return r, ids, err
	}
	if command != key || input != row.InputID || version != row.VersionID || transfer != row.ID || previous != row.ReplacesTransferID || r.TransferNumber != row.TransferNumber || r.Mode != row.Mode || r.RequestHash != storedHash || r.Action != storedAction {
		return r, ids, inputError("input_integrity_error", "The transfer receipt does not match its retained command and target.")
	}
	// A manager may finalize or abandon another member's accepted transfer.
	// Only the original restart receipt must match the transfer's creator.
	if storedAction == "input_transfer_restart" && (ids.kind != row.ActorType.String || ids.actor != row.ActorID || ids.credential != row.CredentialOwnerUserID || ids.authorizer != row.AuthorizingUserID || ids.agent != row.SourceAgentID || ids.run != row.SourceRunID || ids.issue != row.SourceIssueID || ids.runtime != row.SourceRuntimeID) {
		return r, ids, inputError("input_integrity_error", "The restart receipt does not match its original principal.")
	}
	return r, ids, nil
}
