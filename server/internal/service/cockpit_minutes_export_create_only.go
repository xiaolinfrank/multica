package service

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/cockpitnas"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func (w *CockpitMinutesExportWorker) createOnlyAttempt(ctx context.Context, row db.CockpitMinutesExport, request cockpitnas.Request) (cockpitnas.Result, error) {
	target, receipt, err := cockpitnas.AttemptPaths(request.Destination, request.OperationID, request.AttemptID)
	if err != nil {
		return cockpitnas.Result{}, err
	}
	_, err = w.queries.CreateCockpitMinutesExportAttempt(ctx, db.CreateCockpitMinutesExportAttemptParams{
		WorkspaceID: row.WorkspaceID, ExportID: row.ID, LeaseToken: row.LeaseToken, TargetPath: target, ReceiptPath: receipt,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return cockpitnas.Result{}, &cockpitnas.Error{Code: "lease_expired", Message: "The export lease ended before filesystem access; no new attempt was written.", Retryable: true}
	}
	if err != nil {
		return cockpitnas.Result{}, err
	}
	// Recovery reads only paths named by the durable ledger, in bounded pages.
	// A complete receipt lost before a DB acknowledgement is reused. No existing
	// file is appended to, repaired in place, deleted, or renamed.
	before := row.Attempts
	for {
		if err := ctx.Err(); err != nil {
			return cockpitnas.Result{}, err
		}
		previous, err := w.queries.ListCockpitMinutesExportAttemptsPage(ctx, db.ListCockpitMinutesExportAttemptsPageParams{
			WorkspaceID: row.WorkspaceID, MeetingID: row.MeetingID, ExportID: row.ID, BeforeAttempt: before, PageLimit: 25,
		})
		if err != nil {
			return cockpitnas.Result{}, err
		}
		for _, attempt := range previous {
			prior := request
			prior.AttemptID = util.UUIDToString(attempt.ID)
			path, completion, err := cockpitnas.AttemptPaths(request.Destination, request.OperationID, prior.AttemptID)
			if err != nil || attempt.TargetPath != path || attempt.ReceiptPath != completion || attempt.ContentHash != row.ContentHash {
				return cockpitnas.Result{}, &cockpitnas.Error{Code: "attempt_conflict", Message: "The recorded attempt no longer matches its pinned destination and content."}
			}
			verified, err := w.exporter.VerifyAttempt(ctx, prior)
			if err == nil {
				return validateCreateOnlyResult(prior, verified)
			}
			var incomplete *cockpitnas.Error
			if !errors.As(err, &incomplete) || incomplete.Code != "attempt_incomplete" {
				return cockpitnas.Result{}, err
			}
		}
		if len(previous) < 25 {
			break
		}
		before = previous[len(previous)-1].AttemptNumber
	}
	result, err := w.exporter.Write(ctx, request)
	if err != nil {
		return cockpitnas.Result{}, err
	}
	return validateCreateOnlyResult(request, result)
}

func validateCreateOnlyResult(request cockpitnas.Request, result cockpitnas.Result) (cockpitnas.Result, error) {
	target, receipt, err := cockpitnas.AttemptPaths(request.Destination, request.OperationID, request.AttemptID)
	digest, hashErr := hex.DecodeString(result.ReceiptHash)
	if err != nil || result.AttemptID != request.AttemptID || result.Path != target || result.ReceiptPath != receipt ||
		result.ContentHash != request.ContentHash || result.Size != int64(len(request.Content)) || hashErr != nil || len(digest) != 32 ||
		fmt.Sprintf("%x", digest) != result.ReceiptHash {
		return cockpitnas.Result{}, &cockpitnas.Error{Code: "result_conflict", Message: "The create-only result did not carry the exact attempt, paths, content and completion evidence."}
	}
	return result, nil
}
