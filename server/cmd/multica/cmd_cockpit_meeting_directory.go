package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/spf13/cobra"
)

type cockpitDirectoryCLIOperation struct {
	name, path, arguments, action string
	page                          bool
}

func newCockpitMeetingDirectoryCommand() *cobra.Command {
	parent := &cobra.Command{Use: "directory", Short: "Prepare and recover a meeting's fixed NAS directory plan",
		Long: "Read one bounded page or exact record. Preview is read-only; prepare registers a durable plan executed by the server. " +
			"Writes require a human credential or an authorized task token within a configured prepare_subpaths scope. " +
			"Keep the exact request and command key after an unknown result; read the command before explicitly retrying. " +
			"Leaving the CLI does not stop an accepted plan. Pause or abandon its remaining steps explicitly; existing directories remain."}
	ops := []cockpitDirectoryCLIOperation{
		{"roots", "/directory-roots", "", "", true},
		{"root", "/directory-roots/{0}", "<root-id>", "", false},
		{"summary", "/meetings/{0}/directory-preparation", "<meeting-id>", "", false},
		{"list", "/meetings/{0}/directory-preparations", "<meeting-id>", "", true},
		{"show", "/meetings/{0}/directory-preparations/{1}", "<meeting-id> <operation-id>", "", false},
		{"steps", "/meetings/{0}/directory-preparations/{1}/steps", "<meeting-id> <operation-id>", "", false},
		{"attempts", "/meetings/{0}/directory-preparations/{1}/steps/{2}/attempts", "<meeting-id> <operation-id> <step-id>", "", true},
		{"attempt", "/meetings/{0}/directory-preparations/{1}/steps/{2}/attempts/{3}", "<meeting-id> <operation-id> <step-id> <attempt-id>", "", false},
		{"command", "/meetings/{0}/lifecycle/commands/{1}", "<meeting-id> <command-key>", "", false},
		{"preview", "/meetings/{0}/directory-preparations/preview", "<meeting-id>", "preview", false},
		{"prepare", "/meetings/{0}/directory-preparations", "<meeting-id>", "directory_prepare", false},
		{"retry-preview", "/meetings/{0}/directory-preparations/{1}/retry-preview", "<meeting-id> <operation-id>", "preview", false},
		{"retry", "/meetings/{0}/directory-preparations/{1}/retry", "<meeting-id> <operation-id>", "directory_retry", false},
		{"control", "/meetings/{0}/directory-preparations/{1}/control", "<meeting-id> <operation-id>", "control", false},
	}
	for _, op := range ops {
		cmd := &cobra.Command{Use: strings.TrimSpace(op.name + " " + op.arguments), Args: exactArgs(len(strings.Fields(op.arguments))),
			Short: op.name + " meeting directory preparation", RunE: func(cmd *cobra.Command, args []string) error { return runCockpitDirectoryCLI(cmd, args, op) }}
		cmd.Flags().Bool("json", false, "Print the verified API response as JSON")
		if op.action != "" {
			cmd.Flags().String("request-file", "", "One UTF-8 JSON request of at most 64 KiB; retain the exact original command")
		}
		if op.page {
			cmd.Flags().Int("page-size", 25, "One page of 1-100 records; no automatic pagination")
			cmd.Flags().String("cursor", "", "Continuation for the same scope and page size")
		}
		parent.AddCommand(cmd)
	}
	return parent
}

func cockpitDirectoryCLIRequest(cmd *cobra.Command, op cockpitDirectoryCLIOperation) (map[string]any, string, error) {
	filename, _ := cmd.Flags().GetString("request-file")
	if filename == "" {
		return nil, "", fmt.Errorf("--request-file is required; do not replace an uncertain command key")
	}
	f, err := os.Open(filename)
	if err != nil {
		return nil, "", err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, (64<<10)+1))
	if err != nil {
		return nil, "", err
	}
	var body map[string]any
	if len(data) > 64<<10 || !utf8.Valid(data) || json.Unmarshal(data, &body) != nil || body == nil {
		return nil, "", fmt.Errorf("request file must be one UTF-8 JSON object of at most 64 KiB")
	}
	action := op.action
	if action == "preview" {
		return body, action, nil
	}
	if cockpitNASReceiptUUID(body["command_key"]) == "" || !cockpitReceiptNumber(body["expected_revision"], 1) {
		return nil, "", fmt.Errorf("command_key and the positive observed expected_revision are required")
	}
	if action == "control" {
		transition, _ := body["transition"].(string)
		if !slices.Contains([]string{"pause", "resume", "claim", "abandon"}, transition) {
			return nil, "", fmt.Errorf("unsupported directory control transition")
		}
		action = "directory_" + transition
	} else if !cockpitPreparationCLIHash(body["context_token"]) {
		return nil, "", fmt.Errorf("the exact preview context_token is required")
	}
	return body, action, nil
}

func runCockpitDirectoryCLI(cmd *cobra.Command, args []string, op cockpitDirectoryCLIOperation) error {
	ids := make([]string, len(args))
	for i, raw := range args {
		value, err := cockpitWorkflowUUID(raw, fmt.Sprintf("argument %d", i+1))
		if err != nil {
			return err
		}
		ids[i] = value
	}
	path := "/api/cockpit" + op.path
	for i, value := range ids {
		path = strings.ReplaceAll(path, fmt.Sprintf("{%d}", i), url.PathEscape(value))
	}
	size := 0
	if op.page {
		size, _ = cmd.Flags().GetInt("page-size")
		cursor, _ := cmd.Flags().GetString("cursor")
		if size < 1 || size > 100 || len(cursor) > 4096 {
			return fmt.Errorf("page size must be 1-100 and cursor at most 4096 bytes")
		}
		query := url.Values{"page_size": {fmt.Sprint(size)}}
		if cursor != "" {
			query.Set("cursor", cursor)
		}
		path += "?" + query.Encode()
	}
	var body map[string]any
	action := op.action
	if action != "" {
		var err error
		body, action, err = cockpitDirectoryCLIRequest(cmd, op)
		if err != nil {
			return err
		}
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	var result map[string]any
	if op.action != "" {
		err = client.PostJSON(ctx, path, body, &result)
	} else {
		err = client.GetJSON(ctx, path, &result)
	}
	if err != nil {
		return err
	}
	if !confirmCockpitDirectoryCLI(result, body, ids, op, action, client.WorkspaceID, size) {
		return fmt.Errorf("directory response was not confirmed; retain the exact request and read its original command before retrying")
	}
	return cli.PrintJSON(os.Stdout, result)
}

func cockpitDirectoryCLIIDs(value any, limit int) ([]string, bool) {
	items, ok := value.([]any)
	if !ok || len(items) > limit {
		return nil, false
	}
	ids, seen := make([]string, 0, len(items)), map[string]bool{}
	for _, item := range items {
		id := cockpitNASReceiptUUID(item)
		if id == "" || seen[id] {
			return nil, false
		}
		ids, seen[id] = append(ids, id), true
	}
	return ids, true
}

func confirmCockpitDirectoryCLI(result, body map[string]any, ids []string, op cockpitDirectoryCLIOperation, action, ws string, size int) bool {
	if result["workspace_id"] != ws || strings.HasPrefix(op.path, "/meetings/") && result["meeting_id"] != ids[0] {
		return false
	}
	if op.page || op.name == "steps" {
		items, ok := result["items"].([]any)
		limit := size
		if op.name == "steps" {
			limit = 32
		}
		if !ok || len(items) > limit || !cockpitReceiptNumber(result["total"], float64(len(items))) {
			return false
		}
		if op.page {
			next, exists := result["next_cursor"]
			cursor, stringOK := next.(string)
			if result["page_size"] != float64(size) || !exists || next != nil && (!stringOK || cursor == "" || len(items) == 0) {
				return false
			}
		} else if result["total"] != float64(len(items)) {
			return false
		}
		if (op.name == "steps" || op.name == "attempts") && result["operation_id"] != ids[1] || op.name == "attempts" && result["step_id"] != ids[2] {
			return false
		}
		seen := map[string]bool{}
		for _, raw := range items {
			row, ok := raw.(map[string]any)
			if !ok {
				return false
			}
			field := "id"
			if op.name == "roots" {
				field = "root_id"
			}
			id := cockpitNASReceiptUUID(row[field])
			if id == "" || seen[id] || op.name == "list" && (row["workspace_id"] != ws || row["meeting_id"] != ids[0]) || op.name == "steps" && row["operation_id"] != ids[1] || op.name == "attempts" && row["step_id"] != ids[2] {
				return false
			}
			seen[id] = true
		}
		return true
	}
	if op.action == "" {
		switch op.name {
		case "root":
			return result["root_id"] == ids[0]
		case "summary":
			binding, _ := result["binding"].(map[string]any)
			return cockpitReceiptNumber(binding["revision"], 1) && cockpitReceiptNumber(result["history_total"], 0)
		case "show":
			return result["id"] == ids[1] && cockpitReceiptNumber(result["revision"], 1)
		case "attempt":
			return result["operation_id"] == ids[1] && result["step_id"] == ids[2] && result["id"] == ids[3]
		case "command":
			envelope, _ := result["receipt"].(map[string]any)
			receipt, _ := envelope["directory"].(map[string]any)
			return result["command_key"] == ids[1] && cockpitNASReceiptUUID(result["directory_operation_id"]) != "" && receipt["directory_operation_id"] == result["directory_operation_id"] && cockpitPreparationCLIHash(receipt["request_hash"]) && receipt["request_hash"] == envelope["request_hash"]
		}
		return false
	}
	if action == "preview" {
		steps, ok := result["steps"].([]any)
		allowed, known := result["can_confirm"].(bool)
		if !ok || len(steps) > 32 || !known || allowed && (!cockpitPreparationCLIHash(result["context_token"]) || len(steps) == 0) {
			return false
		}
		if op.name == "retry-preview" {
			expected, valid := cockpitDirectoryCLIIDs(body["step_ids"], 32)
			actual, present := cockpitDirectoryCLIIDs(result["step_ids"], 32)
			return valid && present && len(expected) > 0 && len(expected) == len(actual) && len(steps) == len(expected) && result["operation_id"] == ids[1] && slices.Equal(cockpitDirectorySorted(expected), cockpitDirectorySorted(actual))
		}
		target, _ := result["target"].(map[string]any)
		binding, _ := result["observed_binding"].(map[string]any)
		return target["root_id"] == body["root_id"] && target["relative_directory"] == body["relative_directory"] && binding["revision"] == body["observed_binding_revision"] && binding["nas_dir"] == body["observed_nas_dir"] && result["bind_after_base"] == body["bind_after_base"]
	}
	if result["command_key"] != body["command_key"] || result["action"] != action {
		return false
	}
	receipt, _ := result["receipt"].(map[string]any)
	current, _ := result["current"].(map[string]any)
	opID := cockpitNASReceiptUUID(receipt["directory_operation_id"])
	stepIDs, valid := cockpitDirectoryCLIIDs(receipt["directory_step_ids"], 32)
	grant, _ := receipt["grant"].(map[string]any)
	if !valid || opID == "" || current["id"] != opID || current["workspace_id"] != ws || current["meeting_id"] != ids[0] || !cockpitPreparationCLIHash(receipt["request_hash"]) || !cockpitPreparationCLIHash(receipt["plan_hash"]) || current["plan_hash"] != receipt["plan_hash"] || len(ids) > 1 && opID != ids[1] {
		return false
	}
	if action == "directory_prepare" {
		target, _ := receipt["target"].(map[string]any)
		binding, _ := receipt["observed_binding"].(map[string]any)
		return len(stepIDs) > 0 && grant["command_key"] == body["command_key"] && receipt["context_token"] == body["context_token"] && target["root_id"] == body["root_id"] && target["relative_directory"] == body["relative_directory"] && binding["nas_dir"] == body["observed_nas_dir"] && binding["revision"] == body["observed_binding_revision"] && receipt["bind_after_base"] == body["bind_after_base"]
	}
	reason, _ := body["reason"].(string)
	if receipt["reason"] != strings.TrimSpace(reason) {
		return false
	}
	if action == "directory_retry" {
		expected, ok := cockpitDirectoryCLIIDs(body["step_ids"], 32)
		return ok && len(expected) > 0 && slices.Equal(cockpitDirectorySorted(expected), cockpitDirectorySorted(stepIDs)) && grant["command_key"] == body["command_key"] && receipt["context_token"] == body["context_token"]
	}
	if action == "directory_claim" {
		principal, _ := receipt["principal"].(map[string]any)
		return len(stepIDs) > 0 && grant["command_key"] == body["command_key"] && grant["kind"] == "human" && principal["source"] == "human" && receipt["responsible_user_id"] == principal["actor_id"]
	}
	return len(stepIDs) == 0 && (action == "directory_pause" && receipt["state"] == "paused" || action == "directory_resume" && receipt["state"] == "active" || action == "directory_abandon" && receipt["state"] == "abandoned")
}

func cockpitDirectorySorted(ids []string) []string {
	sorted := slices.Clone(ids)
	slices.Sort(sorted)
	return sorted
}
