package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/util"
)

// A batch retains the original status/error body while adding confirmed outcomes.
// Buffering is limited to these small JSON replies; no stream is wrapped here.
type issueBatchResponder struct {
	destination http.ResponseWriter
	headers     http.Header
	status      int
	body        bytes.Buffer
	receipt     service.IssueBatchReceipt
	results     map[string]service.IssueBatchResult
	uncertain   map[string]bool
	current     string
}

func newIssueBatchResponder(w http.ResponseWriter, ws string, ids []string, mode string) *issueBatchResponder {
	b := &issueBatchResponder{destination: w, headers: make(http.Header), receipt: service.IssueBatchReceipt{WorkspaceID: ws, RequestedIDs: []string{}, TransactionMode: mode, TransactionOutcome: "not_started", Results: []service.IssueBatchResult{}, UnconfirmedIDs: []string{}}, results: map[string]service.IssueBatchResult{}, uncertain: map[string]bool{}}
	seen := map[string]bool{}
	for _, raw := range ids {
		id := raw
		if parsed, e := util.ParseUUID(raw); e == nil {
			id = util.UUIDToString(parsed)
		}
		if !seen[id] {
			seen[id] = true
			b.receipt.RequestedIDs = append(b.receipt.RequestedIDs, id)
		}
	}
	return b
}
func (b *issueBatchResponder) Header() http.Header { return b.headers }
func (b *issueBatchResponder) WriteHeader(status int) {
	if b.status == 0 {
		b.status = status
	}
}
func (b *issueBatchResponder) Write(p []byte) (int, error) {
	if b.status == 0 {
		b.status = http.StatusOK
	}
	return b.body.Write(p)
}
func (b *issueBatchResponder) reject(code string) {
	if b.current != "" {
		b.results[b.current] = service.IssueBatchResult{IssueID: b.current, Outcome: "rejected", Code: code}
	}
}
func (b *issueBatchResponder) applied(id string, revision *int64, changed *bool) {
	b.results[id] = service.IssueBatchResult{IssueID: id, Outcome: "applied", Revision: revision, Changed: changed}
}
func (b *issueBatchResponder) unconfirmed(id string) { delete(b.results, id); b.uncertain[id] = true }
func (b *issueBatchResponder) finish() {
	var body map[string]any
	if err := json.Unmarshal(b.body.Bytes(), &body); err != nil {
		body = map[string]any{"error": "batch response could not be confirmed"}
		b.status = http.StatusInternalServerError
	}
	code, _ := body["code"].(string)
	if code == "" {
		code = "batch_rejected"
	}
	if b.status >= 400 && b.current != "" && !b.uncertain[b.current] {
		if _, ok := b.results[b.current]; !ok {
			b.reject(code)
		}
	}
	applied := 0
	for _, id := range b.receipt.RequestedIDs {
		if b.uncertain[id] {
			b.receipt.UnconfirmedIDs = append(b.receipt.UnconfirmedIDs, id)
			continue
		}
		result, ok := b.results[id]
		if !ok {
			result = service.IssueBatchResult{IssueID: id, Outcome: "not_attempted", Code: "batch_stopped"}
		}
		if result.Outcome == "applied" {
			applied++
		}
		b.receipt.Results = append(b.receipt.Results, result)
	}
	if len(b.receipt.UnconfirmedIDs) > 0 {
		b.receipt.TransactionOutcome = "unknown"
	} else if b.receipt.TransactionOutcome != "rolled_back" {
		if applied == len(b.receipt.RequestedIDs) {
			b.receipt.TransactionOutcome = "committed"
		} else if applied > 0 {
			b.receipt.TransactionOutcome = "partial"
		}
	}
	payload, _ := json.Marshal(b.receipt)
	var fields map[string]any
	_ = json.Unmarshal(payload, &fields)
	for key, value := range fields {
		body[key] = value
	}
	if b.receipt.TransactionMode == "atomic" {
		body["deleted"] = applied
	} else {
		body["updated"] = applied
	}
	for key, values := range b.headers {
		b.destination.Header()[key] = values
	}
	if b.status == 0 {
		b.status = http.StatusOK
	}
	writeJSON(b.destination, b.status, body)
}
func validateBatchExpectedRevisions(w http.ResponseWriter, ids []string, expected map[string]int64) (map[pgtype.UUID]int64, bool) {
	out := make(map[pgtype.UUID]int64, len(expected))
	allowed := map[pgtype.UUID]bool{}
	for _, raw := range ids {
		if id, err := util.ParseUUID(raw); err == nil {
			allowed[id] = true
		}
	}
	for raw, value := range expected {
		id, err := util.ParseUUID(raw)
		if err != nil || !allowed[id] || value < 1 {
			writeError(w, http.StatusBadRequest, "expected_revisions must contain positive revisions for requested issue IDs only")
			return nil, false
		}
		if _, duplicate := out[id]; duplicate {
			writeError(w, http.StatusBadRequest, "expected_revisions contains a duplicate issue ID")
			return nil, false
		}
		out[id] = value
	}
	return out, true
}

// Only a commit attempt can have an unknown durable result. Failure before
// commit returns after rollback and must never be called applied.
type issueCommitError struct{ err error }

func (e *issueCommitError) Error() string { return e.err.Error() }
func (e *issueCommitError) Unwrap() error { return e.err }
func issueCommitUnknown(err error) bool {
	var commit *issueCommitError
	return errors.As(err, &commit) && !errors.Is(err, pgx.ErrTxCommitRollback)
}

var errBatchIssueRevisionConflict = errors.New("an issue changed since it was read")

type issueDeleteFailure struct {
	Err             error
	IssueID         pgtype.UUID
	AttemptedIDs    []pgtype.UUID
	CommitAttempted bool
}

func (e *issueDeleteFailure) Error() string { return e.Err.Error() }
func (e *issueDeleteFailure) Unwrap() error { return e.Err }
func (b *issueBatchResponder) deletionFailed(err error, issues []pgtype.UUID) {
	var failure *issueDeleteFailure
	if !errors.As(err, &failure) {
		return
	}
	if failure.CommitAttempted && !errors.Is(err, pgx.ErrTxCommitRollback) {
		for _, id := range issues {
			b.unconfirmed(util.UUIDToString(id))
		}
		return
	}
	if len(failure.AttemptedIDs) > 0 {
		b.receipt.TransactionOutcome = "rolled_back"
		for _, id := range failure.AttemptedIDs {
			key := util.UUIDToString(id)
			b.results[key] = service.IssueBatchResult{IssueID: key, Outcome: "not_applied", Code: "batch_rolled_back"}
		}
		return
	}
	if failure.IssueID.Valid {
		b.current = util.UUIDToString(failure.IssueID)
		code := "delete_rejected"
		if errors.Is(err, errBatchIssueRevisionConflict) {
			code = "revision_conflict"
		} else if errors.Is(err, service.ErrCockpitWorkflowConflict) {
			code = "retained_history"
		} else if errors.Is(err, pgx.ErrNoRows) {
			code = "issue_unavailable"
		}
		b.reject(code)
	}
}
