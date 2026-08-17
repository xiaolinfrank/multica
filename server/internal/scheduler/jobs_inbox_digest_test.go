package scheduler

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func mustUUID(t *testing.T, s string) pgtype.UUID {
	t.Helper()
	id, err := util.ParseUUID(s)
	if err != nil {
		t.Fatalf("parse uuid %q: %v", s, err)
	}
	return id
}

// shanghai shortens time.Date construction for fixed UTC instants: 09:00
// Shanghai == 01:00 UTC (no DST in Asia/Shanghai).
func atShanghai(t *testing.T, y int, mo time.Month, d, h, mi int) time.Time {
	t.Helper()
	loc, err := time.LoadLocation(inboxDigestTimezone)
	if err != nil {
		t.Fatalf("load %s: %v", inboxDigestTimezone, err)
	}
	return time.Date(y, mo, d, h, mi, 0, 0, loc)
}

func TestInboxDigestBoundary(t *testing.T) {
	cases := []struct {
		name string
		now  time.Time
		// wantZero: today's 09:00 Shanghai has not passed yet.
		wantZero bool
		want     time.Time
	}{
		{
			name:     "before nine same day",
			now:      atShanghai(t, 2026, time.August, 17, 8, 59),
			wantZero: true,
		},
		{
			name: "exactly nine is due",
			now:  atShanghai(t, 2026, time.August, 17, 9, 0),
			want: atShanghai(t, 2026, time.August, 17, 9, 0),
		},
		{
			name: "after nine same day",
			now:  atShanghai(t, 2026, time.August, 17, 21, 30),
			want: atShanghai(t, 2026, time.August, 17, 9, 0),
		},
		{
			name:     "late evening utc is next shanghai day before nine",
			now:      time.Date(2026, time.August, 17, 18, 0, 0, 0, time.UTC), // 02:00 +1d Shanghai
			wantZero: true,
		},
		{
			name:     "early morning utc still before shanghai nine",
			now:      time.Date(2026, time.August, 17, 0, 30, 0, 0, time.UTC), // 08:30 Shanghai same day
			wantZero: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := inboxDigestBoundary(tc.now)
			if tc.wantZero {
				if !got.IsZero() {
					t.Fatalf("want zero boundary, got %v", got)
				}
				return
			}
			if got.IsZero() {
				t.Fatalf("want boundary %v, got zero", tc.want)
			}
			if !got.Equal(tc.want) {
				t.Fatalf("boundary = %v, want %v", got, tc.want)
			}
			// Canonical UTC: the planner contract for hook-returned plans.
			if got.Location() != time.UTC {
				t.Fatalf("boundary must be canonical UTC, got %v", got.Location())
			}
		})
	}
}

func TestInboxDigestPlans(t *testing.T) {
	ctx := context.Background()
	nineToday := atShanghai(t, 2026, time.August, 17, 9, 0).UTC()

	t.Run("before nine nothing due", func(t *testing.T) {
		plans, err := inboxDigestPlans(ctx, ScopeGlobal, atShanghai(t, 2026, time.August, 17, 8, 0), LatestPlanInfo{})
		if err != nil {
			t.Fatalf("plans: %v", err)
		}
		if len(plans) != 0 {
			t.Fatalf("want no plans before 09:00, got %v", plans)
		}
	})

	t.Run("after nine with no history plans today", func(t *testing.T) {
		plans, err := inboxDigestPlans(ctx, ScopeGlobal, atShanghai(t, 2026, time.August, 17, 9, 1), LatestPlanInfo{})
		if err != nil {
			t.Fatalf("plans: %v", err)
		}
		if len(plans) != 1 || !plans[0].Equal(nineToday) {
			t.Fatalf("want [%v], got %v", nineToday, plans)
		}
	})

	t.Run("already stored at today boundary skips", func(t *testing.T) {
		plans, err := inboxDigestPlans(ctx, ScopeGlobal, atShanghai(t, 2026, time.August, 17, 15, 0),
			LatestPlanInfo{Found: true, PlanTime: nineToday, Status: "SUCCESS"})
		if err != nil {
			t.Fatalf("plans: %v", err)
		}
		if len(plans) != 0 {
			t.Fatalf("want no re-plan after success, got %v", plans)
		}
	})

	t.Run("failed plan from an older day is never retried", func(t *testing.T) {
		yesterday := nineToday.Add(-24 * time.Hour)
		plans, err := inboxDigestPlans(ctx, ScopeGlobal, atShanghai(t, 2026, time.August, 17, 9, 1),
			LatestPlanInfo{Found: true, PlanTime: yesterday, Status: "FAILED", Attempt: 1, MaxAttempts: 1})
		if err != nil {
			t.Fatalf("plans: %v", err)
		}
		// A retry of yesterday's plan would duplicate yesterday's digest
		// content under a stale plan_time — today's boundary must win.
		if len(plans) != 1 || !plans[0].Equal(nineToday) {
			t.Fatalf("want [%v] (today only), got %v", nineToday, plans)
		}
	})

	t.Run("stored plan in the future skips", func(t *testing.T) {
		// Defensive: a future-dated row (clock skew) must not block forever
		// once its day passes — but while it is newer than today's boundary
		// we do not plan.
		plans, err := inboxDigestPlans(ctx, ScopeGlobal, atShanghai(t, 2026, time.August, 17, 9, 1),
			LatestPlanInfo{Found: true, PlanTime: nineToday.Add(24 * time.Hour), Status: "SUCCESS"})
		if err != nil {
			t.Fatalf("plans: %v", err)
		}
		if len(plans) != 0 {
			t.Fatalf("want no plans, got %v", plans)
		}
	})
}

func TestInboxEmailDigestJobSpecValidates(t *testing.T) {
	spec := InboxEmailDigestJob(nil, nil)
	if err := spec.validate(); err != nil {
		t.Fatalf("spec validation: %v", err)
	}
}

func digestRow(t *testing.T, wsID, wsName, wsSlug, userID, userName, email, notifType, severity, title, body string, at time.Time) db.ListUnreadInboxForDigestRow {
	t.Helper()
	return db.ListUnreadInboxForDigestRow{
		WorkspaceID:    mustUUID(t, wsID),
		WorkspaceName:  wsName,
		WorkspaceSlug:  wsSlug,
		RecipientID:    mustUUID(t, userID),
		RecipientName:  userName,
		RecipientEmail: email,
		Type:           notifType,
		Severity:       severity,
		Title:          title,
		Body:           pgtype.Text{String: body, Valid: body != ""},
		CreatedAt:      pgtype.Timestamptz{Time: at, Valid: true},
	}
}

func TestAggregateDigest(t *testing.T) {
	wsA, wsB := "00000000-0000-0000-0000-00000000000a", "00000000-0000-0000-0000-00000000000b"
	u1, u2 := "00000000-0000-0000-0000-000000000011", "00000000-0000-0000-0000-000000000022"
	base := time.Date(2026, time.August, 17, 1, 0, 0, 0, time.UTC) // 09:00 Shanghai

	rows := []db.ListUnreadInboxForDigestRow{
		// u1 has one old and one new item in wsA, plus one item in wsB.
		digestRow(t, wsA, "WS A", "ws-a", u1, "甲", "a@x.cn", "new_comment", "info", "旧评论", "", base.Add(-48*time.Hour)),
		digestRow(t, wsA, "WS A", "ws-a", u1, "甲", "a@x.cn", "mentioned", "action_required", "新提及", "", base.Add(-1*time.Hour)),
		digestRow(t, wsB, "WS B", "ws-b", u1, "甲", "a@x.cn", "status_changed", "info", "B 中新状态", "", base.Add(-2*time.Hour)),
		// u2 has one item in wsA but muted there.
		digestRow(t, wsA, "WS A", "ws-a", u2, "乙", "b@x.cn", "issue_assigned", "info", "给乙的指派", "", base.Add(-3*time.Hour)),
	}

	t.Run("groups per recipient and orders newest sections and items", func(t *testing.T) {
		got := aggregateDigest(rows, nil, "http://app")
		if len(got) != 2 {
			t.Fatalf("want 2 recipients, got %d", len(got))
		}
		// Deterministic order by email: a@x.cn before b@x.cn.
		if got[0].email != "a@x.cn" || got[1].email != "b@x.cn" {
			t.Fatalf("recipient order by email broken: %v, %v", got[0].email, got[1].email)
		}
		r := got[0]
		if len(r.sections) != 2 {
			t.Fatalf("want 2 sections for u1, got %d", len(r.sections))
		}
		// wsB's item (-2h) is newer than wsA's newest (-1h)? No: -1h is
		// newer, so wsA leads.
		if r.sections[0].WorkspaceName != "WS A" || r.sections[1].WorkspaceName != "WS B" {
			t.Fatalf("sections not newest-first: %v, %v", r.sections[0].WorkspaceName, r.sections[1].WorkspaceName)
		}
		if got[0].sections[0].Items[0].Title != "新提及" {
			t.Fatalf("items not newest-first: %v", r.sections[0].Items[0].Title)
		}
		if r.sections[0].InboxURL != "http://app/ws-a/inbox" {
			t.Fatalf("inbox url = %q", r.sections[0].InboxURL)
		}
	})

	t.Run("muted pair drops that workspace only", func(t *testing.T) {
		muted := map[string]bool{digestMuteKey(wsA, u1): true}
		got := aggregateDigest(rows, muted, "http://app")
		if len(got) != 2 {
			t.Fatalf("want 2 recipients, got %d", len(got))
		}
		for _, r := range got {
			for _, s := range r.sections {
				if r.email == "a@x.cn" && s.WorkspaceName == "WS A" {
					t.Fatalf("muted (ws,user) pair still present")
				}
			}
		}
		// u1 keeps wsB; u2 is not muted in wsA.
		byEmail := map[string]int{}
		for _, r := range got {
			byEmail[r.email] = r.total
		}
		if byEmail["a@x.cn"] != 1 || byEmail["b@x.cn"] != 1 {
			t.Fatalf("totals after mute = %v", byEmail)
		}
	})

	t.Run("fully muted recipient disappears", func(t *testing.T) {
		muted := map[string]bool{digestMuteKey(wsA, u2): true}
		got := aggregateDigest(rows[3:], muted, "http://app")
		if len(got) != 0 {
			t.Fatalf("want 0 recipients, got %d", len(got))
		}
	})

	t.Run("caps per workspace items and counts overflow", func(t *testing.T) {
		var many []db.ListUnreadInboxForDigestRow
		for i := 0; i < inboxDigestMaxItemsPerWorkspace+3; i++ {
			many = append(many, digestRow(t, wsA, "WS A", "ws-a", u1, "甲", "a@x.cn",
				"new_comment", "info", "条目", "", base.Add(-time.Duration(i)*time.Minute)))
		}
		got := aggregateDigest(many, nil, "http://app")
		if len(got) != 1 {
			t.Fatalf("want 1 recipient, got %d", len(got))
		}
		sec := got[0].sections[0]
		if len(sec.Items) != inboxDigestMaxItemsPerWorkspace {
			t.Fatalf("cap not applied: %d items", len(sec.Items))
		}
		if sec.OverflowCount != 3 {
			t.Fatalf("overflow = %d, want 3", sec.OverflowCount)
		}
		if got[0].total != inboxDigestMaxItemsPerWorkspace+3 {
			t.Fatalf("total = %d", got[0].total)
		}
	})

	t.Run("empty email recipient dropped", func(t *testing.T) {
		got := aggregateDigest([]db.ListUnreadInboxForDigestRow{
			digestRow(t, wsA, "WS A", "ws-a", u1, "无邮箱", "  ", "mentioned", "info", "标题", "", base),
		}, nil, "http://app")
		if len(got) != 0 {
			t.Fatalf("want 0 recipients, got %d", len(got))
		}
	})
}

// TestInboxDigestSenderInterfaceCompile pins the interface satisfaction so
// refactors of EmailService surface here rather than at wiring time.
func TestInboxDigestSenderInterfaceCompile(t *testing.T) {
	var _ InboxDigestSender = (*service.EmailService)(nil)
}
