package service

import (
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// cockpitMinutesState is the normalized minutes workflow state (R1,
// design-principles-2026-10-12): the work package is dissolved, the state
// lives on cockpit_meeting (minutes_* columns) and "released" is a projection
// (some minutes task already left backlog), re-evaluated on every read.
type cockpitMinutesState struct {
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
}

func minutesStateFromGet(ws pgtype.UUID, r db.GetCockpitMeetingWorkPackageRow) cockpitMinutesState {
	return cockpitMinutesState{WorkspaceID: ws, MeetingID: r.MeetingID, Revision: r.Revision, MinutesIssueID: r.MinutesIssueID,
		ReviewerID: r.ReviewerID, MaterialsReady: r.MaterialsReady, MaterialsConfirmedAt: r.MaterialsConfirmedAt,
		MaterialsConfirmedBy: r.MaterialsConfirmedBy, CurrentVersionID: r.CurrentVersionID,
		PublishedVersionID: r.PublishedVersionID, ConfiguredBy: r.ConfiguredBy, Released: r.Released}
}

func minutesStateFromLock(ws pgtype.UUID, r db.LockCockpitMeetingWorkPackageRow) cockpitMinutesState {
	return cockpitMinutesState{WorkspaceID: ws, MeetingID: r.MeetingID, Revision: r.Revision, MinutesIssueID: r.MinutesIssueID,
		ReviewerID: r.ReviewerID, MaterialsReady: r.MaterialsReady, MaterialsConfirmedAt: r.MaterialsConfirmedAt,
		MaterialsConfirmedBy: r.MaterialsConfirmedBy, CurrentVersionID: r.CurrentVersionID,
		PublishedVersionID: r.PublishedVersionID, ConfiguredBy: r.ConfiguredBy, Released: r.Released}
}

func minutesStateFromSetup(ws pgtype.UUID, r db.SetCockpitMinutesSetupRow) cockpitMinutesState {
	return cockpitMinutesState{WorkspaceID: ws, MeetingID: r.MeetingID, Revision: r.Revision, MinutesIssueID: r.MinutesIssueID,
		ReviewerID: r.ReviewerID, MaterialsReady: r.MaterialsReady, MaterialsConfirmedAt: r.MaterialsConfirmedAt,
		MaterialsConfirmedBy: r.MaterialsConfirmedBy, CurrentVersionID: r.CurrentVersionID,
		PublishedVersionID: r.PublishedVersionID, ConfiguredBy: r.ConfiguredBy}
}

func minutesStateFromReadiness(ws pgtype.UUID, r db.SetCockpitMeetingReadinessRow) cockpitMinutesState {
	return cockpitMinutesState{WorkspaceID: ws, MeetingID: r.MeetingID, Revision: r.Revision, MinutesIssueID: r.MinutesIssueID,
		ReviewerID: r.ReviewerID, MaterialsReady: r.MaterialsReady, MaterialsConfirmedAt: r.MaterialsConfirmedAt,
		MaterialsConfirmedBy: r.MaterialsConfirmedBy, CurrentVersionID: r.CurrentVersionID,
		PublishedVersionID: r.PublishedVersionID, ConfiguredBy: r.ConfiguredBy}
}

func minutesStateFromRevision(ws pgtype.UUID, r db.AdvanceCockpitWorkflowRevisionRow) cockpitMinutesState {
	return cockpitMinutesState{WorkspaceID: ws, MeetingID: r.MeetingID, Revision: r.Revision, MinutesIssueID: r.MinutesIssueID,
		ReviewerID: r.ReviewerID, MaterialsReady: r.MaterialsReady, MaterialsConfirmedAt: r.MaterialsConfirmedAt,
		MaterialsConfirmedBy: r.MaterialsConfirmedBy, CurrentVersionID: r.CurrentVersionID,
		PublishedVersionID: r.PublishedVersionID, ConfiguredBy: r.ConfiguredBy}
}

func minutesStateFromCurrent(ws pgtype.UUID, r db.SetCockpitCurrentMinutesVersionRow) cockpitMinutesState {
	return cockpitMinutesState{WorkspaceID: ws, MeetingID: r.MeetingID, Revision: r.Revision, MinutesIssueID: r.MinutesIssueID,
		ReviewerID: r.ReviewerID, MaterialsReady: r.MaterialsReady, MaterialsConfirmedAt: r.MaterialsConfirmedAt,
		MaterialsConfirmedBy: r.MaterialsConfirmedBy, CurrentVersionID: r.CurrentVersionID,
		PublishedVersionID: r.PublishedVersionID, ConfiguredBy: r.ConfiguredBy}
}

func minutesStateFromPublished(ws pgtype.UUID, r db.SetCockpitPublishedMinutesVersionRow) cockpitMinutesState {
	return cockpitMinutesState{WorkspaceID: ws, MeetingID: r.MeetingID, Revision: r.Revision, MinutesIssueID: r.MinutesIssueID,
		ReviewerID: r.ReviewerID, MaterialsReady: r.MaterialsReady, MaterialsConfirmedAt: r.MaterialsConfirmedAt,
		MaterialsConfirmedBy: r.MaterialsConfirmedBy, CurrentVersionID: r.CurrentVersionID,
		PublishedVersionID: r.PublishedVersionID, ConfiguredBy: r.ConfiguredBy}
}

func minutesStateFromSnapshot(ws pgtype.UUID, r db.GetCockpitWorkflowSnapshotRow) cockpitMinutesState {
	return cockpitMinutesState{WorkspaceID: ws, MeetingID: ws, Revision: r.Revision, MinutesIssueID: r.MinutesIssueID,
		ReviewerID: r.ReviewerID, MaterialsReady: r.MaterialsReady, CurrentVersionID: r.CurrentVersionID,
		PublishedVersionID: r.PublishedVersionID}
}

func minutesStateFromForRead(ws pgtype.UUID, meetingID pgtype.UUID, r db.GetCockpitMeetingWorkPackageForReadRow) cockpitMinutesState {
	return cockpitMinutesState{WorkspaceID: ws, MeetingID: meetingID, Revision: r.Revision, MinutesIssueID: r.MinutesIssueID,
		ReviewerID: r.ReviewerID, MaterialsReady: r.MaterialsReady, MaterialsConfirmedAt: r.MaterialsConfirmedAt,
		MaterialsConfirmedBy: r.MaterialsConfirmedBy, CurrentVersionID: r.CurrentVersionID,
		PublishedVersionID: r.PublishedVersionID, ConfiguredBy: r.ConfiguredBy}
}

func ptr[T any](v T) *T { return &v }
