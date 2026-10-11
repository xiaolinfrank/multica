package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
)

func TestCockpitMeetingArchiveFiltersPreserveExactAndNodeHistory(t *testing.T) {
	f := newPlanningFixture(t)
	defer f.Cleanup(t, "DELETE FROM cockpit_meeting_lifecycle_command WHERE workspace_id=$1", f.ws)
	ctx := context.Background()
	p := surfaceQuery(f)
	header, err := f.issues.GetCockpitSurfaceContext(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	archived := map[string]bool{}
	for i := range 4 {
		date := "2026-10-10"
		if i > 1 {
			date = "2026-10-11"
		}
		id := f.Insert(t, "cockpit_meeting", testutil.Cols{"workspace_id": f.ws, "cockpit_id": header.Cockpit.ID, "title": fmt.Sprintf("Archive register %d", i), "kind": "archive regression", "meet_date": date})
		f.InsertNoID(t, "cockpit_meeting_node", testutil.Cols{"workspace_id": f.ws, "meeting_id": id, "node_id": f.a}, "workspace_id=$1 AND meeting_id=$2 AND node_id=$3", f.ws, id, f.a)
		archived[id] = i > 1
		if i > 1 {
			read := CockpitLifecycleRead{WorkspaceID: f.ws, MeetingID: parseTestUUID(t, id), ActorID: f.owner, Human: true}
			value, err := f.issues.GetCockpitMeetingLifecycle(ctx, read)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = f.issues.ChangeCockpitMeetingDisposition(ctx, read, CockpitMeetingDispositionInput{CockpitLifecycleCommandInput: lifecycleInput(value.LifecycleRevision), Transition: "archive", Reason: "Retain the recorded meeting outside the active register."}); err != nil {
				t.Fatal(err)
			}
		}
	}
	query := CockpitMeetingRegisterQuery{CockpitSurfaceQuery: p, Kinds: []string{"archive regression"}, PageSize: 1, DateFrom: "2026-10-01", DateTo: "2026-10-31"}
	for _, mode := range []string{"", "archived", "all"} {
		query.Archive, query.Cursor = mode, ""
		want, echo := int64(2), mode
		if mode == "" {
			echo = "active"
		}
		if mode == "all" {
			want = 4
		}
		seen := map[string]bool{}
		for {
			page, err := f.issues.ListCockpitMeetingRegister(ctx, query)
			if err != nil {
				t.Fatal(err)
			}
			if page.Total != want || page.Archive != echo || len(page.Items) > 1 {
				t.Fatalf("wrong archive page: %+v", page)
			}
			for _, raw := range page.Items {
				var row struct {
					ID         string  `json:"id"`
					ArchivedAt *string `json:"archived_at"`
				}
				if err := json.Unmarshal(raw, &row); err != nil {
					t.Fatal(err)
				}
				isArchived, exists := archived[row.ID]
				if !exists || seen[row.ID] || (row.ArchivedAt != nil) != isArchived || mode != "all" && isArchived != (mode == "archived") {
					t.Fatalf("wrong archive result: %s", raw)
				}
				seen[row.ID] = true
			}
			if page.NextCursor == nil {
				break
			}
			if query.Cursor == "" {
				other := query
				other.Cursor = *page.NextCursor
				other.Archive = "all"
				if mode == "all" {
					other.Archive = "active"
				}
				if _, err := f.issues.ListCockpitMeetingRegister(ctx, other); !errors.Is(err, ErrCockpitWorkflowInput) {
					t.Fatalf("cursor crossed archive filters: %v", err)
				}
			}
			query.Cursor = *page.NextCursor
		}
		if int64(len(seen)) != want {
			t.Fatalf("lost archive rows: %d want %d", len(seen), want)
		}
		markers, err := f.issues.GetCockpitPlanMeetingMarkers(ctx, CockpitPlanMarkerQuery{CockpitSurfaceQuery: p, Rows: []CockpitPlanMarkerRow{{RowKey: "execution", NodeIDs: []string{util.UUIDToString(f.a)}}}, DateFrom: "2026-10-01", DateTo: "2026-10-31", Archive: mode})
		if err != nil {
			t.Fatal(err)
		}
		var total int64
		for _, group := range markers.Groups {
			total += group.Total
		}
		if total != want || markers.Archive != echo {
			t.Fatalf("marker/register archive scopes differ: %+v", markers)
		}
	}
	detail, err := f.issues.GetCockpitSurfaceNode(ctx, p, f.a)
	if err != nil || detail.Meetings.Total != 4 || detail.Meetings.Archive != "all" {
		t.Fatalf("node history silently hid archived meetings: %+v %v", detail.Meetings, err)
	}
	related := CockpitMeetingRegisterQuery{CockpitSurfaceQuery: p, NodeID: f.a, Archive: "all", PageSize: 2}
	relations, err := f.issues.ListCockpitMeetingRegister(ctx, related)
	if err != nil || relations.Total != 4 || len(relations.Items) != 2 || relations.NextCursor == nil {
		t.Fatalf("node relation continuation lost historical meetings: %+v %v", relations, err)
	}
	related.Cursor = *relations.NextCursor
	tail, err := f.issues.ListCockpitMeetingRegister(ctx, related)
	if err != nil || tail.Total != 4 || len(tail.Items) != 2 || tail.NextCursor != nil {
		t.Fatalf("node meeting history continuation: %+v %v", tail, err)
	}
	for id, isArchived := range archived {
		if !isArchived {
			continue
		}
		meeting, err := f.issues.GetCockpitSurfaceMeeting(ctx, p, parseTestUUID(t, id))
		if err != nil || !meeting.ScopeMatch {
			t.Fatalf("archived exact link became inaccessible: %+v %v", meeting, err)
		}
	}
	query.Archive, query.Cursor = "unknown", ""
	if _, err := f.issues.ListCockpitMeetingRegister(ctx, query); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("unknown archive filter silently became active: %v", err)
	}
}

func TestCockpitMeetingArchiveHidesRecentCardsButKeepsPendingResponsibilities(t *testing.T) {
	f := newPlanningFixture(t)
	defer f.Cleanup(t, "DELETE FROM cockpit_meeting_lifecycle_command WHERE workspace_id=$1", f.ws)
	ctx := context.Background()
	action := f.draft(t, "Follow up the retained decision")
	current, _ := submitHandoffFixtureVersion(t, f.cockpitWorkflowFixture)
	f.Exec(t, "UPDATE cockpit_meeting SET meet_date='2026-10-10' WHERE id=$1", f.meeting)
	p := overviewQuery(f.cockpitWorkflowFixture)
	before, err := f.issues.GetCockpitOverview(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	if before.RecentMeetings.Total != 1 || before.Attention.Total < 2 {
		t.Fatalf("fixture lacks a recent meeting and its independent duties: %+v", before)
	}
	read := lifecycleRead(f.cockpitWorkflowFixture)
	lifecycle, err := f.issues.GetCockpitMeetingLifecycle(ctx, read)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.issues.ChangeCockpitMeetingDisposition(ctx, read, CockpitMeetingDispositionInput{CockpitLifecycleCommandInput: lifecycleInput(lifecycle.LifecycleRevision), Transition: "archive", Reason: "Keep this meeting's remaining review and action available."}); err != nil {
		t.Fatal(err)
	}
	after, err := f.issues.GetCockpitOverview(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	ids := func(page CockpitAttentionPage) []string {
		out := []string{}
		for _, item := range page.Items {
			out = append(out, item.ID)
		}
		slices.Sort(out)
		return out
	}
	if after.RecentMeetings.Total != 0 || after.Attention.Total != before.Attention.Total || !reflect.DeepEqual(ids(after.Attention), ids(before.Attention)) {
		t.Fatalf("archive erased active responsibility or retained a recent card: before=%+v after=%+v", before, after)
	}
	if err = f.issues.ReviewCockpitMeetingMinutes(ctx, CockpitMinutesReview{CockpitMinutesVersionCommand: CockpitMinutesVersionCommand{CockpitWorkPackageCommand: f.command(t), VersionID: current.ID}, Decision: "approved"}); err != nil {
		t.Fatalf("archive blocked existing review: %v", err)
	}
	if err = f.issues.PublishCockpitMeetingMinutes(ctx, CockpitMinutesVersionCommand{CockpitWorkPackageCommand: f.command(t), VersionID: current.ID}); err != nil {
		t.Fatalf("archive blocked approved publication: %v", err)
	}
	p.Kind, p.PageSize = "action", 25
	pending, err := f.issues.ListCockpitOverviewAttention(ctx, p)
	if err != nil || pending.Total != 1 || pending.Items[0].ID != util.UUIDToString(action.ID) {
		t.Fatalf("published replacement erased the older unresolved action: %+v %v", pending, err)
	}
	if _, err := f.issues.GetCockpitSurfaceMeeting(ctx, CockpitSurfaceQuery{WorkspaceID: f.ws, ActorID: f.owner, Human: true, ProjectID: pgtype.UUID{}}, f.meeting); err != nil {
		t.Fatalf("exact historical record is inaccessible: %v", err)
	}
}
