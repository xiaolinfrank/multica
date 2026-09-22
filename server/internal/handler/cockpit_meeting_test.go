package handler

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// ---------------------------------------------------------------------------
// Pure helpers — no database
// ---------------------------------------------------------------------------

func TestCockpitMeetingFolderNameSanitizing(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"a separator cannot open a second folder", "复星/明略沟通会", "复星-明略沟通会"},
		{"a backslash is a separator too", `复星\明略沟通会`, "复星-明略沟通会"},
		{"a colon breaks SMB shares", "10:00 周会", "10-00 周会"},
		{"a NUL terminates the name on disk", "周会\x00纪要", "周会-纪要"},
		{"control characters become one space", "周会\n\t纪要", "周会 纪要"},
		{"runs of whitespace collapse", "周会    纪要", "周会 纪要"},
		{"a leading dot would hide the folder", ".周会", "周会"},
		{"a trailing dot is dropped by SMB clients", "周会.", "周会"},
		{"surrounding spaces go with it", "  周会  ", "周会"},
		{"a parent reference collapses", "a..b", "a.b"},
		{"so does a longer run of dots", "a....b", "a.b"},
		{"a name that is only dots has nothing left", "...", ""},
		{"empty in, empty out", "", ""},
		{"whitespace only", "   ", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := sanitizeMeetingFolderName(tc.in); got != tc.want {
				t.Errorf("sanitizeMeetingFolderName(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// The bound is counted in bytes because SMB and APFS count components in
// bytes, but a name cut mid-character is a name no share will match again.
func TestCockpitMeetingFolderNameTruncatesOnRuneBoundaries(t *testing.T) {
	long := strings.Repeat("会", 200) // 600 bytes
	got := sanitizeMeetingFolderName(long)

	if len(got) > meetingFolderNameMaxBytes {
		t.Errorf("len = %d bytes, want at most %d", len(got), meetingFolderNameMaxBytes)
	}
	if !utf8.ValidString(got) {
		t.Errorf("truncation split a rune: %q", got)
	}
	if got != strings.Repeat("会", meetingFolderNameMaxBytes/3) {
		t.Errorf("kept %d runes, want the first %d", utf8.RuneCountInString(got), meetingFolderNameMaxBytes/3)
	}

	// A mixed-width name must not be cut mid-rune either: the last kept rune
	// is what a naive byte slice would have split.
	mixed := strings.Repeat("ab会", 100)
	if got := sanitizeMeetingFolderName(mixed); !utf8.ValidString(got) || len(got) > meetingFolderNameMaxBytes {
		t.Errorf("mixed-width truncation = %q (%d bytes, valid=%v)", got, len(got), utf8.ValidString(got))
	}
}

// The programme writes the module title with a space and the folder without
// one. Treating those as different names is what creates the second,
// near-identical folder beside the real one.
func TestCockpitMeetingDirMatchIgnoresSpacing(t *testing.T) {
	if got, want := normalizeDirMatch("06.06 多方协同与会议"), normalizeDirMatch("06.06多方协同与会议"); got != want {
		t.Errorf("the spaced and unspaced module folder do not match: %q vs %q", got, want)
	}
	cases := []struct{ in, want string }{
		{"06.06 多方协同与会议", "06.06多方协同与会议"},
		{"06.06多方协同与会议", "06.06多方协同与会议"},
		{" 06.06\t多方协同\n与会议 ", "06.06多方协同与会议"},
		{"06.06　多方协同与会议", "06.06多方协同与会议"}, // ideographic space
		{"", ""},
	}
	for _, tc := range cases {
		if got := normalizeDirMatch(tc.in); got != tc.want {
			t.Errorf("normalizeDirMatch(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestCockpitMeetingDirCreation(t *testing.T) {
	t.Run("creates the leaf and is re-runnable", func(t *testing.T) {
		root := t.TempDir()

		first, err := createMeetingDir(root, "20260921-01 复星/明略对接会")
		if err != nil {
			t.Fatalf("createMeetingDir: %v", err)
		}
		want := filepath.Join(root, "20260921-01 复星-明略对接会")
		if first != want {
			t.Fatalf("created %q, want %q", first, want)
		}
		if info, err := os.Stat(first); err != nil || !info.IsDir() {
			t.Fatalf("folder was not created: stat %v", err)
		}

		// Provisioning is retried when the task half failed; an existing
		// folder is the normal case, not a conflict.
		second, err := createMeetingDir(root, "20260921-01 复星/明略对接会")
		if err != nil {
			t.Fatalf("second run: %v", err)
		}
		if second != first {
			t.Errorf("second run = %q, want the same folder %q", second, first)
		}
	})

	t.Run("refuses a name with nothing left of it", func(t *testing.T) {
		root := t.TempDir()
		if _, err := createMeetingDir(root, ".."); err == nil {
			t.Fatal("a parent reference was accepted as a folder name")
		}
		if entries, _ := os.ReadDir(root); len(entries) != 0 {
			t.Errorf("the refused name still created %d entries", len(entries))
		}
	})

	t.Run("a name full of separators stays inside its root", func(t *testing.T) {
		root := t.TempDir()
		for _, name := range []string{"../../escape", "/etc/passwd", `..\..\escape`} {
			got, err := createMeetingDir(root, name)
			if err != nil {
				continue // refusing outright is also a correct answer
			}
			if got != root && !strings.HasPrefix(got, root+string(os.PathSeparator)) {
				t.Errorf("createMeetingDir(root, %q) = %q, which is outside %q", name, got, root)
			}
			if strings.Contains(strings.TrimPrefix(got, root+string(os.PathSeparator)), string(os.PathSeparator)) {
				t.Errorf("createMeetingDir(root, %q) = %q, want a single component under the root", name, got)
			}
		}
	})

	// The unmounted-share guard. MkdirAll against an unmounted /Volumes path
	// silently builds the mount point as local directories, and everything
	// written into it disappears the next time the share mounts over it. Only
	// the leaf may ever be created.
	t.Run("refuses a root that is not there instead of building the chain", func(t *testing.T) {
		parent := t.TempDir()
		missing := filepath.Join(parent, "人机协作空间", "06项目管理与规划")

		got, err := createMeetingDir(missing, "20260921-01 周例会")
		if err == nil {
			t.Fatalf("an unmounted root was accepted and created %q", got)
		}
		if !strings.Contains(err.Error(), "unavailable") {
			t.Errorf("error = %q, want it to name the unavailable root", err)
		}
		if _, statErr := os.Stat(missing); !os.IsNotExist(statErr) {
			t.Fatalf("the missing root was created anyway: stat %v", statErr)
		}
		if _, statErr := os.Stat(filepath.Join(parent, "人机协作空间")); !os.IsNotExist(statErr) {
			t.Fatal("the mount point above the root was created as a local directory")
		}
	})

	t.Run("refuses a relative root", func(t *testing.T) {
		if _, err := createMeetingDir("relative/share/meetings", "周例会"); err == nil {
			t.Fatal("a relative root was accepted")
		}
	})
}

// clockAt builds the stored wall-clock value for "HH:MM".
func clockAt(hour, minute int) pgtype.Time {
	return pgtype.Time{
		Microseconds: int64(hour)*3600_000_000 + int64(minute)*60_000_000,
		Valid:        true,
	}
}

// The generated meeting name already opens with the meeting's number, so the
// folder must not carry it twice — the form promises one path and the server
// has to create that one.
func TestCockpitMeetingFolderNameDoesNotDoubleTheCode(t *testing.T) {
	for _, tc := range []struct {
		name, code, title, want string
	}{
		{"generated name already carries the number", "20260921-01", "20260921-01 复星医药×华大基因", "20260921-01 复星医药×华大基因"},
		{"a name someone typed gets the number", "20260921-01", "临时碰头", "20260921-01 临时碰头"},
		{"the number alone", "20260921-01", "", "20260921-01"},
		{"the name alone", "", "临时碰头", "临时碰头"},
		{"the number is the whole name", "20260921-01", "20260921-01", "20260921-01"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := meetingFolderName(db.CockpitMeeting{Code: tc.code, Title: tc.title})
			if got != tc.want {
				t.Errorf("meetingFolderName(%q, %q) = %q, want %q", tc.code, tc.title, got, tc.want)
			}
		})
	}
}

func TestNextMeetingCode(t *testing.T) {
	day := func(s string) time.Time {
		d, err := time.Parse("2006-01-02", s)
		if err != nil {
			t.Fatalf("setup: %v", err)
		}
		return d
	}
	codes := func(list ...string) []db.CockpitMeeting {
		rows := make([]db.CockpitMeeting, 0, len(list))
		for _, c := range list {
			rows = append(rows, db.CockpitMeeting{Code: c})
		}
		return rows
	}

	cases := []struct {
		name     string
		existing []db.CockpitMeeting
		day      string
		want     string
	}{
		{"an empty register opens the day", nil, "2026-09-21", "20260921-01"},
		{"the day continues where it stopped", codes("20260921-01", "20260921-02"), "2026-09-21", "20260921-03"},
		{"a gap is not backfilled", codes("20260921-01", "20260921-03"), "2026-09-21", "20260921-04"},
		{"another day does not count", codes("20260921-01", "20260921-02"), "2026-09-22", "20260922-01"},
		{"an unnumbered row does not count", codes("", "  "), "2026-09-21", "20260921-01"},
		{"a code of another shape is left alone", codes("周会", "20260921"), "2026-09-21", "20260921-01"},
		{"one digit is not the register's shape", codes("20260921-7"), "2026-09-21", "20260921-01"},
		{"surrounding space is still the day's number", codes(" 20260921-04 "), "2026-09-21", "20260921-05"},
		{"past ninety-nine keeps counting", codes("20260921-99"), "2026-09-21", "20260921-100"},
		{"the highest wins, not the last", codes("20260921-05", "20260921-02"), "2026-09-21", "20260921-06"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := nextMeetingCode(tc.existing, day(tc.day)); got != tc.want {
				t.Errorf("nextMeetingCode() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestCockpitMeetingSpan(t *testing.T) {
	cases := []struct {
		name    string
		meeting db.CockpitMeeting
		want    string
	}{
		{
			"structured start and end",
			db.CockpitMeeting{StartTime: clockAt(9, 30), EndTime: clockAt(11, 0)},
			"09:30–11:00",
		},
		{
			"structured times win over the free text they replaced",
			db.CockpitMeeting{StartTime: clockAt(9, 30), EndTime: clockAt(11, 0), TimeRange: "上午"},
			"09:30–11:00",
		},
		{
			"a start with no end",
			db.CockpitMeeting{StartTime: clockAt(14, 5), TimeRange: "下午"},
			"14:05",
		},
		{
			"free text is the fallback for rows written before the columns existed",
			db.CockpitMeeting{TimeRange: "  10:00-11:00  "},
			"10:00-11:00",
		},
		{
			// An end with no start is not a span, so the row falls back to
			// whatever text it carries.
			"an end with no start falls back too",
			db.CockpitMeeting{EndTime: clockAt(11, 0), TimeRange: "上午"},
			"上午",
		},
		{"nothing at all", db.CockpitMeeting{}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := meetingSpan(tc.meeting); got != tc.want {
				t.Errorf("meetingSpan = %q, want %q", got, tc.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Database-backed handler tests
// ---------------------------------------------------------------------------

// cockpitMeetingFixture extends cockpitFixture with the two link tables the
// meeting register added. cockpitFixture predates them, so a meeting test that
// left link rows behind would leak into later runs of the suite.
func cockpitMeetingFixture(t *testing.T, name string) string {
	t.Helper()
	wsID := cockpitFixture(t, name)
	// Registered after cockpitFixture's own cleanup, so these run first: the
	// link rows go before the meetings and nodes they point at.
	dbfx.Cleanup(t, "DELETE FROM cockpit_meeting_issue WHERE workspace_id = $1", wsID)
	dbfx.Cleanup(t, "DELETE FROM cockpit_meeting_node WHERE workspace_id = $1", wsID)
	return wsID
}

func createMeeting(t *testing.T, wsID string, body map[string]any) CockpitMeetingResponse {
	t.Helper()
	var meeting CockpitMeetingResponse
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitMeeting),
		cockpitRequest(http.MethodPost, "/api/cockpit/meetings", wsID, body)).
		Want(http.StatusCreated).
		JSON(&meeting)
	return meeting
}

func patchMeeting(t *testing.T, wsID, meetingID string, body map[string]any) CockpitMeetingResponse {
	t.Helper()
	var meeting CockpitMeetingResponse
	testutil.Call(t, cockpitHandler(testHandler.UpdateCockpitMeeting),
		testutil.WithURLParams(
			cockpitRequest(http.MethodPatch, "/api/cockpit/meetings/"+meetingID, wsID, body),
			"meetingId", meetingID,
		)).
		Want(http.StatusOK).
		JSON(&meeting)
	return meeting
}

type meetingLinksResponse struct {
	MeetingID string                        `json:"meeting_id"`
	Links     []CockpitMeetingIssueResponse `json:"links"`
}

type meetingNodeLinksResponse struct {
	MeetingID string                       `json:"meeting_id"`
	Links     []CockpitMeetingNodeResponse `json:"links"`
}

func setMeetingIssues(t *testing.T, wsID, meetingID string, body map[string]any) *testutil.Response {
	t.Helper()
	return testutil.Call(t, cockpitHandler(testHandler.SetCockpitMeetingIssues),
		testutil.WithURLParams(
			cockpitRequest(http.MethodPut, "/api/cockpit/meetings/"+meetingID+"/issues", wsID, body),
			"meetingId", meetingID,
		))
}

func setMeetingNodes(t *testing.T, wsID, meetingID string, body map[string]any) *testutil.Response {
	t.Helper()
	return testutil.Call(t, cockpitHandler(testHandler.SetCockpitMeetingNodes),
		testutil.WithURLParams(
			cockpitRequest(http.MethodPut, "/api/cockpit/meetings/"+meetingID+"/nodes", wsID, body),
			"meetingId", meetingID,
		))
}

func patchCockpit(t *testing.T, wsID string, body map[string]any) *testutil.Response {
	t.Helper()
	return testutil.Call(t, cockpitHandler(testHandler.UpdateCockpit),
		cockpitRequest(http.MethodPatch, "/api/cockpit", wsID, body))
}

// The register grew from a four-column meeting log. Everything a meeting is
// now filed with has to survive the round trip, or the form silently drops
// what someone typed.
func TestCockpitMeetingCreateRoundTripsTheNewFields(t *testing.T) {
	wsID := cockpitMeetingFixture(t, "Cockpit meeting fields")

	nasDir := "/Volumes/人机协作空间/06项目管理与规划/06.06多方协同与会议/20260921-01 复星-明略对接会"
	meeting := createMeeting(t, wsID, map[string]any{
		"meet_date":  "2026-09-21",
		"start_time": "09:30",
		"end_time":   "11:00",
		"time_range": "上午",
		"title":      "复星明略数据治理对接会",
		"code":       "20260921-01",
		"kind":       "对接会",
		"status":     "已排期",
		"parties":    "复星医药 / 明略科技",
		"organizer":  "李青娇",
		"location":   "上海复星大厦 18F 会议室",
		"attendees":  "李青娇、杨涛、朱艳林",
		"meet_no":    "876 543 210",
		"link":       "https://meeting.example.com/876543210",
		"note":       "1. 数据口径对齐\n2. 交付节奏",
		"minutes":    "双方确认口径以 v3 为准",
		"decisions":  "10 月 8 日前完成字段映射",
		"actions":    "杨涛出映射表；朱艳林准备样例数据",
		"nas_dir":    nasDir,
	})

	fields := []struct{ name, got, want string }{
		{"title", meeting.Title, "复星明略数据治理对接会"},
		{"code", meeting.Code, "20260921-01"},
		{"kind", meeting.Kind, "对接会"},
		{"status", meeting.Status, "已排期"},
		{"parties", meeting.Parties, "复星医药 / 明略科技"},
		{"organizer", meeting.Organizer, "李青娇"},
		{"location", meeting.Location, "上海复星大厦 18F 会议室"},
		{"attendees", meeting.Attendees, "李青娇、杨涛、朱艳林"},
		{"meet_no", meeting.MeetNo, "876 543 210"},
		{"link", meeting.Link, "https://meeting.example.com/876543210"},
		{"minutes", meeting.Minutes, "双方确认口径以 v3 为准"},
		{"decisions", meeting.Decisions, "10 月 8 日前完成字段映射"},
		{"actions", meeting.Actions, "杨涛出映射表；朱艳林准备样例数据"},
		{"time_range", meeting.TimeRange, "上午"},
		{"nas_dir", meeting.NasDir, nasDir},
	}
	for _, f := range fields {
		if f.got != f.want {
			t.Errorf("%s = %q, want %q", f.name, f.got, f.want)
		}
	}
	if meeting.MeetDate == nil || *meeting.MeetDate != "2026-09-21" {
		t.Errorf("meet_date = %v, want 2026-09-21", meeting.MeetDate)
	}
	// Rendered to the minute: a meeting is scheduled to the minute and ":00"
	// on every row is noise.
	if meeting.StartTime == nil || *meeting.StartTime != "09:30" {
		t.Errorf("start_time = %v, want 09:30", meeting.StartTime)
	}
	if meeting.EndTime == nil || *meeting.EndTime != "11:00" {
		t.Errorf("end_time = %v, want 11:00", meeting.EndTime)
	}

	board := getBoard(t, wsID)
	if len(board.Meetings) != 1 {
		t.Fatalf("board meetings = %d, want 1", len(board.Meetings))
	}
	// Compared as JSON: the response carries pointers, and the wire form is
	// what the register actually renders from.
	fromBoard, _ := json.Marshal(board.Meetings[0])
	fromCreate, _ := json.Marshal(meeting)
	if string(fromBoard) != string(fromCreate) {
		t.Errorf("the board read differs from the create response:\n got %s\nwant %s", fromBoard, fromCreate)
	}
}

// The register numbers by day, and the form is not the only way in: the
// overview's quick add files a row with a title and a date and nothing else,
// and a row with no number files its folder and its task without the prefix
// the rest of the register carries.
func TestCockpitMeetingCreateNumbersTheDay(t *testing.T) {
	wsID := cockpitMeetingFixture(t, "Cockpit meeting numbering")

	first := createMeeting(t, wsID, map[string]any{"meet_date": "2026-09-21", "title": "新会议"})
	if first.Code != "20260921-01" {
		t.Errorf("code = %q, want the day's first number", first.Code)
	}
	second := createMeeting(t, wsID, map[string]any{"meet_date": "2026-09-21", "title": "内部周例会"})
	if second.Code != "20260921-02" {
		t.Errorf("code = %q, want the day's second number", second.Code)
	}
	// The next day opens its own count.
	next := createMeeting(t, wsID, map[string]any{"meet_date": "2026-09-22", "title": "周二例会"})
	if next.Code != "20260922-01" {
		t.Errorf("code = %q, want the next day's first number", next.Code)
	}

	// The form previews the number it is about to file, so a number that was
	// sent is the one that is kept.
	sent := createMeeting(t, wsID, map[string]any{
		"meet_date": "2026-09-21", "title": "赛陆孙博", "code": "20260921-40",
	})
	if sent.Code != "20260921-40" {
		t.Errorf("code = %q, want the number the caller sent", sent.Code)
	}
	after := createMeeting(t, wsID, map[string]any{"meet_date": "2026-09-21", "title": "明略王佼佼"})
	if after.Code != "20260921-41" {
		t.Errorf("code = %q, want the day to continue from the number that was sent", after.Code)
	}

	// A meeting nobody has dated yet has no day to be numbered into; it gets
	// its number when the date is filled in and the folder is filed.
	undated := createMeeting(t, wsID, map[string]any{"title": "待定"})
	if undated.Code != "" {
		t.Errorf("code = %q, want no number without a date", undated.Code)
	}
}

func TestCockpitMeetingRejectsBadInput(t *testing.T) {
	wsID := cockpitMeetingFixture(t, "Cockpit meeting validation")

	for _, body := range []map[string]any{
		{"title": "坏钟点", "start_time": "9:30 AM"},
		{"title": "坏钟点", "start_time": "25:00"},
		{"title": "坏钟点", "end_time": "11-00"},
		{"title": "坏日期", "meet_date": "21/09/2026"},
	} {
		testutil.Call(t, cockpitHandler(testHandler.CreateCockpitMeeting),
			cockpitRequest(http.MethodPost, "/api/cockpit/meetings", wsID, body)).
			Want(http.StatusBadRequest)
	}

	// A relative folder would resolve inside a task's private workdir, which
	// is the one place a meeting's material must not land.
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitMeeting),
		cockpitRequest(http.MethodPost, "/api/cockpit/meetings", wsID, map[string]any{
			"title": "坏目录", "nas_dir": "会议纪要/20260921",
		})).
		Want(http.StatusBadRequest)

	// The same validation guards an edit, not just the create form.
	meeting := createMeeting(t, wsID, map[string]any{"title": "好会议", "start_time": "09:30"})
	testutil.Call(t, cockpitHandler(testHandler.UpdateCockpitMeeting),
		testutil.WithURLParams(
			cockpitRequest(http.MethodPatch, "/api/cockpit/meetings/"+meeting.ID, wsID, map[string]any{
				"start_time": "下午三点",
			}),
			"meetingId", meeting.ID,
		)).
		Want(http.StatusBadRequest)
	if after := getBoard(t, wsID); len(after.Meetings) != 1 ||
		after.Meetings[0].StartTime == nil || *after.Meetings[0].StartTime != "09:30" {
		t.Errorf("a rejected edit changed the stored time: %+v", after.Meetings)
	}
}

// Three states, and they are genuinely different: an absent key leaves the
// column alone, an empty string clears it. A meeting whose time is withdrawn
// goes back to the all-day lane; an unrelated edit must not put it there.
func TestCockpitMeetingPatchIsThreeState(t *testing.T) {
	wsID := cockpitMeetingFixture(t, "Cockpit meeting patch")
	meeting := createMeeting(t, wsID, map[string]any{
		"title": "工作组周例会", "meet_date": "2026-09-21",
		"start_time": "09:30", "end_time": "11:00",
		"parties": "复星医药 / 明略科技", "status": "已排期",
	})

	afterUnrelated := patchMeeting(t, wsID, meeting.ID, map[string]any{"minutes": "已纪要"})
	if afterUnrelated.StartTime == nil || *afterUnrelated.StartTime != "09:30" {
		t.Errorf("an unrelated edit dropped start_time: %v", afterUnrelated.StartTime)
	}
	if afterUnrelated.EndTime == nil || *afterUnrelated.EndTime != "11:00" {
		t.Errorf("an unrelated edit dropped end_time: %v", afterUnrelated.EndTime)
	}
	if afterUnrelated.MeetDate == nil || *afterUnrelated.MeetDate != "2026-09-21" {
		t.Errorf("an unrelated edit dropped meet_date: %v", afterUnrelated.MeetDate)
	}
	if afterUnrelated.Parties != "复星医药 / 明略科技" || afterUnrelated.Status != "已排期" {
		t.Errorf("an unrelated edit dropped parties/status: %+v", afterUnrelated)
	}
	if afterUnrelated.Minutes != "已纪要" {
		t.Errorf("minutes = %q, want the value just written", afterUnrelated.Minutes)
	}

	cleared := patchMeeting(t, wsID, meeting.ID, map[string]any{"start_time": ""})
	if cleared.StartTime != nil {
		t.Errorf("start_time = %v, want nil after an empty string cleared it", cleared.StartTime)
	}
	if cleared.EndTime == nil || *cleared.EndTime != "11:00" {
		t.Errorf("clearing start_time also cleared end_time: %v", cleared.EndTime)
	}
}

// A meeting is carried out through issues, and the board's vocabulary for an
// issue is "TES-2", not a UUID.
func TestCockpitMeetingIssueLinks(t *testing.T) {
	wsID := cockpitMeetingFixture(t, "Cockpit meeting issues")
	first := dbfx.Issue(t, "会议纪要整理", testutil.Cols{"workspace_id": wsID, "status": "in_progress"})
	dbfx.Issue(t, "字段映射表", testutil.Cols{"workspace_id": wsID})
	meeting := createMeeting(t, wsID, map[string]any{"title": "复星明略对接会", "meet_date": "2026-09-21"})

	var linked meetingLinksResponse
	setMeetingIssues(t, wsID, meeting.ID, map[string]any{
		"issue_ids": []string{first, "TES-2"},
	}).Want(http.StatusOK).JSON(&linked)
	if len(linked.Links) != 2 {
		t.Fatalf("links = %d, want 2: %+v", len(linked.Links), linked.Links)
	}

	board := getBoard(t, wsID)
	if len(board.MeetingIssues) != 2 {
		t.Fatalf("board meeting_issues = %+v, want 2", board.MeetingIssues)
	}
	byID := map[string]CockpitMeetingIssueResponse{}
	for _, l := range board.MeetingIssues {
		if l.MeetingID != meeting.ID {
			t.Errorf("link %+v is filed under the wrong meeting, want %s", l, meeting.ID)
		}
		byID[l.IssueID] = l
	}
	// The board read resolves each link, so the register can render a row
	// without a second request per issue.
	if l := byID[first]; l.IssueIdentifier != "TES-1" || l.IssueTitle != "会议纪要整理" || l.IssueStatus != "in_progress" {
		t.Errorf("first link = %+v, want TES-1/会议纪要整理/in_progress", l)
	}
	if l, ok := byID[first]; !ok || l.IssueNumber != 1 {
		t.Errorf("first link issue_number = %d, want 1", l.IssueNumber)
	}

	// An unknown reference fails the whole request rather than linking half
	// of what the picker asked for.
	setMeetingIssues(t, wsID, meeting.ID, map[string]any{"issue_ids": []string{"TES-999"}}).
		Want(http.StatusBadRequest)

	testutil.Call(t, cockpitHandler(testHandler.DeleteCockpitMeetingIssue),
		testutil.WithURLParams(
			cockpitRequest(http.MethodDelete, "/api/cockpit/meetings/"+meeting.ID+"/issues/TES-1", wsID, nil),
			"meetingId", meeting.ID, "issueId", "TES-1",
		)).
		Want(http.StatusNoContent)

	after := getBoard(t, wsID)
	if len(after.MeetingIssues) != 1 || after.MeetingIssues[0].IssueIdentifier != "TES-2" {
		t.Errorf("after unlink meeting_issues = %+v, want only TES-2", after.MeetingIssues)
	}
}

// The gantt's L2/L3 rows are addressed by code on the board, in an import and
// in the picker; the link endpoint has to speak the same language.
func TestCockpitMeetingNodeLinksAcceptCodes(t *testing.T) {
	wsID := cockpitMeetingFixture(t, "Cockpit meeting nodes")
	parent := createNode(t, wsID, map[string]any{"code": "L2-06", "name": "项目管理与规划"})
	child := createNode(t, wsID, map[string]any{
		"code": "L3-06-06", "parent_id": parent.ID, "name": "多方协同与会议",
	})
	meeting := createMeeting(t, wsID, map[string]any{"title": "复星明略对接会"})

	var linked meetingNodeLinksResponse
	setMeetingNodes(t, wsID, meeting.ID, map[string]any{
		"node_ids": []string{"L3-06-06", parent.ID},
	}).Want(http.StatusOK).JSON(&linked)
	if len(linked.Links) != 2 {
		t.Fatalf("links = %d, want 2: %+v", len(linked.Links), linked.Links)
	}

	board := getBoard(t, wsID)
	got := map[string]bool{}
	for _, l := range board.MeetingNodes {
		if l.MeetingID != meeting.ID {
			t.Errorf("link %+v is filed under the wrong meeting, want %s", l, meeting.ID)
		}
		got[l.NodeID] = true
	}
	if !got[child.ID] {
		t.Errorf("the node addressed by its code did not resolve: meeting_nodes = %+v", board.MeetingNodes)
	}
	if !got[parent.ID] {
		t.Errorf("the node addressed by its UUID did not resolve: meeting_nodes = %+v", board.MeetingNodes)
	}

	setMeetingNodes(t, wsID, meeting.ID, map[string]any{"node_ids": []string{"L9-99"}}).
		Want(http.StatusBadRequest)

	testutil.Call(t, cockpitHandler(testHandler.DeleteCockpitMeetingNode),
		testutil.WithURLParams(
			cockpitRequest(http.MethodDelete, "/api/cockpit/meetings/"+meeting.ID+"/nodes/L3-06-06", wsID, nil),
			"meetingId", meeting.ID, "nodeId", "L3-06-06",
		)).
		Want(http.StatusNoContent)

	after := getBoard(t, wsID)
	if len(after.MeetingNodes) != 1 || after.MeetingNodes[0].NodeID != parent.ID {
		t.Errorf("after unlink meeting_nodes = %+v, want only the parent", after.MeetingNodes)
	}
}

// Nothing in the schema cascades (repository rule), so the handler owns the
// cleanup. The board read joins through cockpit_meeting and would hide an
// orphan row, so the rows are counted directly as well — a re-used meeting
// UUID would otherwise adopt another meeting's attachments.
func TestCockpitMeetingDeleteSweepsItsLinks(t *testing.T) {
	wsID := cockpitMeetingFixture(t, "Cockpit meeting delete")
	issue := dbfx.Issue(t, "会议纪要整理", testutil.Cols{"workspace_id": wsID})
	node := createNode(t, wsID, map[string]any{"code": "L3-06-06"})
	meeting := createMeeting(t, wsID, map[string]any{"title": "复星明略对接会"})
	keep := createMeeting(t, wsID, map[string]any{"title": "工作组周例会"})

	setMeetingIssues(t, wsID, meeting.ID, map[string]any{"issue_ids": []string{issue}}).Want(http.StatusOK)
	setMeetingNodes(t, wsID, meeting.ID, map[string]any{"node_ids": []string{node.ID}}).Want(http.StatusOK)
	setMeetingIssues(t, wsID, keep.ID, map[string]any{"issue_ids": []string{issue}}).Want(http.StatusOK)

	testutil.Call(t, cockpitHandler(testHandler.DeleteCockpitMeeting),
		testutil.WithURLParams(
			cockpitRequest(http.MethodDelete, "/api/cockpit/meetings/"+meeting.ID, wsID, nil),
			"meetingId", meeting.ID,
		)).
		Want(http.StatusNoContent)

	board := getBoard(t, wsID)
	for _, l := range board.MeetingIssues {
		if l.MeetingID == meeting.ID {
			t.Errorf("the board still carries an issue link for the deleted meeting: %+v", l)
		}
	}
	if len(board.MeetingNodes) != 0 {
		t.Errorf("the board still carries work-item links for the deleted meeting: %+v", board.MeetingNodes)
	}
	if n := dbfx.Count(t, "SELECT count(*) FROM cockpit_meeting_issue WHERE meeting_id = $1", meeting.ID); n != 0 {
		t.Errorf("cockpit_meeting_issue rows = %d, want 0 (the board read's join would hide them)", n)
	}
	if n := dbfx.Count(t, "SELECT count(*) FROM cockpit_meeting_node WHERE meeting_id = $1", meeting.ID); n != 0 {
		t.Errorf("cockpit_meeting_node rows = %d, want 0 (the board read's join would hide them)", n)
	}

	// The sweep is the deleted meeting's own, not the board's.
	if len(board.MeetingIssues) != 1 || board.MeetingIssues[0].MeetingID != keep.ID {
		t.Errorf("the surviving meeting lost its links: %+v", board.MeetingIssues)
	}
}

func TestCockpitMeetingNodeLinksDieWithTheirNode(t *testing.T) {
	wsID := cockpitMeetingFixture(t, "Cockpit meeting node cleanup")
	node := createNode(t, wsID, map[string]any{"code": "L3-06-06"})
	meeting := createMeeting(t, wsID, map[string]any{"title": "复星明略对接会"})
	setMeetingNodes(t, wsID, meeting.ID, map[string]any{"node_ids": []string{node.ID}}).Want(http.StatusOK)

	testutil.Call(t, cockpitHandler(testHandler.DeleteCockpitNode),
		testutil.WithURLParams(
			cockpitRequest(http.MethodDelete, "/api/cockpit/nodes/"+node.ID, wsID, nil),
			"id", node.ID,
		)).
		Want(http.StatusNoContent)

	if n := dbfx.Count(t, "SELECT count(*) FROM cockpit_meeting_node WHERE node_id = $1", node.ID); n != 0 {
		t.Errorf("cockpit_meeting_node rows = %d, want 0 after the work item was deleted", n)
	}
	if board := getBoard(t, wsID); len(board.MeetingNodes) != 0 {
		t.Errorf("board meeting_nodes = %+v, want empty", board.MeetingNodes)
	}
}

// A destination that names nothing, or a module belonging to another project,
// would only fail later at the moment someone files a meeting — with a board
// setting they cannot see as the cause.
func TestCockpitMeetingDestinationIsValidatedOnTheBoard(t *testing.T) {
	wsID := cockpitMeetingFixture(t, "Cockpit meeting destination")
	project := dbfx.Project(t, "06项目管理与规划", testutil.Cols{
		"workspace_id": wsID,
		"collab_path":  "/Volumes/人机协作空间/06项目管理与规划",
	})
	module := dbfx.Module(t, project, "06.06 多方协同与会议", testutil.Cols{"workspace_id": wsID})
	otherProject := dbfx.Project(t, "07交付", testutil.Cols{"workspace_id": wsID})
	otherModule := dbfx.Module(t, otherProject, "07.01 交付验收", testutil.Cols{"workspace_id": wsID})

	patchCockpit(t, wsID, map[string]any{
		"meeting_project_id": project,
		"meeting_module_id":  otherModule,
	}).Want(http.StatusBadRequest)

	patchCockpit(t, wsID, map[string]any{"meeting_project_id": "not-a-uuid"}).
		Want(http.StatusBadRequest)
	patchCockpit(t, wsID, map[string]any{"meeting_dir": "会议纪要"}).
		Want(http.StatusBadRequest)

	var stored CockpitResponse
	patchCockpit(t, wsID, map[string]any{
		"meeting_project_id": project,
		"meeting_module_id":  module,
		"meeting_dir":        "/Volumes/人机协作空间/06项目管理与规划/06.06多方协同与会议",
	}).Want(http.StatusOK).JSON(&stored)

	board := getBoard(t, wsID)
	if board.Cockpit.MeetingProjectID == nil || *board.Cockpit.MeetingProjectID != project {
		t.Errorf("board meeting_project_id = %v, want %s", board.Cockpit.MeetingProjectID, project)
	}
	if board.Cockpit.MeetingModuleID == nil || *board.Cockpit.MeetingModuleID != module {
		t.Errorf("board meeting_module_id = %v, want %s", board.Cockpit.MeetingModuleID, module)
	}
	if board.Cockpit.MeetingDir != "/Volumes/人机协作空间/06项目管理与规划/06.06多方协同与会议" {
		t.Errorf("board meeting_dir = %q", board.Cockpit.MeetingDir)
	}

	// A module of another project is still refused when only the module is
	// being changed: the pair is checked against whatever project the board
	// settles on, stored or incoming.
	patchCockpit(t, wsID, map[string]any{"meeting_module_id": otherModule}).
		Want(http.StatusBadRequest)

	// An empty string clears, like every other optional field here.
	var cleared CockpitResponse
	patchCockpit(t, wsID, map[string]any{"meeting_project_id": "", "meeting_module_id": ""}).
		Want(http.StatusOK).JSON(&cleared)
	if cleared.MeetingProjectID != nil || cleared.MeetingModuleID != nil {
		t.Errorf("destination after clearing = %v/%v, want both nil", cleared.MeetingProjectID, cleared.MeetingModuleID)
	}
}

// The create form shows where a meeting would be filed before anything is
// created. The module's folder is found by name, and the name on disk is
// written without the space the platform title carries.
func TestCockpitMeetingDestinationPreview(t *testing.T) {
	wsID := cockpitMeetingFixture(t, "Cockpit meeting destination preview")
	root := t.TempDir()
	moduleDir := filepath.Join(root, "06.06多方协同与会议")
	if err := os.Mkdir(moduleDir, 0o755); err != nil {
		t.Fatalf("setup: create the module folder: %v", err)
	}
	project := dbfx.Project(t, "06项目管理与规划", testutil.Cols{
		"workspace_id": wsID, "collab_path": root,
	})
	module := dbfx.Module(t, project, "06.06 多方协同与会议", testutil.Cols{"workspace_id": wsID})

	var dest CockpitMeetingDestinationResponse
	testutil.Call(t, cockpitHandler(testHandler.GetCockpitMeetingDestination),
		cockpitRequest(http.MethodGet,
			"/api/cockpit/meetings/destination?project_id="+project+"&module_id="+module, wsID, nil)).
		Want(http.StatusOK).
		JSON(&dest)

	if dest.Error != "" {
		t.Fatalf("destination error = %q, want none", dest.Error)
	}
	if dest.BaseDir != moduleDir {
		t.Errorf("base_dir = %q, want the existing folder %q (matched ignoring the space)", dest.BaseDir, moduleDir)
	}
	if !dest.Derived {
		t.Error("derived = false, want true: nothing has been confirmed on this board yet")
	}
	if !dest.BaseDirExists {
		t.Error("base_dir_exists = false, want true: the folder was created in setup")
	}
	if dest.ProjectTitle != "06项目管理与规划" || dest.ModuleTitle != "06.06 多方协同与会议" {
		t.Errorf("titles = %q/%q", dest.ProjectTitle, dest.ModuleTitle)
	}
	if dest.CollabPath != root {
		t.Errorf("collab_path = %q, want %q", dest.CollabPath, root)
	}

	// A project with no collaboration space cannot answer where a folder
	// goes, and says so rather than guessing.
	bare := dbfx.Project(t, "无协作空间", testutil.Cols{"workspace_id": wsID})
	var noSpace CockpitMeetingDestinationResponse
	testutil.Call(t, cockpitHandler(testHandler.GetCockpitMeetingDestination),
		cockpitRequest(http.MethodGet, "/api/cockpit/meetings/destination?project_id="+bare, wsID, nil)).
		Want(http.StatusOK).
		JSON(&noSpace)
	if noSpace.Error == "" || noSpace.BaseDir != "" {
		t.Errorf("a project with no collaboration space answered %+v", noSpace)
	}
}

// Provisioning is the second half of filing a meeting: the task it is carried
// out through and the folder its material goes in. Both are reported per part
// so an unmounted share never costs someone the record of a meeting.
func TestCockpitMeetingProvisionOpensTaskAndFolder(t *testing.T) {
	wsID := cockpitMeetingFixture(t, "Cockpit meeting provision")
	root := t.TempDir()
	moduleDir := filepath.Join(root, "06.06多方协同与会议")
	if err := os.Mkdir(moduleDir, 0o755); err != nil {
		t.Fatalf("setup: create the module folder: %v", err)
	}
	project := dbfx.Project(t, "06项目管理与规划", testutil.Cols{
		"workspace_id": wsID, "collab_path": root,
	})
	module := dbfx.Module(t, project, "06.06 多方协同与会议", testutil.Cols{"workspace_id": wsID})

	// The task is opened through IssueService, which dbfx did not create, so
	// it is removed here along with what filing an issue writes beside it.
	dbfx.Cleanup(t, "DELETE FROM issue WHERE workspace_id = $1", wsID)
	dbfx.Cleanup(t, "DELETE FROM activity_log WHERE issue_id IN (SELECT id FROM issue WHERE workspace_id = $1)", wsID)
	dbfx.Cleanup(t, "DELETE FROM inbox_item WHERE issue_id IN (SELECT id FROM issue WHERE workspace_id = $1)", wsID)
	dbfx.Cleanup(t, "DELETE FROM issue_subscriber WHERE issue_id IN (SELECT id FROM issue WHERE workspace_id = $1)", wsID)

	meeting := createMeeting(t, wsID, map[string]any{
		"title": "复星明略数据治理对接会", "code": "20260921-01",
		"meet_date": "2026-09-21", "start_time": "09:30", "end_time": "11:00",
		"parties": "复星医药 / 明略科技",
	})

	var resp CockpitMeetingProvisionResponse
	testutil.Call(t, cockpitHandler(testHandler.ProvisionCockpitMeeting),
		testutil.WithURLParams(
			cockpitRequest(http.MethodPost, "/api/cockpit/meetings/"+meeting.ID+"/provision", wsID, map[string]any{
				"project_id": project, "module_id": module,
			}),
			"meetingId", meeting.ID,
		)).
		Want(http.StatusOK).
		JSON(&resp)

	if resp.DirError != "" {
		t.Errorf("dir_error = %q, want none", resp.DirError)
	}
	wantDir := filepath.Join(moduleDir, "20260921-01 复星明略数据治理对接会")
	if resp.Dir != wantDir || !resp.DirCreated {
		t.Errorf("dir = %q created=%v, want %q created", resp.Dir, resp.DirCreated, wantDir)
	}
	if info, err := os.Stat(wantDir); err != nil || !info.IsDir() {
		t.Errorf("the meeting folder was not created on disk: stat %v", err)
	}
	if resp.Meeting.NasDir != wantDir {
		t.Errorf("the meeting did not remember its folder: nas_dir = %q", resp.Meeting.NasDir)
	}

	if resp.TaskError != "" {
		t.Fatalf("task_error = %q, want none", resp.TaskError)
	}
	if resp.Task == nil {
		t.Fatal("no task was opened for the meeting")
	}
	if resp.Task.Role != "task" {
		t.Errorf("task link role = %q, want \"task\"", resp.Task.Role)
	}
	// The meeting's number leads its name: the task is read in an inbox,
	// away from the row it came from.
	if want := "20260921-01 复星明略数据治理对接会"; resp.Task.IssueTitle != want {
		t.Errorf("task title = %q, want %q", resp.Task.IssueTitle, want)
	}

	// The task is filed under the programme's meeting project and module, and
	// assigned to the member filing it — not to the workspace's fallback
	// agent, which would answer a diary entry by starting an agent run.
	var projectID, moduleID, assigneeType, assigneeID *string
	dbfx.QueryRow(t,
		"SELECT project_id::text, module_id::text, assignee_type, assignee_id::text FROM issue WHERE id = $1",
		resp.Task.IssueID).
		Scan(&projectID, &moduleID, &assigneeType, &assigneeID)
	if projectID == nil || *projectID != project {
		t.Errorf("task project_id = %v, want %s", projectID, project)
	}
	if moduleID == nil || *moduleID != module {
		t.Errorf("task module_id = %v, want %s", moduleID, module)
	}
	if assigneeType == nil || *assigneeType != "member" || assigneeID == nil || *assigneeID != testUserID {
		t.Errorf("task assignee = %v/%v, want member/%s", assigneeType, assigneeID, testUserID)
	}

	board := getBoard(t, wsID)
	if len(board.MeetingIssues) != 1 || board.MeetingIssues[0].IssueID != resp.Task.IssueID {
		t.Errorf("board meeting_issues = %+v, want the meeting's own task", board.MeetingIssues)
	}
	// The board remembers where meeting folders go — the parent, not the one
	// folder this meeting used.
	if board.Cockpit.MeetingDir != moduleDir {
		t.Errorf("board meeting_dir = %q, want the module folder %q", board.Cockpit.MeetingDir, moduleDir)
	}
}

// Attaching an issue to a meeting from either end re-sends the meeting's link
// set, and the meeting's own task is one of those links. The role belongs to
// the pair, not to the request — a picker has no way to send it — so a link
// that survives the write keeps it. Losing it would leave the meeting looking
// task-less and offer to open a second one.
func TestCockpitMeetingLinkKeepsTheTaskRole(t *testing.T) {
	f := newMeetingArchiveFixture(t, "Cockpit meeting link roles", true)
	patchCockpit(t, f.wsID, map[string]any{
		"meeting_project_id": f.project, "meeting_module_id": f.module, "meeting_node_id": f.node,
	}).Want(http.StatusOK)

	meeting := createMeeting(t, f.wsID, map[string]any{"meet_date": "2026-09-21", "title": "周例会"})
	opened := f.provision(t, meeting.ID, map[string]any{"create_task": true, "create_dir": false})
	if opened.Task == nil {
		t.Fatal("no task was opened for the meeting")
	}
	attached := dbfx.Issue(t, "手工关联的任务", testutil.Cols{"workspace_id": f.wsID})

	roleOf := func(links []CockpitMeetingIssueResponse, issueID string) string {
		t.Helper()
		for _, l := range links {
			if l.IssueID == issueID {
				return l.Role
			}
		}
		t.Fatalf("issue %s is not linked to the meeting: %+v", issueID, links)
		return ""
	}

	// The register's own picker: the whole set, re-sent with one appended.
	var replaced meetingLinksResponse
	setMeetingIssues(t, f.wsID, meeting.ID, map[string]any{
		"issue_ids": []string{opened.Task.IssueID, attached}, "replace": true,
	}).Want(http.StatusOK).JSON(&replaced)
	if got := roleOf(replaced.Links, opened.Task.IssueID); got != "task" {
		t.Errorf("the meeting's own task came back with role %q, want \"task\"", got)
	}
	if got := roleOf(replaced.Links, attached); got != "" {
		t.Errorf("the hand-attached issue came back with role %q, want none", got)
	}

	// The issue side sends only its own link, appended.
	third := dbfx.Issue(t, "从任务页关联", testutil.Cols{"workspace_id": f.wsID})
	var appended meetingLinksResponse
	setMeetingIssues(t, f.wsID, meeting.ID, map[string]any{"issue_ids": []string{third}}).
		Want(http.StatusOK).JSON(&appended)
	if len(appended.Links) != 3 {
		t.Fatalf("links after appending = %d, want 3: %+v", len(appended.Links), appended.Links)
	}
	if got := roleOf(appended.Links, opened.Task.IssueID); got != "task" {
		t.Errorf("appending demoted the meeting's task to role %q", got)
	}
}

// The snapshot payload IS the import document: anything the document does not
// carry is silently lost the moment someone restores a version. The meeting's
// new fields and its links are the regression that matters most here.
// A version restore must bring back WHICH issue was the meeting's own task,
// not just that an issue was linked. The role and the lead position are what
// tell the platform-opened task from an issue someone attached by hand, and a
// document that forgot them would quietly demote it on the way back.
func TestCockpitMeetingSnapshotRestoreKeepsTheMeetingTask(t *testing.T) {
	wsID := cockpitMeetingFixture(t, "Cockpit meeting task restore")
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "06.06多方协同与会议"), 0o755); err != nil {
		t.Fatalf("setup: create the module folder: %v", err)
	}
	project := dbfx.Project(t, "06项目管理与规划", testutil.Cols{
		"workspace_id": wsID, "collab_path": root,
	})
	module := dbfx.Module(t, project, "06.06 多方协同与会议", testutil.Cols{"workspace_id": wsID})
	dbfx.Cleanup(t, "DELETE FROM issue WHERE workspace_id = $1", wsID)
	dbfx.Cleanup(t, "DELETE FROM activity_log WHERE issue_id IN (SELECT id FROM issue WHERE workspace_id = $1)", wsID)
	dbfx.Cleanup(t, "DELETE FROM inbox_item WHERE issue_id IN (SELECT id FROM issue WHERE workspace_id = $1)", wsID)
	dbfx.Cleanup(t, "DELETE FROM issue_subscriber WHERE issue_id IN (SELECT id FROM issue WHERE workspace_id = $1)", wsID)

	meeting := createMeeting(t, wsID, map[string]any{
		"title": "复星明略数据治理对接会", "code": "20260921-01", "meet_date": "2026-09-21",
	})
	var provisioned CockpitMeetingProvisionResponse
	testutil.Call(t, cockpitHandler(testHandler.ProvisionCockpitMeeting),
		testutil.WithURLParams(
			cockpitRequest(http.MethodPost, "/api/cockpit/meetings/"+meeting.ID+"/provision", wsID, map[string]any{
				"project_id": project, "module_id": module, "create_dir": false,
			}),
			"meetingId", meeting.ID,
		)).
		Want(http.StatusOK).
		JSON(&provisioned)
	if provisioned.Task == nil {
		t.Fatalf("setup: no task was opened: %+v", provisioned)
	}
	// A second issue attached by hand, so the restore has to tell them apart
	// rather than getting the role right by having only one link.
	attached := dbfx.Issue(t, "字段映射表", testutil.Cols{"workspace_id": wsID})
	setMeetingIssues(t, wsID, meeting.ID, map[string]any{"issue_ids": []string{attached}}).Want(http.StatusOK)

	var frozen CockpitSnapshotResponse
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitSnapshot),
		cockpitRequest(http.MethodPost, "/api/cockpit/snapshots", wsID, map[string]any{"label": "会议任务后"})).
		Want(http.StatusCreated).
		JSON(&frozen)

	importBoard(t, wsID, importDoc("v2 board", "L1-99"))
	restoreSnapshot(t, wsID, frozen.ID).Want(http.StatusOK)

	board := getBoard(t, wsID)
	if len(board.MeetingIssues) != 2 {
		t.Fatalf("restored meeting_issues = %+v, want both links", board.MeetingIssues)
	}
	var task, plain *CockpitMeetingIssueResponse
	for i := range board.MeetingIssues {
		switch board.MeetingIssues[i].IssueID {
		case provisioned.Task.IssueID:
			task = &board.MeetingIssues[i]
		case attached:
			plain = &board.MeetingIssues[i]
		}
	}
	if task == nil || plain == nil {
		t.Fatalf("restored links = %+v, want one per issue", board.MeetingIssues)
	}
	if task.Role != "task" {
		t.Errorf("the meeting's own task came back with role %q, want \"task\"", task.Role)
	}
	if plain.Role != "" {
		t.Errorf("an attached issue came back with role %q, want none", plain.Role)
	}
	// The task leads its meeting's list; the restore must not renumber it
	// behind the issue that was attached afterwards.
	if task.Position >= plain.Position {
		t.Errorf("task position %v is not ahead of the attached issue's %v", task.Position, plain.Position)
	}
}

func TestCockpitMeetingSnapshotRestoreRoundTrip(t *testing.T) {
	wsID := cockpitMeetingFixture(t, "Cockpit meeting snapshot")
	issue := dbfx.Issue(t, "字段映射表", testutil.Cols{"workspace_id": wsID})
	node := createNode(t, wsID, map[string]any{"code": "L3-06-06", "name": "多方协同与会议"})
	nasDir := "/Volumes/人机协作空间/06项目管理与规划/06.06多方协同与会议/20260921-01 复星-明略对接会"
	meeting := createMeeting(t, wsID, map[string]any{
		"meet_date": "2026-09-21", "start_time": "09:30", "end_time": "11:00",
		"title": "复星明略数据治理对接会", "code": "20260921-01",
		"kind": "对接会", "status": "已排期",
		"parties": "复星医药 / 明略科技", "organizer": "李青娇",
		"location": "上海复星大厦 18F 会议室", "attendees": "李青娇、杨涛",
		"meet_no": "876 543 210", "link": "https://meeting.example.com/876543210",
		"note": "1. 数据口径对齐", "minutes": "口径以 v3 为准",
		"decisions": "10 月 8 日前完成字段映射", "actions": "杨涛出映射表",
		"nas_dir": nasDir,
	})
	setMeetingIssues(t, wsID, meeting.ID, map[string]any{"issue_ids": []string{issue}}).Want(http.StatusOK)
	setMeetingNodes(t, wsID, meeting.ID, map[string]any{"node_ids": []string{"L3-06-06"}}).Want(http.StatusOK)

	var frozen CockpitSnapshotResponse
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitSnapshot),
		cockpitRequest(http.MethodPost, "/api/cockpit/snapshots", wsID, map[string]any{"label": "会议登记后"})).
		Want(http.StatusCreated).
		JSON(&frozen)

	// Replace the whole board, meetings and links included.
	importBoard(t, wsID, importDoc("v2 board", "L1-99"))
	if wiped := getBoard(t, wsID); len(wiped.Meetings) != 0 || len(wiped.MeetingIssues) != 0 || len(wiped.MeetingNodes) != 0 {
		t.Fatalf("the replacing import left meeting rows behind: %+v", wiped)
	}

	var result CockpitImportResponse
	restoreSnapshot(t, wsID, frozen.ID).Want(http.StatusOK).JSON(&result)
	if result.Meetings != 1 {
		t.Fatalf("restore result meetings = %d, want 1: %+v", result.Meetings, result)
	}
	if len(result.UnresolvedIssues) != 0 {
		t.Errorf("unresolved_issues = %v, want none", result.UnresolvedIssues)
	}

	board := getBoard(t, wsID)
	if len(board.Meetings) != 1 {
		t.Fatalf("board meetings after restore = %d, want 1", len(board.Meetings))
	}
	restored := board.Meetings[0]
	fields := []struct{ name, got, want string }{
		{"title", restored.Title, "复星明略数据治理对接会"},
		{"code", restored.Code, "20260921-01"},
		{"kind", restored.Kind, "对接会"},
		{"status", restored.Status, "已排期"},
		{"parties", restored.Parties, "复星医药 / 明略科技"},
		{"organizer", restored.Organizer, "李青娇"},
		{"location", restored.Location, "上海复星大厦 18F 会议室"},
		{"attendees", restored.Attendees, "李青娇、杨涛"},
		{"meet_no", restored.MeetNo, "876 543 210"},
		{"link", restored.Link, "https://meeting.example.com/876543210"},
		{"note", restored.Note, "1. 数据口径对齐"},
		{"minutes", restored.Minutes, "口径以 v3 为准"},
		{"decisions", restored.Decisions, "10 月 8 日前完成字段映射"},
		{"actions", restored.Actions, "杨涛出映射表"},
		{"nas_dir", restored.NasDir, nasDir},
	}
	for _, f := range fields {
		if f.got != f.want {
			t.Errorf("restored %s = %q, want %q", f.name, f.got, f.want)
		}
	}
	if restored.MeetDate == nil || *restored.MeetDate != "2026-09-21" {
		t.Errorf("restored meet_date = %v, want 2026-09-21", restored.MeetDate)
	}
	if restored.StartTime == nil || *restored.StartTime != "09:30" {
		t.Errorf("restored start_time = %v, want 09:30", restored.StartTime)
	}
	if restored.EndTime == nil || *restored.EndTime != "11:00" {
		t.Errorf("restored end_time = %v, want 11:00", restored.EndTime)
	}

	if len(board.MeetingIssues) != 1 {
		t.Fatalf("restored meeting_issues = %+v, want the one link the snapshot froze", board.MeetingIssues)
	}
	if l := board.MeetingIssues[0]; l.IssueID != issue || l.MeetingID != restored.ID {
		t.Errorf("restored issue link = %+v, want issue %s under meeting %s", l, issue, restored.ID)
	}
	if len(board.MeetingNodes) != 1 {
		t.Fatalf("restored meeting_nodes = %+v, want the one link the snapshot froze", board.MeetingNodes)
	}
	// The document names work items by code, so the link has to find the
	// node the restore itself just recreated under a new id.
	if len(board.Nodes) != 1 || board.Nodes[0].Code != "L3-06-06" {
		t.Fatalf("restored nodes = %+v", board.Nodes)
	}
	if l := board.MeetingNodes[0]; l.NodeID != board.Nodes[0].ID || l.MeetingID != restored.ID {
		t.Errorf("restored work-item link = %+v, want node %s under meeting %s", l, board.Nodes[0].ID, restored.ID)
	}
	// The pre-restore node id is gone: asserting against it would pass on a
	// restore that re-linked nothing.
	if board.Nodes[0].ID == node.ID {
		t.Logf("note: the restored node kept its id %s", node.ID)
	}
}

// ---------------------------------------------------------------------------
// The archive sub-item, and reading meetings back off the share
// ---------------------------------------------------------------------------

// The platform separates a code from its name with a space and the share runs
// them together. A proposal written the platform's way creates a second,
// near-identical folder next to the real one — which is exactly what
// normalizeDirMatch exists to prevent on the reading side.
func TestCockpitMeetingCollabFolderName(t *testing.T) {
	cases := []struct{ in, want string }{
		{"06.06 多方协同与会议", "06.06多方协同与会议"},
		{"06.06.03 会议纪要与素材", "06.06.03会议纪要与素材"},
		{"06.06多方协同与会议", "06.06多方协同与会议"},
		{"多方协同与会议", "多方协同与会议"},
		{"Q3 planning space", "Q3 planning space"}, // no leading code, left alone
		{"  06.01 计划与决策  ", "06.01计划与决策"},
		{"", ""},
	}
	for _, tc := range cases {
		if got := collabFolderName(tc.in); got != tc.want {
			t.Errorf("collabFolderName(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// The archive folder is one level below the module and nobody may have made
// it yet. Creating it is fine; creating the collaboration space above it is
// not — an unmounted share must fail rather than be rebuilt as local
// directories that the next mount hides.
func TestCockpitMeetingEnsureBaseCreatesBelowTheRootOnly(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "06.06多方协同与会议", "06.06.03会议纪要与素材")
	if err := ensureMeetingBase(root, dir); err != nil {
		t.Fatalf("ensureMeetingBase: %v", err)
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		t.Fatalf("the archive folder was not created: stat %v", err)
	}
	// Re-running is the normal case: provisioning is retried per part.
	if err := ensureMeetingBase(root, dir); err != nil {
		t.Errorf("second run: %v", err)
	}

	missing := filepath.Join(root, "not-mounted")
	if err := ensureMeetingBase(missing, filepath.Join(missing, "06.06.03会议纪要与素材")); err == nil {
		t.Error("a root that is not there was accepted")
	}
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Errorf("the missing root was created anyway: stat %v", err)
	}
	if err := ensureMeetingBase(root, filepath.Join(root, "..", "elsewhere")); err == nil {
		t.Error("a path outside the root was accepted")
	}
}

// Everything the scan produces is a guess off a name a human wrote freehand.
// A wrong guess has to be spotted before it is corrected, so the parser
// leaves a field empty rather than filling it with something plausible.
func TestParseMeetingFolderName(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want meetingFolderGuess
	}{
		{
			"the name the register writes",
			"20260921-01 复星医药×华大基因 数据对接",
			meetingFolderGuess{Code: "20260921-01", MeetDate: "2026-09-21", Parties: "复星医药、华大基因", Title: "数据对接"},
		},
		{
			"a date with no sequence number",
			"20260920与联通一体机可信连接器方案沟通",
			meetingFolderGuess{MeetDate: "2026-09-20", Title: "与联通一体机可信连接器方案沟通"},
		},
		{
			"a dashed date",
			"2026-09-20 周例会",
			meetingFolderGuess{MeetDate: "2026-09-20", Title: "周例会"},
		},
		{
			"a dotted date",
			"2026.09.20 周例会",
			meetingFolderGuess{MeetDate: "2026-09-20", Title: "周例会"},
		},
		{
			"a separator after the date is not a sequence number",
			"20260921-复星医药 对接",
			meetingFolderGuess{MeetDate: "2026-09-21", Title: "复星医药 对接"},
		},
		{
			"parties written with a slash",
			"20260921-02 复星/明略 数据治理",
			meetingFolderGuess{Code: "20260921-02", MeetDate: "2026-09-21", Parties: "复星、明略", Title: "数据治理"},
		},
		{
			"one field is a subject, not a list of parties",
			"20260921-03 复星×明略",
			meetingFolderGuess{Code: "20260921-03", MeetDate: "2026-09-21", Title: "复星×明略"},
		},
		{
			"no date at all",
			"临时碰头",
			meetingFolderGuess{Title: "临时碰头"},
		},
		{
			"a number that is not a date",
			"20261340 会议",
			meetingFolderGuess{Title: "20261340 会议"},
		},
		{
			"a date and nothing else keeps the folder name as the subject",
			"20260921",
			meetingFolderGuess{MeetDate: "2026-09-21", Title: "20260921"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseMeetingFolderName(tc.in); got != tc.want {
				t.Errorf("parseMeetingFolderName(%q) =\n  %+v\nwant\n  %+v", tc.in, got, tc.want)
			}
		})
	}
}

// meetingTaskTitle opens the task with the archive sub-item's number so the
// meeting's work sorts and reads like the rest of the programme's.
func TestCockpitMeetingTaskTitle(t *testing.T) {
	meeting := db.CockpitMeeting{Code: "20260921-01", Title: "20260921-01 复星医药×华大基因 数据对接"}
	if got, want := meetingTaskTitle("06.06.03", meeting), "06.06.03 20260921-01 复星医药×华大基因 数据对接"; got != want {
		t.Errorf("title = %q, want %q", got, want)
	}
	// A board with no sub-item chosen still files a task, just without a
	// number in front of it.
	if got, want := meetingTaskTitle("", meeting), meeting.Title; got != want {
		t.Errorf("unnumbered title = %q, want %q", got, want)
	}
	// Re-provisioning a meeting whose name already carries the number must
	// not write it twice.
	numbered := db.CockpitMeeting{Title: "06.06.03 周例会"}
	if got, want := meetingTaskTitle("06.06.03", numbered), "06.06.03 周例会"; got != want {
		t.Errorf("title = %q, want %q", got, want)
	}
	// A meeting with no name of its own falls back to what its folder is
	// called, which is never empty.
	unnamed := db.CockpitMeeting{Code: "20260921-02"}
	if got, want := meetingTaskTitle("06.06.03", unnamed), "06.06.03 20260921-02"; got != want {
		t.Errorf("title = %q, want %q", got, want)
	}
	// A meeting whose name does not repeat its number — every row imported
	// from a transcript is shaped this way — still opens a task that names
	// the meeting it came from.
	plain := db.CockpitMeeting{Code: "20260914-02", Title: "华大与复星自免疾病专病库建设"}
	if got, want := meetingTaskTitle("06.06.03", plain),
		"06.06.03 20260914-02 华大与复星自免疾病专病库建设"; got != want {
		t.Errorf("title = %q, want %q", got, want)
	}
	// With no sub-item chosen the meeting's own number still leads.
	if got, want := meetingTaskTitle("", plain), "20260914-02 华大与复星自免疾病专病库建设"; got != want {
		t.Errorf("title = %q, want %q", got, want)
	}
}

// meetingArchiveFixture is the shape the programme actually files under: a
// project with a collaboration space, the module folder, and the archive
// sub-item that meeting material goes in.
type meetingArchiveFixture struct {
	wsID       string
	project    string
	module     string
	node       string
	root       string
	moduleDir  string
	archiveDir string
}

func newMeetingArchiveFixture(t *testing.T, name string, makeArchiveDir bool) meetingArchiveFixture {
	t.Helper()
	f := meetingArchiveFixture{wsID: cockpitMeetingFixture(t, name)}
	f.root = t.TempDir()
	f.moduleDir = filepath.Join(f.root, "06.06多方协同与会议")
	f.archiveDir = filepath.Join(f.moduleDir, "06.06.03会议纪要与素材")
	if err := os.Mkdir(f.moduleDir, 0o755); err != nil {
		t.Fatalf("setup: create the module folder: %v", err)
	}
	if makeArchiveDir {
		if err := os.Mkdir(f.archiveDir, 0o755); err != nil {
			t.Fatalf("setup: create the archive folder: %v", err)
		}
	}
	f.project = dbfx.Project(t, "06项目管理与规划", testutil.Cols{
		"workspace_id": f.wsID, "collab_path": f.root,
	})
	f.module = dbfx.Module(t, f.project, "06.06 多方协同与会议", testutil.Cols{"workspace_id": f.wsID})
	f.node = createNode(t, f.wsID, map[string]any{"code": "06.06.03", "name": "会议纪要与素材"}).ID

	// The task is opened through IssueService, which dbfx did not create.
	dbfx.Cleanup(t, "DELETE FROM issue WHERE workspace_id = $1", f.wsID)
	dbfx.Cleanup(t, "DELETE FROM activity_log WHERE issue_id IN (SELECT id FROM issue WHERE workspace_id = $1)", f.wsID)
	dbfx.Cleanup(t, "DELETE FROM inbox_item WHERE issue_id IN (SELECT id FROM issue WHERE workspace_id = $1)", f.wsID)
	dbfx.Cleanup(t, "DELETE FROM issue_subscriber WHERE issue_id IN (SELECT id FROM issue WHERE workspace_id = $1)", f.wsID)
	return f
}

func (f meetingArchiveFixture) provision(t *testing.T, meetingID string, body map[string]any) CockpitMeetingProvisionResponse {
	t.Helper()
	var resp CockpitMeetingProvisionResponse
	testutil.Call(t, cockpitHandler(testHandler.ProvisionCockpitMeeting),
		testutil.WithURLParams(
			cockpitRequest(http.MethodPost, "/api/cockpit/meetings/"+meetingID+"/provision", f.wsID, body),
			"meetingId", meetingID,
		)).
		Want(http.StatusOK).
		JSON(&resp)
	return resp
}

// A module is not the last level the programme files by: meeting material
// belongs in the archive sub-item under it, and the task carries that
// sub-item's number.
func TestCockpitMeetingProvisionFilesUnderTheArchiveSubItem(t *testing.T) {
	f := newMeetingArchiveFixture(t, "Cockpit meeting archive", true)
	meeting := createMeeting(t, f.wsID, map[string]any{
		"title": "20260921-01 复星医药×华大基因 数据对接", "code": "20260921-01",
		"meet_date": "2026-09-21",
	})

	resp := f.provision(t, meeting.ID, map[string]any{
		"project_id": f.project, "module_id": f.module, "node_id": f.node,
	})

	wantDir := filepath.Join(f.archiveDir, "20260921-01 复星医药×华大基因 数据对接")
	if resp.DirError != "" || resp.Dir != wantDir {
		t.Errorf("dir = %q err = %q, want %q", resp.Dir, resp.DirError, wantDir)
	}
	if info, err := os.Stat(wantDir); err != nil || !info.IsDir() {
		t.Errorf("the meeting folder was not created under the sub-item: stat %v", err)
	}
	if resp.TaskError != "" || resp.Task == nil {
		t.Fatalf("task_error = %q task = %+v", resp.TaskError, resp.Task)
	}
	wantTitle := "06.06.03 20260921-01 复星医药×华大基因 数据对接"
	if resp.Task.IssueTitle != wantTitle {
		t.Errorf("task title = %q, want %q", resp.Task.IssueTitle, wantTitle)
	}
	// The path is in the task body: whoever opens the task from their inbox
	// must not have to come back to the board to find the material.
	var description *string
	dbfx.QueryRow(t, "SELECT description FROM issue WHERE id = $1", resp.Task.IssueID).Scan(&description)
	if description == nil || !strings.Contains(*description, wantDir) {
		t.Errorf("task description does not state the folder: %v", description)
	}

	board := getBoard(t, f.wsID)
	if board.Cockpit.MeetingNodeID == nil || *board.Cockpit.MeetingNodeID != f.node {
		t.Errorf("board meeting_node_id = %v, want %s", board.Cockpit.MeetingNodeID, f.node)
	}
	if board.Cockpit.MeetingDir != f.archiveDir {
		t.Errorf("board meeting_dir = %q, want the archive folder %q", board.Cockpit.MeetingDir, f.archiveDir)
	}
}

// The archive folder may simply not have been created yet on a share that IS
// mounted. Refusing to file a meeting over one missing empty directory would
// send someone to Finder for it.
func TestCockpitMeetingProvisionCreatesTheMissingArchiveFolder(t *testing.T) {
	f := newMeetingArchiveFixture(t, "Cockpit meeting archive missing", false)
	meeting := createMeeting(t, f.wsID, map[string]any{
		"title": "20260921-01 周例会", "code": "20260921-01", "meet_date": "2026-09-21",
	})

	resp := f.provision(t, meeting.ID, map[string]any{
		"project_id": f.project, "module_id": f.module, "node_id": f.node,
		"create_task": false,
	})

	wantDir := filepath.Join(f.archiveDir, "20260921-01 周例会")
	if resp.DirError != "" || resp.Dir != wantDir {
		t.Fatalf("dir = %q err = %q, want %q", resp.Dir, resp.DirError, wantDir)
	}
	if info, err := os.Stat(wantDir); err != nil || !info.IsDir() {
		t.Errorf("the meeting folder was not created: stat %v", err)
	}
	// The sub-item folder is named the way the share names the others, not
	// the way the platform writes the title.
	if entries, err := os.ReadDir(f.moduleDir); err == nil {
		for _, entry := range entries {
			if entry.Name() != "06.06.03会议纪要与素材" {
				t.Errorf("created a second folder beside the archive one: %q", entry.Name())
			}
		}
	}
}

// Meetings happen whether or not anybody opens the register, and their
// material lands in the archive folder either way. The scan is how those
// folders become rows.
func TestCockpitMeetingScanFindsUnrecordedFolders(t *testing.T) {
	f := newMeetingArchiveFixture(t, "Cockpit meeting scan", true)
	for _, name := range []string{
		"20260921-01 复星医药×华大基因 数据对接",
		"20260920与联通一体机可信连接器方案沟通",
		".DS_Store_folder",
	} {
		if err := os.Mkdir(filepath.Join(f.archiveDir, name), 0o755); err != nil {
			t.Fatalf("setup: %v", err)
		}
	}
	if err := os.WriteFile(filepath.Join(f.archiveDir, "读我.txt"), []byte("x"), 0o644); err != nil {
		t.Fatalf("setup: %v", err)
	}
	// One of them is already in the register, by the folder it remembers.
	recorded := createMeeting(t, f.wsID, map[string]any{
		"title":   "20260921-01 复星医药×华大基因 数据对接",
		"nas_dir": filepath.Join(f.archiveDir, "20260921-01 复星医药×华大基因 数据对接"),
	})

	var resp CockpitMeetingScanResponse
	testutil.Call(t, cockpitHandler(testHandler.ScanCockpitMeetingFolders),
		cockpitRequest(http.MethodGet,
			"/api/cockpit/meetings/scan?project_id="+f.project+"&module_id="+f.module+"&node_id="+f.node,
			f.wsID, nil)).
		Want(http.StatusOK).
		JSON(&resp)

	if resp.Error != "" || !resp.BaseDirExists || resp.BaseDir != f.archiveDir {
		t.Fatalf("base_dir = %q exists=%v err=%q", resp.BaseDir, resp.BaseDirExists, resp.Error)
	}
	// A hidden folder and a loose file are not meetings.
	if len(resp.Entries) != 2 {
		t.Fatalf("scanned %d entries, want 2: %+v", len(resp.Entries), resp.Entries)
	}
	if resp.Matched != 1 {
		t.Errorf("matched = %d, want 1", resp.Matched)
	}
	byName := map[string]CockpitMeetingScanEntry{}
	for _, entry := range resp.Entries {
		byName[entry.Name] = entry
	}
	if got := byName["20260921-01 复星医药×华大基因 数据对接"]; got.MeetingID != recorded.ID {
		t.Errorf("the recorded folder was not matched: meeting_id = %q", got.MeetingID)
	}
	fresh := byName["20260920与联通一体机可信连接器方案沟通"]
	if fresh.MeetingID != "" {
		t.Errorf("an unrecorded folder claims meeting %q", fresh.MeetingID)
	}
	if fresh.MeetDate != "2026-09-20" || fresh.Title != "与联通一体机可信连接器方案沟通" {
		t.Errorf("guessed %+v, want the date and subject off the name", fresh)
	}
}

// Importing writes rows that say, in the data, that nobody has checked them.
func TestCockpitMeetingImportFlagsWhatItGuessed(t *testing.T) {
	f := newMeetingArchiveFixture(t, "Cockpit meeting import", true)
	present := "20260920 复星医药×联通 可信连接器"
	if err := os.Mkdir(filepath.Join(f.archiveDir, present), 0o755); err != nil {
		t.Fatalf("setup: %v", err)
	}

	var resp CockpitMeetingImportResponse
	testutil.Call(t, cockpitHandler(testHandler.ImportCockpitMeetingFolders),
		cockpitRequest(http.MethodPost, "/api/cockpit/meetings/import", f.wsID, map[string]any{
			"project_id": f.project, "module_id": f.module, "node_id": f.node,
			"create_task": true,
			"items": []map[string]any{
				{"name": present, "meet_date": "2026-09-20", "title": "可信连接器", "parties": "复星医药、联通"},
				{"name": "folder-that-went-away", "meet_date": "2026-09-19", "title": "x"},
			},
		})).
		Want(http.StatusOK).
		JSON(&resp)

	if len(resp.Meetings) != 1 {
		t.Fatalf("imported %d meetings, want 1: %+v", len(resp.Meetings), resp.Meetings)
	}
	imported := resp.Meetings[0]
	if !imported.Detected {
		t.Error("an imported row is not flagged as detected")
	}
	if imported.NasDir != filepath.Join(f.archiveDir, present) {
		t.Errorf("nas_dir = %q, want the folder it was read from", imported.NasDir)
	}
	if imported.Title != "可信连接器" || imported.Parties != "复星医药、联通" {
		t.Errorf("imported %+v, want the corrected fields", imported)
	}
	// A folder that disappeared between the scan and the import is reported,
	// not fatal: it must not cost the other rows.
	if len(resp.Skipped) != 1 || resp.Skipped[0].Name != "folder-that-went-away" {
		t.Errorf("skipped = %+v, want the missing folder", resp.Skipped)
	}
	if len(resp.Issues) != 1 || resp.Issues[0].Role != "task" {
		t.Fatalf("issues = %+v, want the meeting's own task", resp.Issues)
	}
	// The folder carried no number, so the import gave it the day's first
	// one and the task is titled with it.
	if want := "06.06.03 20260920-01 可信连接器"; resp.Issues[0].IssueTitle != want {
		t.Errorf("task title = %q, want %q", resp.Issues[0].IssueTitle, want)
	}

	// Running the import again over the same folder must not file it twice.
	var again CockpitMeetingImportResponse
	testutil.Call(t, cockpitHandler(testHandler.ImportCockpitMeetingFolders),
		cockpitRequest(http.MethodPost, "/api/cockpit/meetings/import", f.wsID, map[string]any{
			"project_id": f.project, "module_id": f.module, "node_id": f.node,
			"items": []map[string]any{{"name": present, "meet_date": "2026-09-20", "title": "可信连接器"}},
		})).
		Want(http.StatusOK).
		JSON(&again)
	if len(again.Meetings) != 0 || len(again.Skipped) != 1 {
		t.Errorf("re-import created %+v skipped %+v, want nothing created", again.Meetings, again.Skipped)
	}

	// Clearing the flag is how someone says they have checked the guesses.
	if checked := patchMeeting(t, f.wsID, imported.ID, map[string]any{"detected": false}); checked.Detected {
		t.Error("detected stayed set after it was cleared")
	}
}

// A scan reads the number off a folder that has one. A folder someone named
// by hand has none, and it is numbered into the day it belongs to rather than
// landing in the register unnumbered.
func TestCockpitMeetingImportNumbersUnnumberedFolders(t *testing.T) {
	f := newMeetingArchiveFixture(t, "Cockpit meeting import numbering", true)
	named := []string{"复星医药×联通 可信连接器", "复星医药×华大 专病库", "20260920-07 已有编号的目录"}
	for _, name := range named {
		if err := os.Mkdir(filepath.Join(f.archiveDir, name), 0o755); err != nil {
			t.Fatalf("setup: %v", err)
		}
	}

	var resp CockpitMeetingImportResponse
	testutil.Call(t, cockpitHandler(testHandler.ImportCockpitMeetingFolders),
		cockpitRequest(http.MethodPost, "/api/cockpit/meetings/import", f.wsID, map[string]any{
			"project_id": f.project, "module_id": f.module, "node_id": f.node,
			"items": []map[string]any{
				{"name": named[2], "meet_date": "2026-09-20", "title": "已有编号的目录", "code": "20260920-07"},
				{"name": named[0], "meet_date": "2026-09-20", "title": "可信连接器"},
				{"name": named[1], "meet_date": "2026-09-20", "title": "专病库"},
			},
		})).
		Want(http.StatusOK).
		JSON(&resp)

	if len(resp.Meetings) != 3 {
		t.Fatalf("imported %d meetings, want 3: %+v", len(resp.Meetings), resp.Meetings)
	}
	// The one that carried a number keeps it, and the two that did not are
	// numbered after it — one batch must not file three rows as -01.
	want := []string{"20260920-07", "20260920-08", "20260920-09"}
	for i, w := range want {
		if resp.Meetings[i].Code != w {
			t.Errorf("meeting %d code = %q, want %q", i, resp.Meetings[i].Code, w)
		}
	}
}

// A folder name is not a path. Importing must never be a way to write a row
// that points somewhere else on the share.
func TestCockpitMeetingImportRefusesToLeaveTheArchiveFolder(t *testing.T) {
	f := newMeetingArchiveFixture(t, "Cockpit meeting import escape", true)

	var resp CockpitMeetingImportResponse
	testutil.Call(t, cockpitHandler(testHandler.ImportCockpitMeetingFolders),
		cockpitRequest(http.MethodPost, "/api/cockpit/meetings/import", f.wsID, map[string]any{
			"project_id": f.project, "module_id": f.module, "node_id": f.node,
			"items": []map[string]any{
				{"name": "../06.06.01协作方名录与协议", "title": "elsewhere"},
				{"name": "/etc", "title": "absolute"},
			},
		})).
		Want(http.StatusOK).
		JSON(&resp)

	if len(resp.Meetings) != 0 {
		t.Errorf("imported %+v, want nothing", resp.Meetings)
	}
	if len(resp.Skipped) != 2 {
		t.Errorf("skipped = %+v, want both refused", resp.Skipped)
	}
}
