package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func claudeSmokeToolOutputText(output string) string {
	var text string
	if err := json.Unmarshal([]byte(output), &text); err == nil {
		return text
	}
	var blocks []claudeContentBlock
	if err := json.Unmarshal([]byte(output), &blocks); err != nil {
		return ""
	}
	var result strings.Builder
	for _, block := range blocks {
		if block.Type == "text" {
			result.WriteString(block.Text)
		}
	}
	return result.String()
}

func TestClaudeSmokeToolOutput(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name string
		raw  string
		want bool
	}{
		{"string", `"MULTICA_BASH_SMOKE_OK\n"`, true},
		{"blocks", `[{"type":"text","text":"MULTICA_BASH_SMOKE_OK\n"}]`, true},
		{"failure", `"Error: command printf MULTICA_BASH_SMOKE_OK was denied"`, false},
		{"plain text", "MULTICA_BASH_SMOKE_OK", false},
		{"empty", `null`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			backend := &claudeBackend{cfg: Config{Logger: slog.Default()}}
			messages := make(chan Message, 1)
			backend.handleUser(claudeSDKMessage{Message: json.RawMessage(
				`{"role":"user","content":[{"type":"tool_result","tool_use_id":"bash-call","content":` + tc.raw + `}]}`,
			)}, messages)
			got := false
			select {
			case message := <-messages:
				got = strings.TrimSpace(claudeSmokeToolOutputText(message.Output)) == "MULTICA_BASH_SMOKE_OK"
			default:
			}
			if got != tc.want {
				t.Fatalf("decoded tool result match = %t, want %t", got, tc.want)
			}
		})
	}
}

func TestClaudeExecuteLogsInitialTools(t *testing.T) {
	t.Parallel()
	if runtime.GOOS == "windows" {
		t.Skip("shell-script fixture is POSIX-only")
	}

	for _, tc := range []struct {
		name      string
		fields    string
		wantBash  string
		wantCount int
	}{
		{name: "available", fields: `,"tools":["Bash","Read","Skill","ToolSearch"]`, wantBash: "available", wantCount: 4},
		{name: "missing", fields: `,"tools":["Skill","ToolSearch"]`, wantBash: "missing", wantCount: 2},
		{name: "empty", fields: `,"tools":[]`, wantBash: "missing"},
		{name: "unreported", wantBash: "unknown"},
		{name: "null", fields: `,"tools":null`, wantBash: "unknown"},
		{name: "unexpected shape", fields: `,"tools":{"Bash":true}`, wantBash: "unknown"},
		{name: "unexpected entry", fields: `,"tools":["Bash",{}]`, wantBash: "unknown"},
		{name: "null entry with Bash", fields: `,"tools":["Bash",null]`, wantBash: "unknown"},
		{name: "null entry without Bash", fields: `,"tools":["Read",null]`, wantBash: "unknown"},
		{name: "empty name", fields: `,"tools":[""]`, wantBash: "unknown"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			fakePath := filepath.Join(t.TempDir(), "claude")
			script := "#!/bin/sh\nIFS= read -r _\n" +
				`printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-tools","model":"test-model"` + tc.fields + `}'` + "\n" +
				`printf '%s\n' '{"type":"system","subtype":"init","session_id":"child","parent_tool_use_id":"call-child","tools":["Read"]}'` + "\n" +
				`printf '%s\n' '{"type":"system","subtype":"status","session_id":"sess-tools"}'` + "\n" +
				`printf '%s\n' '{"type":"result","session_id":"sess-tools","result":"ok","is_error":false}'` + "\n"
			writeTestExecutable(t, fakePath, []byte(script))
			var logs bytes.Buffer
			backend, err := New("claude", Config{
				ExecutablePath: fakePath,
				Env:            map[string]string{"IS_SANDBOX": "1"},
				Logger:         slog.New(slog.NewJSONHandler(&logs, nil)),
			})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			session, err := backend.Execute(ctx, "ignored", ExecOptions{Timeout: 5 * time.Second})
			if err != nil {
				t.Fatal(err)
			}
			for range session.Messages {
			}
			result := <-session.Result
			if result.Status != "completed" || result.Output != "ok" {
				t.Fatalf("tool diagnostics must not change completion: %+v", result)
			}
			count := 0
			for _, line := range strings.Split(strings.TrimSpace(logs.String()), "\n") {
				var entry struct {
					Message   string   `json:"msg"`
					SessionID string   `json:"session_id"`
					Model     string   `json:"model"`
					BashTool  string   `json:"bash_tool"`
					Tools     []string `json:"tools"`
				}
				if err := json.Unmarshal([]byte(line), &entry); err != nil {
					t.Fatal(err)
				}
				if entry.Message != "claude initialized" {
					continue
				}
				count++
				if entry.SessionID != "sess-tools" || entry.Model != "test-model" || entry.BashTool != tc.wantBash || len(entry.Tools) != tc.wantCount {
					t.Errorf("unexpected tool diagnostics: %+v", entry)
				}
			}
			if count != 1 {
				t.Fatalf("expected one root initialization log, got %d: %s", count, logs.String())
			}
		})
	}
}
