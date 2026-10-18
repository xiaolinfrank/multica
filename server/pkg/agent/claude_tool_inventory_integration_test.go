//go:build agentintegration

package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestClaudeToolInventorySmoke(t *testing.T) {
	requireRealAgentSmoke(t)
	providerFlags := []string{"CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"}
	for _, flag := range providerFlags {
		t.Setenv(flag, "0")
	}
	executable, err := exec.LookPath("claude")
	if err != nil {
		t.Fatal(err)
	}
	for _, search := range []string{"true", "false"} {
		t.Run(search, func(t *testing.T) {
			requests := make(chan []string, 10)
			outputs := make(chan string, 10)
			stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.Contains(r.URL.Path, "count_tokens") {
					w.Header().Set("Content-Type", "application/json")
					io.WriteString(w, `{"input_tokens":100}`)
					return
				}
				var body struct {
					Model    string          `json:"model"`
					Messages json.RawMessage `json:"messages"`
					Tools    []struct {
						Name         string `json:"name"`
						Type         string `json:"type"`
						DeferLoading bool   `json:"defer_loading"`
					} `json:"tools"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					http.Error(w, "invalid JSON", http.StatusBadRequest)
					return
				}
				isProbe := strings.Contains(string(body.Messages), "MULTICA_TOOL_INVENTORY_ONLY")
				hasToolResult := false
				if isProbe {
					var history []struct {
						Content json.RawMessage `json:"content"`
					}
					if json.Unmarshal(body.Messages, &history) == nil {
						for _, message := range history {
							var blocks []claudeContentBlock
							if json.Unmarshal(message.Content, &blocks) != nil {
								continue
							}
							for _, block := range blocks {
								if block.Type == "tool_result" && block.ToolUseID == "local_bash" {
									hasToolResult = true
									select {
									case outputs <- string(block.Content):
									default:
									}
								}
							}
						}
					}
					var names []string
					for _, tool := range body.Tools {
						names = append(names, fmt.Sprintf("%s(type=%s,deferred=%t)", tool.Name, tool.Type, tool.DeferLoading))
					}
					select {
					case requests <- names:
					default:
					}
				}
				w.Header().Set("Content-Type", "text/event-stream")
				if isProbe && !hasToolResult {
					for _, event := range []struct{ kind, data string }{
						{"message_start", `{"type":"message_start","message":{"id":"msg_local_command","type":"message","role":"assistant","model":"test-model","content":[],"stop_reason":null,"usage":{"input_tokens":100,"output_tokens":0}}}`},
						{"content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"local_bash","name":"Bash","input":{}}}`},
						{"content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"command\":\"printf 'MULTICA_BASH_SMOKE_OK\\\\n'\"}"}}`},
						{"content_block_stop", `{"type":"content_block_stop","index":0}`},
						{"message_delta", `{"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":2}}`},
						{"message_stop", `{"type":"message_stop"}`},
					} {
						fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event.kind, event.data)
					}
					return
				}
				for _, event := range []struct{ kind, data string }{
					{"message_start", `{"type":"message_start","message":{"id":"msg_local_probe","type":"message","role":"assistant","model":"test-model","content":[],"stop_reason":null,"usage":{"input_tokens":100,"output_tokens":0}}}`},
					{"content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`},
					{"content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"local probe"}}`},
					{"content_block_stop", `{"type":"content_block_stop","index":0}`},
					{"message_delta", `{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}`},
					{"message_stop", `{"type":"message_stop"}`},
				} {
					fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event.kind, event.data)
				}
			}))
			defer stub.Close()
			settingsEnv := map[string]string{
				"ANTHROPIC_BASE_URL": stub.URL, "ANTHROPIC_AUTH_TOKEN": "local-probe-dummy",
				"ANTHROPIC_API_KEY": "", "ENABLE_TOOL_SEARCH": search,
			}
			for _, flag := range providerFlags {
				settingsEnv[flag] = "0"
			}
			settings, err := json.Marshal(map[string]any{"env": settingsEnv})
			if err != nil {
				t.Fatal(err)
			}
			cwd := t.TempDir()
			settingsDir := filepath.Join(cwd, ".claude")
			if err := os.Mkdir(settingsDir, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(settingsDir, "settings.local.json"), settings, 0o600); err != nil {
				t.Fatal(err)
			}
			var launchSettings struct {
				Env map[string]string `json:"env"`
			}
			args := buildClaudeArgs(ExecOptions{}, slog.Default())
			for i := 0; i+1 < len(args); i++ {
				if args[i] == "--settings" {
					if err := json.Unmarshal([]byte(args[i+1]), &launchSettings); err != nil {
						t.Fatal(err)
					}
				}
			}
			if launchSettings.Env == nil {
				t.Fatal("managed tool discovery settings missing")
			}
			launchSettings.Env["ANTHROPIC_BASE_URL"] = stub.URL
			launchSettings.Env["ANTHROPIC_AUTH_TOKEN"] = "local-probe-dummy"
			launchSettings.Env["ANTHROPIC_API_KEY"] = ""
			for _, flag := range providerFlags {
				launchSettings.Env[flag] = "0"
			}
			transportSettings, err := json.Marshal(launchSettings)
			if err != nil {
				t.Fatal(err)
			}
			backend, err := New("claude", Config{ExecutablePath: executable, Logger: slog.Default()})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
			defer cancel()
			session, err := backend.Execute(ctx, "MULTICA_TOOL_INVENTORY_ONLY", ExecOptions{
				Cwd: cwd, Timeout: 45 * time.Second, MaxTurns: 3,
				CustomArgs: []string{"--settings", string(transportSettings), "--no-session-persistence"},
			})
			if err != nil {
				t.Fatal(err)
			}
			for range session.Messages {
			}
			result := <-session.Result
			select {
			case tools := <-requests:
				t.Logf("ENABLE_TOOL_SEARCH=%s outgoing_tools=%v", search, tools)
				for _, required := range []string{"Bash", "Skill", "Read", "Write"} {
					found := false
					for _, tool := range tools {
						found = found || strings.HasPrefix(tool, required+"(")
					}
					if !found {
						t.Errorf("missing direct tool %s", required)
					}
				}
				for _, tool := range tools {
					if strings.HasPrefix(tool, "ToolSearch(") || strings.Contains(tool, "deferred=true") {
						t.Errorf("managed run still uses deferred discovery: %s", tool)
					}
				}
			default:
				t.Fatalf("no local diagnostic request: status=%s error=%s", result.Status, result.Error)
			}
			select {
			case output := <-outputs:
				if strings.TrimSpace(claudeSmokeToolOutputText(output)) != "MULTICA_BASH_SMOKE_OK" {
					t.Fatalf("unexpected Bash output from local replay: %s", output)
				}
				t.Logf("local Bash replay received stdout: %s", output)
			default:
				t.Fatal("local Bash replay produced no tool result")
			}
			if result.Status != "completed" {
				t.Fatalf("local diagnostic failed: %s", result.Error)
			}
		})
	}
}
