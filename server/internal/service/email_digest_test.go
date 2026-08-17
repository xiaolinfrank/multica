package service

import (
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func shanghaiTime(t *testing.T, y int, mo time.Month, d, h, mi int) time.Time {
	t.Helper()
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatalf("load Asia/Shanghai: %v", err)
	}
	return time.Date(y, mo, d, h, mi, 0, 0, loc)
}

func TestInboxTypeLabelCoversDBTypes(t *testing.T) {
	cases := map[string]string{
		"issue_assigned":     "指派",
		"unassigned":         "取消指派",
		"assignee_changed":   "负责人变更",
		"status_changed":     "状态变更",
		"new_comment":        "评论",
		"mentioned":          "提及",
		"priority_changed":   "优先级变更",
		"start_date_changed": "开始日期变更",
		"due_date_changed":   "截止日期变更",
		"task_failed":        "任务失败",
		"agent_blocked":      "智能体受阻",
		"reaction_added":     "收到回应",
		"quick_create_done":  "创建完成",
		"whatever-else":      "新通知",
		"":                   "新通知",
	}
	for in, want := range cases {
		if got := inboxTypeLabel(in); got != want {
			t.Errorf("inboxTypeLabel(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestTruncateRunes(t *testing.T) {
	if got := truncateRunes("短", 5); got != "短" {
		t.Errorf("no-truncation case broken: %q", got)
	}
	got := truncateRunes(strings.Repeat("界", 10), 5)
	if got != "界界界界…" {
		t.Errorf("rune truncation broken: %q", got)
	}
	if !utf8.ValidString(got) {
		t.Errorf("truncation split a rune: %q", got)
	}
}

func TestDigestExcerpt(t *testing.T) {
	// Mention links collapse to labels; whitespace runs flatten.
	in := "@张三 请看 [问题 #42](mention://issue/00000000-0000-0000-0000-00000000000a)\n\n  并回复"
	want := "@张三 请看 问题 #42 并回复"
	if got := digestExcerpt(in); got != want {
		t.Fatalf("digestExcerpt = %q, want %q", got, want)
	}
	if got := digestExcerpt(""); got != "" {
		t.Fatalf("empty body excerpt = %q", got)
	}
	long := strings.Repeat("字", inboxDigestMaxExcerptRunes+20)
	got := digestExcerpt(long)
	if runes := len([]rune(got)); runes != inboxDigestMaxExcerptRunes {
		t.Fatalf("excerpt length = %d, want %d", runes, inboxDigestMaxExcerptRunes)
	}
}

func summaryInput(t *testing.T) InboxSummaryEmailInput {
	t.Helper()
	return InboxSummaryEmailInput{
		RecipientName: "黄沛霖",
		GeneratedAt:   shanghaiTime(t, 2026, time.August, 17, 9, 0),
		Sections: []InboxSummarySection{
			{
				WorkspaceName: "生物医药",
				InboxURL:      "http://app/ws-a/inbox",
				Items: []InboxSummaryItem{
					{
						Type:      "mentioned",
						Severity:  "action_required",
						Title:     "请审阅 <b>方案</b>",
						Body:      "@你 请看 [文档](mention://file/00000000-0000-0000-0000-00000000000a)",
						CreatedAt: shanghaiTime(t, 2026, time.August, 17, 8, 30),
					},
					{
						Type:      "new_comment",
						Severity:  "info",
						Title:     "周会纪要",
						Body:      "",
						CreatedAt: shanghaiTime(t, 2026, time.August, 15, 14, 0),
					},
				},
				OverflowCount: 2,
			},
			{
				WorkspaceName: "临床",
				InboxURL:      "http://app/ws-b/inbox",
				Items: []InboxSummaryItem{
					{
						Type:      "task_failed",
						Severity:  "attention",
						Title:     "数据抓取失败",
						Body:      strings.Repeat("日志 ", 100),
						CreatedAt: shanghaiTime(t, 2026, time.August, 16, 10, 0),
					},
				},
			},
		},
	}
}

func TestBuildInboxSummaryEmail(t *testing.T) {
	subject, htmlOut, err := buildInboxSummaryEmail(summaryInput(t))
	if err != nil {
		t.Fatalf("build: %v", err)
	}

	if subject != "BayClaw：你有 5 条未读通知" {
		t.Fatalf("subject = %q", subject)
	}

	checks := []struct {
		name   string
		want   string
		absent bool
	}{
		{name: "escaped title keeps text", want: "请审阅 &lt;b&gt;方案&lt;/b&gt;"},
		{name: "mention link collapsed to label", want: "文档"},
		{name: "no raw mention scheme", want: "mention://", absent: true},
		{name: "mention pill label", want: "提及"},
		{name: "comment pill label", want: "评论"},
		{name: "attention pill label", want: "任务失败"},
		{name: "action_required pill colour", want: "#fee2e2"},
		{name: "first workspace section", want: "生物医药"},
		{name: "second workspace section", want: "临床"},
		{name: "unread badge includes overflow", want: "4 条未读"},
		{name: "overflow note", want: "还有 2 条未读"},
		{name: "generated-at caption", want: "生成于 2026-08-17 09:00"},
		{name: "recipient greeting", want: "你好，黄沛霖"},
		{name: "per-section inbox link", want: "http://app/ws-a/inbox"},
		{name: "cta follows first section", want: `href="http://app/ws-a/inbox"`},
		{name: "excerpt truncated to one line", want: "日志 日志 日志"},
		{name: "shanghai time rendering", want: "08-17 08:30"},
	}
	for _, c := range checks {
		if c.absent {
			if strings.Contains(htmlOut, c.want) {
				t.Errorf("%s: output must not contain %q", c.name, c.want)
			}
		} else if !strings.Contains(htmlOut, c.want) {
			t.Errorf("%s: output missing %q", c.name, c.want)
		}
	}

	// The header pill renders exactly once; the footer's "每日未读摘要"
	// disclaimer is separate copy.
	if got := strings.Count(htmlOut, ">未读摘要<"); got != 1 {
		t.Errorf("digest pill should render once, got %d", got)
	}
	if got := strings.Count(htmlOut, "每日未读摘要"); got != 1 {
		t.Errorf("footer disclaimer should render once, got %d", got)
	}
}

func TestBuildInboxSummaryEmailBlankName(t *testing.T) {
	in := summaryInput(t)
	in.RecipientName = "  "
	_, htmlOut, err := buildInboxSummaryEmail(in)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if !strings.Contains(htmlOut, "你好，过去一周你有 5 条未读通知") {
		t.Fatalf("blank-name greeting fallback broken:\n%s", htmlOut)
	}
}

func TestInboxSummaryEmailInputTotalItems(t *testing.T) {
	if got := (summaryInput(t)).TotalItems(); got != 5 {
		t.Fatalf("TotalItems = %d, want 5 (3 listed + 2 overflow)", got)
	}
}

func TestSeverityPillColors(t *testing.T) {
	if bg, _ := severityPillColors("action_required"); bg != "#fee2e2" {
		t.Errorf("action_required bg = %s", bg)
	}
	if _, fg := severityPillColors("attention"); fg != "#c2410c" {
		t.Errorf("attention fg = %s", fg)
	}
	if bg, _ := severityPillColors("info"); bg != "#e0f2fe" {
		t.Errorf("info bg = %s", bg)
	}
	if bg, _ := severityPillColors("unknown"); bg != "#e0f2fe" {
		t.Errorf("unknown falls back to info bg, got %s", bg)
	}
}
