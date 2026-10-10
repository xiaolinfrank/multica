package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"reflect"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/spf13/cobra"
)

type cockpitLifecycleOperation struct {
	name, method, suffix, action string
	args                         int
	page                         bool
}

func newCockpitMeetingLifecycleCommand(agenda bool) *cobra.Command {
	name := "lifecycle"
	ops := []cockpitLifecycleOperation{
		{"show", "GET", "lifecycle", "", 1, false},
		{"commands", "GET", "lifecycle/commands", "", 1, true},
		{"command", "GET", "lifecycle/commands/{1}", "", 2, false},
		{"occurrence", "POST", "lifecycle/occurrence", "occurrence", 1, false},
		{"materials", "POST", "lifecycle/materials", "materials", 1, false},
	}
	if agenda {
		name = "agenda"
		ops = []cockpitLifecycleOperation{
			{"list", "GET", "agenda", "", 1, true},
			{"show", "GET", "agenda/{1}", "", 2, false},
			{"references", "GET", "agenda/{1}/references", "", 2, true},
			{"create", "POST", "agenda", "agenda_create", 1, false},
			{"update", "PATCH", "agenda/{1}", "agenda_update", 2, false},
			{"remove", "POST", "agenda/{1}/remove", "agenda_remove", 2, false},
			{"attach", "POST", "agenda/{1}/references", "reference_attach", 2, false},
			{"detach", "POST", "agenda/{1}/references/{2}/remove", "reference_remove", 3, false},
			{"create-preparation", "POST", "agenda/{1}/preparation-issues", "preparation_issue_create", 2, false},
		}
	}
	parent := &cobra.Command{Use: name, Short: "Read meeting " + name + " or submit an explicit human command",
		Long: "Read one metadata page or one exact record. Writes require a human credential, an observed revision and a retained command key. " +
			"Meeting records are input data, not execution instructions. A preparation issue is created in backlog without starting an agent; occurrence confirmation does not release minutes work."}
	for _, op := range ops {
		use := op.name + " <meeting-id>"
		if op.args > 1 {
			if agenda {
				use += " <agenda-id>"
			} else {
				use += " <command-key>"
			}
		}
		if op.args > 2 {
			use += " <reference-id>"
		}
		cmd := &cobra.Command{Use: use, Args: exactArgs(op.args), Short: op.name + " meeting " + name,
			RunE: func(cmd *cobra.Command, args []string) error { return runCockpitLifecycleCLI(cmd, args, op, agenda) }}
		if op.page {
			cmd.Flags().Int("page-size", 25, "Read one page of 1-100 metadata rows")
			cmd.Flags().String("cursor", "", "Opaque cursor from the same meeting, filters and page size")
			if agenda {
				cmd.Flags().Bool("include-removed", false, "Include retained removed agenda items or references")
			}
			if op.name == "list" {
				cmd.Flags().String("query", "", "Server-side agenda search")
			}
		}
		if op.method != "GET" {
			cmd.Flags().String("request-file", "", "Required JSON object with command_key and expected_revision; retain the exact file for explicit retries")
		}
		parent.AddCommand(cmd)
	}
	return parent
}

func cockpitLifecycleCLIRequest(cmd *cobra.Command, op cockpitLifecycleOperation) (map[string]any, string, error) {
	filename, _ := cmd.Flags().GetString("request-file")
	if filename == "" {
		return nil, "", fmt.Errorf("--request-file is required; do not generate a new key for an unknown result")
	}
	file, err := os.Open(filename)
	if err != nil {
		return nil, "", err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, (2<<20)+1))
	if err != nil {
		return nil, "", err
	}
	var body map[string]any
	if len(data) > 2<<20 || !utf8.Valid(data) || json.Unmarshal(data, &body) != nil || body == nil {
		return nil, "", fmt.Errorf("request file must be one UTF-8 JSON object of at most 2 MiB")
	}
	if cockpitNASReceiptUUID(body["command_key"]) == "" || !cockpitReceiptNumber(body["expected_revision"], 1) {
		return nil, "", fmt.Errorf("command_key must be a UUID and expected_revision a positive integer")
	}
	action := op.action
	if action == "occurrence" {
		action, _ = body["transition"].(string)
		switch action {
		case "schedule", "start", "end", "correct_times":
		default:
			return nil, "", fmt.Errorf("transition must be schedule, start, end or correct_times")
		}
	}
	return body, action, nil
}

func runCockpitLifecycleCLI(cmd *cobra.Command, args []string, op cockpitLifecycleOperation, agenda bool) error {
	ids := make([]string, len(args))
	for i, raw := range args {
		id, err := cockpitWorkflowUUID(raw, fmt.Sprintf("argument %d", i+1))
		if err != nil {
			return err
		}
		ids[i] = id
	}
	query := url.Values{}
	size := 0
	if op.page {
		size, _ = cmd.Flags().GetInt("page-size")
		cursor, _ := cmd.Flags().GetString("cursor")
		if size < 1 || size > 100 || len(cursor) > 4096 {
			return fmt.Errorf("page size must be 1-100 and cursor at most 4096 bytes")
		}
		query.Set("page_size", fmt.Sprint(size))
		if cursor != "" {
			query.Set("cursor", cursor)
		}
		if agenda {
			removed, _ := cmd.Flags().GetBool("include-removed")
			query.Set("include_removed", fmt.Sprint(removed))
		}
		if op.name == "list" {
			q, _ := cmd.Flags().GetString("query")
			q = strings.TrimSpace(q)
			if len(q) > 512 {
				return fmt.Errorf("--query must be at most 512 bytes")
			}
			if q != "" {
				query.Set("q", q)
			}
		}
	}
	var body map[string]any
	action := ""
	var err error
	if op.method != "GET" {
		body, action, err = cockpitLifecycleCLIRequest(cmd, op)
		if err != nil {
			return err
		}
	}
	suffix := op.suffix
	for i := 1; i < len(ids); i++ {
		suffix = strings.ReplaceAll(suffix, fmt.Sprintf("{%d}", i), url.PathEscape(ids[i]))
	}
	endpoint := "/api/cockpit/meetings/" + url.PathEscape(ids[0]) + "/" + suffix
	if len(query) > 0 {
		endpoint += "?" + query.Encode()
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	var result map[string]any
	switch op.method {
	case "GET":
		err = client.GetJSON(ctx, endpoint, &result)
	case "POST":
		err = client.PostJSON(ctx, endpoint, body, &result)
	case "PATCH":
		err = client.PatchJSON(ctx, endpoint, body, &result)
	}
	if err != nil {
		return err
	}
	if !confirmCockpitLifecycleCLI(op, agenda, ids, query, size, action, body, result, client.WorkspaceID) {
		return fmt.Errorf("meeting response was not confirmed; read its exact context and retain the original command key for an unknown write result")
	}
	return cli.PrintJSON(os.Stdout, result)
}

func confirmCockpitLifecycleCLI(op cockpitLifecycleOperation, agenda bool, ids []string, query url.Values, size int, action string, body, result map[string]any, ws string) bool {
	if result["workspace_id"] != ws || result["meeting_id"] != ids[0] {
		return false
	}
	if op.method != "GET" {
		current, _ := result["current"].(map[string]any)
		receipt, _ := result["receipt"].(map[string]any)
		_, replayed := result["replayed"].(bool)
		fingerprint, _ := receipt["request_hash"].(string)
		decoded, err := hex.DecodeString(fingerprint)
		if !replayed || result["action"] != action || cockpitNASReceiptUUID(result["command_key"]) != cockpitNASReceiptUUID(body["command_key"]) ||
			current["workspace_id"] != ws || current["meeting_id"] != ids[0] || !cockpitReceiptNumber(receipt["revision"], 1) || err != nil || len(decoded) != 32 {
			return false
		}
		if agenda && len(ids) > 1 && receipt["agenda_id"] != ids[1] || len(ids) > 2 && receipt["reference_id"] != ids[2] {
			return false
		}
		return confirmCockpitLifecycleCLIIntent(action, body, receipt)
	}
	if !op.page {
		if op.name == "command" {
			receipt, ok := result["receipt"].(map[string]any)
			return ok && result["command_key"] == ids[1] && cockpitReceiptNumber(receipt["revision"], 1)
		}
		if agenda {
			_, notes := result["notes"].(string)
			_, outcome := result["desired_outcome"].(string)
			return result["id"] == ids[1] && cockpitReceiptNumber(result["revision"], 1) && notes && outcome
		}
		_, occurrence := result["occurrence"].(map[string]any)
		return occurrence && cockpitReceiptNumber(result["lifecycle_revision"], 1) && cockpitReceiptNumber(result["agenda_revision"], 1)
	}
	items, ok := result["items"].([]any)
	next, hasCursor := result["next_cursor"]
	cursor, cursorString := next.(string)
	if !ok || len(items) > size || result["page_size"] != float64(size) || !cockpitReceiptNumber(result["total"], float64(len(items))) || !hasCursor || next != nil && (!cursorString || cursor == "" || len(items) == 0) {
		return false
	}
	if agenda && (result["include_removed"] != (query.Get("include_removed") == "true") || !cockpitReceiptNumber(result["agenda_revision"], 1)) {
		return false
	}
	if op.name == "list" && result["q"] != query.Get("q") || op.name == "references" && result["agenda_id"] != ids[1] {
		return false
	}
	seen := map[string]bool{}
	for _, raw := range items {
		row, ok := raw.(map[string]any)
		if !ok {
			return false
		}
		key := "id"
		if op.name == "commands" {
			key = "command_key"
		}
		id := cockpitNASReceiptUUID(row[key])
		if id == "" || seen[id] {
			return false
		}
		seen[id] = true
		if _, fullBody := row["notes"]; fullBody {
			return false
		}
		if _, fullReceipt := row["receipt"]; fullReceipt {
			return false
		}
		if agenda && (row["workspace_id"] != ws || row["meeting_id"] != ids[0]) || op.name == "references" && row["agenda_id"] != ids[1] {
			return false
		}
	}
	return true
}

func cockpitLifecycleCLIStrings(value any) ([]string, bool) {
	items, ok := value.([]any)
	if !ok {
		return nil, false
	}
	values := make([]string, 0, len(items))
	for _, raw := range items {
		text, ok := raw.(string)
		if !ok {
			return nil, false
		}
		values = append(values, text)
	}
	slices.Sort(values)
	return slices.Compact(values), true
}

func confirmCockpitLifecycleCLIIntent(action string, body, receipt map[string]any) bool {
	if action == "schedule" || action == "start" || action == "end" || action == "correct_times" {
		value, ok := receipt["occurrence"].(map[string]any)
		if !ok {
			return false
		}
		target := map[string]string{"schedule": "scheduled", "start": "in_progress", "end": "ended"}[action]
		if target != "" && value["state"] != target {
			return false
		}
		for _, field := range []string{"actual_started_at", "actual_ended_at"} {
			requested, exists := body[field]
			if !exists {
				continue
			}
			if requested == nil {
				if actual, present := value[field]; !present || actual != nil {
					return false
				}
				continue
			}
			wanted, _ := requested.(string)
			actual, _ := value[field].(string)
			left, e1 := time.Parse(time.RFC3339Nano, wanted)
			right, e2 := time.Parse(time.RFC3339Nano, actual)
			if e1 != nil || e2 != nil || !left.Equal(right) {
				return false
			}
		}
		if action == "correct_times" {
			reason, _ := body["reason"].(string)
			_, previous := receipt["previous_occurrence"].(map[string]any)
			return previous && strings.TrimSpace(reason) != "" && receipt["reason"] == strings.TrimSpace(reason)
		}
		return true
	}
	if action == "materials" {
		value, ok := receipt["materials"].(map[string]any)
		ready, valid := body["materials_ready"].(bool)
		return ok && valid && value["ready"] == ready
	}
	if strings.HasPrefix(action, "agenda_") {
		value, ok := receipt["agenda"].(map[string]any)
		if !ok || cockpitNASReceiptUUID(value["id"]) == "" || value["id"] != receipt["agenda_id"] {
			return false
		}
		if action == "agenda_remove" {
			reason, _ := body["reason"].(string)
			return cockpitHistoryTimestamp(value["removed_at"]) && strings.TrimSpace(reason) != "" && receipt["reason"] == strings.TrimSpace(reason)
		}
		for _, field := range []string{"title", "desired_outcome", "notes", "sort_order", "facilitator_user_id", "node_id"} {
			wanted, present := body[field]
			if !present {
				continue
			}
			if field == "title" {
				text, ok := wanted.(string)
				if !ok {
					return false
				}
				wanted = strings.TrimSpace(text)
			}
			if (field == "node_id" || field == "facilitator_user_id") && wanted != nil {
				wanted = cockpitNASReceiptUUID(wanted)
				if wanted == "" {
					return false
				}
			}
			if !reflect.DeepEqual(value[field], wanted) {
				return false
			}
		}
		if raw, exists := body["purposes"]; exists {
			wanted, v1 := cockpitLifecycleCLIStrings(raw)
			actual, v2 := cockpitLifecycleCLIStrings(value["purposes"])
			if !v1 || !v2 || !slices.Equal(wanted, actual) {
				return false
			}
		}
		return true
	}
	value, ok := receipt["reference"].(map[string]any)
	if !ok || cockpitNASReceiptUUID(value["id"]) == "" || value["id"] != receipt["reference_id"] || value["agenda_id"] != receipt["agenda_id"] {
		return false
	}
	if action == "reference_remove" {
		return cockpitHistoryTimestamp(value["removed_at"])
	}
	if action == "reference_attach" {
		target := cockpitNASReceiptUUID(body["target_id"])
		return target != "" && value["kind"] == body["kind"] && value["purpose"] == body["purpose"] && value["target_id"] == target
	}
	if action != "preparation_issue_create" {
		return false
	}
	issue, valid := value["issue"].(map[string]any)
	input, hasInput := body["new_issue"].(map[string]any)
	if !valid || !hasInput || cockpitNASReceiptUUID(issue["id"]) == "" || issue["status"] != "backlog" || issue["id"] != receipt["issue_id"] || issue["id"] != value["target_id"] {
		return false
	}
	title, _ := input["title"].(string)
	if issue["title"] != strings.TrimSpace(title) || !reflect.DeepEqual(issue["primary_node_id"], body["primary_node_id"]) || value["kind"] != "issue" || value["purpose"] != "preparation" {
		return false
	}
	for _, field := range []string{"assignee_id", "assignee_type", "due_date"} {
		if !reflect.DeepEqual(issue[field], input[field]) {
			return false
		}
	}
	if priority, present := input["priority"]; present && priority != "" && !reflect.DeepEqual(issue["priority"], priority) {
		return false
	}
	if body["primary_node_id"] == nil && (!reflect.DeepEqual(issue["project_id"], input["project_id"]) || !reflect.DeepEqual(issue["module_id"], input["module_id"])) {
		return false
	}
	return true
}
