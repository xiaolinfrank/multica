package service

import (
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func TestCockpitInputRetainedReceiptsRejectMalformedIdentityWithoutLosingOriginalSpelling(t *testing.T) {
	actor, inputID, versionID, transferID, key := dbid.NewV7(), dbid.NewV7(), dbid.NewV7(), dbid.NewV7(), dbid.NewV7()
	principal := CockpitInputPrincipal{ActorType: "member", ActorID: util.UUIDToString(actor), CredentialOwnerUserID: util.UUIDToString(actor), AuthorizingUserID: util.UUIDToString(actor)}
	command := strings.ToUpper(util.UUIDToString(key))
	hash := strings.Repeat("a", 64)
	t.Run("registration", func(t *testing.T) {
		receipt := CockpitInputCreateReceipt{CommandKey: command, RequestHash: hash, InputID: util.UUIDToString(inputID), InputRevision: 1, Principal: principal}
		row := db.CockpitInput{ID: inputID, CreationKey: key, RequestHash: hash, ActorType: "member", ActorID: actor, CredentialOwnerUserID: actor, AuthorizingUserID: actor, CreationReceipt: inputRaw(receipt)}
		got, err := inputCreateReceipt(row)
		if err != nil || got.CommandKey != command {
			t.Fatalf("exact receipt: %+v %v", got, err)
		}
		receipt.InputID = "invalid-retained-id"
		row.CreationReceipt = inputRaw(receipt)
		if _, err = inputCreateReceipt(row); inputErrorCode(err) != "input_integrity_error" {
			t.Fatalf("malformed target: %v", err)
		}
	})
	t.Run("version", func(t *testing.T) {
		receipt := CockpitInputVersionReceipt{CommandKey: command, RequestHash: hash, InputID: util.UUIDToString(inputID), VersionID: util.UUIDToString(versionID), VersionNumber: 1, Principal: principal}
		row := db.CockpitInputVersion{ID: versionID, InputID: inputID, VersionNumber: 1, SubmissionKey: key, RequestHash: hash, ActorType: "member", ActorID: actor, CredentialOwnerUserID: actor, AuthorizingUserID: actor, SubmissionReceipt: inputRaw(receipt)}
		got, err := inputVersionReceipt(row)
		if err != nil || got.CommandKey != command {
			t.Fatalf("exact receipt: %+v %v", got, err)
		}
		invalid := "invalid-retained-transfer"
		receipt.TransferID = &invalid
		row.SubmissionReceipt = inputRaw(receipt)
		if _, err = inputVersionReceipt(row); inputErrorCode(err) != "input_integrity_error" {
			t.Fatalf("malformed transfer: %v", err)
		}
	})
	t.Run("transfer_command", func(t *testing.T) {
		receipt := CockpitInputTransferReceipt{CommandKey: command, RequestHash: hash, Action: "input_transfer_restart", InputID: util.UUIDToString(inputID), VersionID: util.UUIDToString(versionID), TransferID: util.UUIDToString(transferID), TransferNumber: 2, Mode: "retry_source", Principal: principal}
		row := db.CockpitInputTransfer{ID: transferID, InputID: inputID, VersionID: versionID, TransferNumber: 2, Mode: "retry_source", CommandKey: key, RequestHash: hash, ActorType: pgtype.Text{String: "member", Valid: true}, ActorID: actor, CredentialOwnerUserID: actor, AuthorizingUserID: actor, CommandReceipt: inputRaw(receipt)}
		got, _, err := inputStoredTransferReceipt(row, key)
		if err != nil || got.CommandKey != command {
			t.Fatalf("exact receipt: %+v %v", got, err)
		}
		receipt.Principal.AuthorizingUserID = "invalid-retained-principal"
		row.CommandReceipt = inputRaw(receipt)
		if _, _, err = inputStoredTransferReceipt(row, key); inputErrorCode(err) != "input_integrity_error" {
			t.Fatalf("malformed principal: %v", err)
		}
	})
}
