package handler

import (
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// handlerCockpitMinutesState mirrors the service-side minutes state for
// handler-side projection (R1: the work package is dissolved).
type handlerCockpitMinutesState struct {
	WorkspaceID          pgtype.UUID
	MeetingID            pgtype.UUID
	Revision             int64
	MinutesIssueID       pgtype.UUID
	ReviewerID           pgtype.UUID
	MaterialsReady       bool
	MaterialsConfirmedAt pgtype.Timestamptz
	MaterialsConfirmedBy pgtype.UUID
	CurrentVersionID     pgtype.UUID
	PublishedVersionID   pgtype.UUID
	ConfiguredBy         pgtype.UUID
	Released             bool
	ReleasedAt           pgtype.Timestamptz
	ReleaseTaskID        pgtype.UUID
}

func minutesProjectionFromGet(ws pgtype.UUID, r db.GetCockpitMeetingWorkPackageRow) handlerCockpitMinutesState {
	return handlerCockpitMinutesState{WorkspaceID: ws, MeetingID: r.MeetingID, Revision: r.Revision, MinutesIssueID: r.MinutesIssueID,
		ReviewerID: r.ReviewerID, MaterialsReady: r.MaterialsReady, MaterialsConfirmedAt: r.MaterialsConfirmedAt,
		MaterialsConfirmedBy: r.MaterialsConfirmedBy, CurrentVersionID: r.CurrentVersionID,
		PublishedVersionID: r.PublishedVersionID, ConfiguredBy: r.ConfiguredBy, Released: r.Released}
}

func minutesProjectionFromForRead(ws, meetingID pgtype.UUID, r db.GetCockpitMeetingWorkPackageForReadRow) handlerCockpitMinutesState {
	return handlerCockpitMinutesState{WorkspaceID: ws, MeetingID: meetingID, Revision: r.Revision, MinutesIssueID: r.MinutesIssueID,
		ReviewerID: r.ReviewerID, MaterialsReady: r.MaterialsReady, MaterialsConfirmedAt: r.MaterialsConfirmedAt,
		MaterialsConfirmedBy: r.MaterialsConfirmedBy, CurrentVersionID: r.CurrentVersionID,
		PublishedVersionID: r.PublishedVersionID, ConfiguredBy: r.ConfiguredBy, Released: r.ReleasedAt.Valid, ReleasedAt: r.ReleasedAt, ReleaseTaskID: r.ReleaseTaskID}
}

func minutesProjectionFromSnapshot(ws, meetingID pgtype.UUID, r db.GetCockpitWorkflowSnapshotRow) handlerCockpitMinutesState {
	return handlerCockpitMinutesState{WorkspaceID: ws, MeetingID: meetingID, Revision: r.Revision, MinutesIssueID: r.MinutesIssueID,
		ReviewerID: r.ReviewerID, MaterialsReady: r.MaterialsReady, CurrentVersionID: r.CurrentVersionID,
		PublishedVersionID: r.PublishedVersionID}
}
