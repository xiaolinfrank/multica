package scheduler

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// JobNameInboxEmailDigest is the canonical name used in sys_cron_executions
// audit rows. Stable across releases — do not rename without a migration.
const JobNameInboxEmailDigest = "inbox_email_digest"

// The digest fires daily at 09:00 Asia/Shanghai and emails every member a
// single summary of unread inbox notifications received in the past 7 days.
// The schedule is pinned to Asia/Shanghai (deployment is Shanghai-only); the
// blank tzdata import in internal/service/email.go guarantees the location
// loads on hosts without system tzdata.
const (
	inboxDigestTimezone = "Asia/Shanghai"
	inboxDigestHour     = 9
	inboxDigestWindow   = 7 * 24 * time.Hour
	// inboxDigestMaxItemsPerWorkspace caps the per-workspace item list in the
	// email; anything beyond is summarised as an overflow count. The digest
	// must stay scannable even for a recipient who ignored a busy week.
	inboxDigestMaxItemsPerWorkspace = 8
)

// InboxDigestSender is the email dependency of the digest job, satisfied by
// *service.EmailService. Narrow interface so tests can fake delivery.
type InboxDigestSender interface {
	SendInboxSummaryEmail(to string, in service.InboxSummaryEmailInput) error
}

// InboxEmailDigestJob returns the JobSpec for the daily unread-inbox digest.
//
// Planning uses the PlansForScope hook because "09:00 Asia/Shanghai" is not a
// UTC-cadence grid (FloorPlan aligns to UTC buckets). At most one plan_time —
// today's 09:00 boundary, once it has passed — is ever returned, so the job
// naturally behaves latest-only: a day missed to downtime is simply skipped,
// which is fine because the digest is derived from live inbox state over a
// rolling 7-day window, not from incremental per-day data.
//
// Delivery is NOT retried (MaxAttempts 1, no backoff): emails are not
// idempotent per recipient, so a retry after a partial send would duplicate
// the digest for everyone already delivered. A lost day is benign — the next
// day's digest still covers those unread items. Per-recipient send failures
// are logged and counted, never failing the whole execution.
func InboxEmailDigestJob(queries *db.Queries, sender InboxDigestSender) JobSpec {
	return JobSpec{
		Name:            JobNameInboxEmailDigest,
		MaxPlansPerTick: 1,
		PlansForScope:   inboxDigestPlans,
		// Generous timeouts: sends are sequential over SMTP; the heartbeat
		// between recipients keeps the lease fresh for large recipient sets.
		RunTimeout:        10 * time.Minute,
		StaleTimeout:      15 * time.Minute,
		HeartbeatInterval: time.Minute,
		AllowStaleReentry: false,
		MaxAttempts:       1,
		Scopes:            StaticScopes(ScopeGlobal),
		Handler:           makeInboxDigestHandler(queries, sender),
	}
}

// inboxDigestBoundary returns today's 09:00 Asia/Shanghai as a canonical UTC
// time when `now` is at or past it, and the zero time when today's digest is
// still ahead. Pinned timezone, never time.Local, so behaviour is identical
// regardless of the host clock setting.
func inboxDigestBoundary(now time.Time) time.Time {
	loc, err := time.LoadLocation(inboxDigestTimezone)
	if err != nil {
		// Unreachable with embedded tzdata; UTC degrades the schedule by 8h
		// rather than panicking in the scheduler tick loop.
		loc = time.UTC
	}
	local := now.In(loc)
	boundary := time.Date(local.Year(), local.Month(), local.Day(), inboxDigestHour, 0, 0, 0, loc)
	if local.Before(boundary) {
		return time.Time{}
	}
	return boundary.UTC()
}

// inboxDigestPlans returns today's 09:00 Asia/Shanghai boundary once `now`
// has passed it. Older plan_times are never surfaced: a stored FAILED row
// from a previous day stays failed (no duplicate-prone late sends), and a
// stored row at or after today's boundary means today already ran.
func inboxDigestPlans(_ context.Context, _ Scope, now time.Time, latest LatestPlanInfo) ([]time.Time, error) {
	due := inboxDigestBoundary(now)
	if due.IsZero() {
		return nil, nil
	}
	if latest.Found && !latest.PlanTime.Before(due) {
		// Today's plan (or a newer one) is already stored: SUCCESS conflicts
		// in tryClaim anyway, and FAILED has no attempts left (MaxAttempts 1).
		return nil, nil
	}
	return []time.Time{due}, nil
}

// digestMuteKey identifies a (workspace, user) pair for the mute set.
func digestMuteKey(workspaceID, userID string) string {
	return workspaceID + "\x00" + userID
}

// loadDigestMuteSet returns the set of (workspace, user) pairs where the user
// muted the email channel ("email": "muted" in their notification
// preferences). Absent preferences mean enabled — same default as the
// per-item forwarder in cmd/server/notification_listeners.go.
func loadDigestMuteSet(ctx context.Context, queries *db.Queries, rows []db.ListUnreadInboxForDigestRow) map[string]bool {
	// Collect affected users per workspace so each workspace needs exactly
	// one batched preferences query. Keys stay pgtype.UUID (comparable) so
	// sqlc values never round-trip through strings.
	perWorkspace := map[pgtype.UUID]map[pgtype.UUID]bool{}
	for _, r := range rows {
		if perWorkspace[r.WorkspaceID] == nil {
			perWorkspace[r.WorkspaceID] = map[pgtype.UUID]bool{}
		}
		perWorkspace[r.WorkspaceID][r.RecipientID] = true
	}

	muted := map[string]bool{}
	for wsID, users := range perWorkspace {
		ids := make([]pgtype.UUID, 0, len(users))
		for id := range users {
			ids = append(ids, id)
		}
		prefs, err := queries.ListNotificationPreferencesByUsers(ctx, db.ListNotificationPreferencesByUsersParams{
			WorkspaceID: wsID,
			UserIds:     ids,
		})
		if err != nil {
			// Preference lookup failure must not silence anyone — treat as
			// all-enabled, same fallback as loadUserPrefs.
			slog.Error("inbox digest: failed to load notification preferences",
				"workspace_id", util.UUIDToString(wsID), "error", err)
			continue
		}
		for _, p := range prefs {
			var m map[string]string
			if err := json.Unmarshal(p.Preferences, &m); err != nil {
				continue
			}
			if m["email"] == "muted" {
				muted[digestMuteKey(util.UUIDToString(wsID), util.UUIDToString(p.UserID))] = true
			}
		}
	}
	return muted
}

// digestRecipient is one recipient's aggregated digest across workspaces.
type digestRecipient struct {
	userID string
	name   string
	email  string
	// sections sorted by newest item first; item lists sorted newest first.
	sections []service.InboxSummarySection
	total    int
}

// aggregateDigest groups digest rows into per-recipient inputs, dropping
// (workspace, user) pairs muted on the email channel and recipients without
// a usable email. Pure so the grouping/capping/ordering rules are testable
// without a database.
func aggregateDigest(rows []db.ListUnreadInboxForDigestRow, muted map[string]bool, appBase string) []digestRecipient {
	type sectionState struct {
		name     string
		inboxURL string
		items    []service.InboxSummaryItem
		newest   time.Time
	}
	type recipientState struct {
		name     string
		email    string
		sections map[string]*sectionState
		order    []string // workspace IDs in first-seen order
	}

	recips := map[string]*recipientState{}
	for _, r := range rows {
		userID := util.UUIDToString(r.RecipientID)
		wsID := util.UUIDToString(r.WorkspaceID)
		if muted[digestMuteKey(wsID, userID)] {
			continue
		}
		rs := recips[userID]
		if rs == nil {
			rs = &recipientState{name: r.RecipientName, email: strings.TrimSpace(r.RecipientEmail), sections: map[string]*sectionState{}}
			recips[userID] = rs
		}
		sec := rs.sections[wsID]
		if sec == nil {
			sec = &sectionState{
				name:     r.WorkspaceName,
				inboxURL: appBase + "/" + r.WorkspaceSlug + "/inbox",
			}
			rs.sections[wsID] = sec
			rs.order = append(rs.order, wsID)
		}
		body := ""
		if r.Body.Valid {
			body = r.Body.String
		}
		sec.items = append(sec.items, service.InboxSummaryItem{
			Type:      r.Type,
			Severity:  r.Severity,
			Title:     r.Title,
			Body:      body,
			CreatedAt: r.CreatedAt.Time,
		})
		if r.CreatedAt.Time.After(sec.newest) {
			sec.newest = r.CreatedAt.Time
		}
	}

	out := make([]digestRecipient, 0, len(recips))
	for userID, rs := range recips {
		if rs.email == "" {
			continue
		}
		dr := digestRecipient{userID: userID, name: rs.name, email: rs.email}
		for _, wsID := range rs.order {
			sec := rs.sections[wsID]
			sort.SliceStable(sec.items, func(i, j int) bool {
				if !sec.items[i].CreatedAt.Equal(sec.items[j].CreatedAt) {
					return sec.items[i].CreatedAt.After(sec.items[j].CreatedAt)
				}
				return sec.items[i].Title < sec.items[j].Title
			})
			overflow := 0
			items := sec.items
			if len(items) > inboxDigestMaxItemsPerWorkspace {
				overflow = len(items) - inboxDigestMaxItemsPerWorkspace
				items = items[:inboxDigestMaxItemsPerWorkspace]
			}
			if len(items) == 0 {
				continue
			}
			dr.sections = append(dr.sections, service.InboxSummarySection{
				WorkspaceName: sec.name,
				InboxURL:      sec.inboxURL,
				Items:         items,
				OverflowCount: overflow,
			})
			dr.total += len(items) + overflow
		}
		if dr.total == 0 {
			continue
		}
		// Sections newest-first so the CTA lands on the most current workspace.
		sort.SliceStable(dr.sections, func(i, j int) bool {
			iNew := dr.sections[i].Items[0].CreatedAt
			jNew := dr.sections[j].Items[0].CreatedAt
			if !iNew.Equal(jNew) {
				return iNew.After(jNew)
			}
			return dr.sections[i].WorkspaceName < dr.sections[j].WorkspaceName
		})
		out = append(out, dr)
	}
	// Deterministic send order.
	sort.Slice(out, func(i, j int) bool { return out[i].email < out[j].email })
	return out
}

// makeInboxDigestHandler queries the digest window once, aggregates per
// recipient, and sends one summary email per recipient.
func makeInboxDigestHandler(queries *db.Queries, sender InboxDigestSender) Handler {
	return func(ctx context.Context, in HandlerInput) (HandlerResult, error) {
		// Window anchored to the plan time, not wall-clock now, so a late
		// run after downtime covers the same 7 days it was planned for.
		since := in.PlanTime.Add(-inboxDigestWindow)
		rows, err := queries.ListUnreadInboxForDigest(ctx, pgtype.Timestamptz{Time: since, Valid: true})
		if err != nil {
			return HandlerResult{}, fmt.Errorf("inbox digest: query unread window: %w", err)
		}
		if len(rows) == 0 {
			slog.Info("inbox digest: no unread notifications in window, nothing sent")
			return HandlerResult{RowsAffected: 0, Result: map[string]any{
				"recipients": 0, "sent": 0, "send_failed": 0, "items": 0,
			}}, nil
		}

		muted := loadDigestMuteSet(ctx, queries, rows)

		appBase := strings.TrimSpace(os.Getenv("FRONTEND_ORIGIN"))
		if appBase == "" {
			appBase = "http://10.35.178.181:13000"
		}
		recipients := aggregateDigest(rows, muted, appBase)

		sent, sendFailed, items := 0, 0, 0
		for _, r := range recipients {
			input := service.InboxSummaryEmailInput{
				RecipientName: r.name,
				GeneratedAt:   in.PlanTime,
				Sections:      r.sections,
			}
			if err := sender.SendInboxSummaryEmail(r.email, input); err != nil {
				sendFailed++
				slog.Error("inbox digest: send failed", "to", r.email, "error", err)
			} else {
				sent++
			}
			items += r.total
			// Renew the lease between recipients so a large deployment with
			// slow SMTP cannot run into StaleTimeout.
			if in.Heartbeat != nil {
				_ = in.Heartbeat(ctx)
			}
		}

		slog.Info("inbox digest: run complete",
			"rows", len(rows), "recipients", len(recipients),
			"sent", sent, "send_failed", sendFailed, "items", items)
		result := HandlerResult{
			RowsAffected: int64(items),
			Result: map[string]any{
				"rows": len(rows), "recipients": len(recipients),
				"sent": sent, "send_failed": sendFailed, "items": items,
			},
		}
		if sendFailed > 0 && sent == 0 {
			// Every send failed (e.g. SMTP relay outage): mark the
			// sys_cron_executions row FAILED so the audit trail flags a
			// systemic problem instead of reading as an unremarkable
			// SUCCESS. This does not enable a retry — MaxAttempts=1 blocks
			// that regardless of terminal status — it only makes the outage
			// visible to whoever reviews scheduler failures. Partial
			// failures (some sent, some not) stay SUCCESS: per-recipient
			// errors are already logged and counted in Result, and a mixed
			// day is not the systemic-outage signal this exists to surface.
			return result, fmt.Errorf("inbox digest: all %d sends failed", len(recipients))
		}
		return result, nil
	}
}
