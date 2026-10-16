//go:build agentintegration

package agent

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestClaudeBashToolSmoke(t *testing.T) {
	requireRealAgentSmoke(t)
	executable, err := exec.LookPath("claude")
	if err != nil {
		t.Fatal(err)
	}
	backend, err := New("claude", Config{
		ExecutablePath: executable,
		Logger:         slog.New(slog.NewJSONHandler(os.Stdout, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	customArgs := []string{"--max-budget-usd", "0.50"}
	if search := os.Getenv("MULTICA_SMOKE_TOOL_SEARCH"); search != "" {
		if search != "true" && search != "false" {
			t.Fatal("MULTICA_SMOKE_TOOL_SEARCH must be true or false")
		}
		settings, err := json.Marshal(map[string]any{"env": map[string]string{"ENABLE_TOOL_SEARCH": search}})
		if err != nil {
			t.Fatal(err)
		}
		customArgs = append(customArgs, "--settings", string(settings))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	session, err := backend.Execute(ctx,
		"仅做工具可用性诊断：用你现有的命令执行工具运行 printf '%s\\n' MULTICA_BASH_SMOKE_OK，然后回复实际标准输出。不要读取文件、访问网络、修改配置或启动子代理。若执行工具不存在，如实报告，不猜测执行结果。",
		ExecOptions{
			Cwd:        t.TempDir(),
			Timeout:    3 * time.Minute,
			MaxTurns:   6,
			CustomArgs: customArgs,
		})
	if err != nil {
		t.Fatal(err)
	}
	bashCalls := make(map[string]bool)
	sawOutput := false
	for message := range session.Messages {
		switch message.Type {
		case MessageToolUse:
			t.Logf("tool: %s", message.Tool)
			if message.Tool == "Bash" {
				bashCalls[message.CallID] = true
			}
		case MessageToolResult:
			if bashCalls[message.CallID] {
				sawOutput = strings.TrimSpace(claudeSmokeToolOutputText(message.Output)) == "MULTICA_BASH_SMOKE_OK"
				t.Logf("Bash stdout marker received: %t", sawOutput)
			}
		}
	}
	result := <-session.Result
	if result.Status != "completed" || !sawOutput {
		t.Fatalf("Bash smoke did not execute successfully: status=%s error=%s output=%s", result.Status, result.Error, result.Output)
	}
}
