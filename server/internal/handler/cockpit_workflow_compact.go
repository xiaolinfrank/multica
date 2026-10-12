package handler

import (
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Command references are captured from validated input or the committed service
// result. A receipt is never guessed from the first history page/current pin.
type cockpitWorkflowReceiptRef struct {
	VersionID, SubmissionKey, HandoffKey, ExportID pgtype.UUID
	ExportTarget                                   *service.CockpitMinutesExportTarget
}

func validateCockpitWorkflowRepresentation(w http.ResponseWriter, r *http.Request) bool {
	value := r.URL.Query().Get("response")
	if value != "" && value != "full" && value != "compact" {
		writeError(w, http.StatusBadRequest, "response must be full or compact")
		return false
	}
	if value == "compact" && r.Method == http.MethodGet {
		writeError(w, http.StatusBadRequest, "use workflow/summary for bounded reads")
		return false
	}
	return true
}
func (h *Handler) cockpitCompactResult(r *http.Request, cc cockpitContext, meetingID pgtype.UUID, action string, ref cockpitWorkflowReceiptRef) (CockpitWorkflowCompactResponse, error) {
	out := CockpitWorkflowCompactResponse{Representation: "compact", WorkspaceID: uuidToString(cc.workspaceID), MeetingID: uuidToString(meetingID), Receipt: CockpitWorkflowCommandReceipt{Action: action}}
	x, err := h.beginCockpitHistory(r, cc, meetingID)
	if err != nil {
		return out, err
	}
	defer x.tx.Rollback(x.ctx)
	if x.work == nil {
		return out, service.ErrCockpitWorkflowNotFound
	}
	if ref.SubmissionKey.Valid {
		row, e := x.q.GetCockpitMinutesSubmission(x.ctx, db.GetCockpitMinutesSubmissionParams{WorkspaceID: cc.workspaceID, MeetingID: meetingID, SubmissionKey: ref.SubmissionKey})
		if e != nil {
			return out, historyError(e)
		}
		cards, e := x.cards([]pgtype.UUID{row.ReviewIssueID})
		if e != nil {
			return out, e
		}
		v := cockpitMinutesVersionToResponse(row, cards[row.ReviewIssueID])
		out.Receipt.Version = &v
	}
	if ref.HandoffKey.Valid {
		row, e := x.q.GetCockpitReviewerHandoff(x.ctx, db.GetCockpitReviewerHandoffParams{WorkspaceID: cc.workspaceID, MeetingID: meetingID, HandoffKey: ref.HandoffKey})
		if e != nil {
			return out, historyError(e)
		}
		items, e := x.handoffs([]pgtype.UUID{row.ID})
		if e != nil {
			return out, e
		}
		item, ok := items[row.ID]
		if !ok {
			return out, service.ErrCockpitWorkflowNotFound
		}
		out.Receipt.Handoff = &item
		ref.VersionID = row.VersionID
	}
	if ref.VersionID.Valid {
		v, e := x.fullVersion(ref.VersionID)
		if e != nil {
			return out, e
		}
		out.Receipt.Version = &v
	}
	if ref.ExportTarget != nil {
		if out.Receipt.Version == nil || h.IssueService.CockpitNASExporter == nil {
			return out, service.ErrCockpitWorkflowNotFound
		}
		v := out.Receipt.Version
		target := ref.ExportTarget
		dest, e := h.IssueService.CockpitNASExporter.Resolve(uuidToString(cc.workspaceID), target.Directory, v.ID, v.VersionNumber)
		if e != nil {
			return out, e
		}
		if dest.RootID != target.RootID {
			return out, service.ErrCockpitWorkflowConflict
		}
		job, e := x.q.GetCockpitMinutesExportDestination(x.ctx, db.GetCockpitMinutesExportDestinationParams{WorkspaceID: cc.workspaceID, VersionID: ref.VersionID, RootID: dest.RootID, RelativePath: dest.RelativePath})
		if e != nil {
			return out, historyError(e)
		}
		ref.ExportID = job.ID
	}
	if ref.ExportID.Valid {
		items, e := x.exports([]pgtype.UUID{ref.ExportID})
		if e != nil {
			return out, e
		}
		item, ok := items[ref.ExportID]
		if !ok {
			return out, service.ErrCockpitWorkflowNotFound
		}
		out.Receipt.NASExport = &item
	}
	switch action {
	case "enabled", "readiness", "released":
	case "submitted", "reviewed", "published":
		if out.Receipt.Version == nil {
			return out, fmt.Errorf("missing version command receipt")
		}
	case "reviewer_reassigned":
		if out.Receipt.Handoff == nil {
			return out, fmt.Errorf("missing reviewer command receipt")
		}
	case "nas_export_queued", "nas_export_retried":
		if out.Receipt.NASExport == nil {
			return out, fmt.Errorf("missing export command receipt")
		}
	case "bound", "unbound", "focused":
		// Association commands confirm through the resulting workflow state;
		// no dedicated receipt object beyond the action name.
	default:
		return out, fmt.Errorf("unsupported compact command receipt")
	}
	out.Workflow, err = h.cockpitHistorySummary(r, x)
	return out, err
}
