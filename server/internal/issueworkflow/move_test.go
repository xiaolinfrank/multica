package issueworkflow

import "testing"

// The status of an issue moving between projects: Default keeps it, a named
// workflow that lists it keeps it, a named one that does not maps by category.
func TestMappedStatusForMove(t *testing.T) {
	named := Definition{IsDefault: false, Steps: []Step{{StatusKey: "backlog"}, {StatusKey: "implement"}, {StatusKey: "done"}}}
	def := Definition{IsDefault: true, Steps: []Step{{StatusKey: "backlog"}, {StatusKey: "todo"}}}
	category := func(key string) string {
		switch key {
		case "backlog", "todo":
			return "unstarted"
		case "implement", "in_progress", "blocked":
			return "started"
		case "done":
			return "done"
		}
		return ""
	}
	cases := []struct {
		name   string
		def    *Definition
		status string
		want   string
		mapped bool
	}{
		{"no workflow", nil, "in_progress", "", false},
		{"default keeps everything", &def, "in_progress", "", false},
		{"named lists the status", &named, "implement", "", false},
		{"named maps by category", &named, "in_progress", "implement", true},
		{"named maps unstarted", &named, "todo", "backlog", true},
		{"named falls back to StartStatus", &named, "weird", StartStatus, true},
	}
	for _, c := range cases {
		got, mapped := MappedStatusForMove(c.def, c.status, category)
		if got != c.want || mapped != c.mapped {
			t.Fatalf("%s: got (%q, %v), want (%q, %v)", c.name, got, mapped, c.want, c.mapped)
		}
	}
}
