package main

import (
	"context"
	"encoding/hex"
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

type cockpitPreparationCLIOperation struct {
	name, path, arguments, action string
	post, page, search            bool
}

func newCockpitMeetingPreparationCommand() *cobra.Command {
	name := "preparation"
	ops := []cockpitPreparationCLIOperation{
		{"list", "preparation-operations", "<meeting-id>", "", false, true, false},
		{"show", "preparation-operations/{1}", "<meeting-id> <operation-id>", "", false, false, false},
		{"effects", "preparation-operations/{1}/effects", "<meeting-id> <operation-id>", "", false, true, false},
		{"effect", "preparation-operations/{1}/effects/{2}", "<meeting-id> <operation-id> <effect-id>", "", false, false, false},
		{"execute", "preparation-operations/{1}/effects/{2}/apply", "<meeting-id> <operation-id> <effect-id>", "effect", true, false, false},
		{"control", "preparation-operations/{1}/control", "<meeting-id> <operation-id>", "control", true, false, false},
		{"authorization", "preparation-operations/{1}/effects/{2}/authorization-preview", "<meeting-id> <operation-id> <effect-id>", "", false, false, false},
		{"reauthorize", "preparation-operations/{1}/effects/{2}/reauthorize", "<meeting-id> <operation-id> <effect-id>", "preparation_reauthorize", true, false, false},
		{"impact", "cancellation-impact", "<meeting-id>", "", false, true, true},
		{"runs", "cancellation-impact/{1}/runs", "<meeting-id> <issue-id>", "", false, true, false},
		{"cancellation-preview", "cancellation/preview", "<meeting-id>", "preview", true, false, false},
		{"cancel", "cancellation", "<meeting-id>", "cancel", true, false, false},
		{"dispose", "cancellation/dispositions", "<meeting-id>", "preparation_dispose", true, false, false},
		{"basis", "operation-basis", "<meeting-id>", "", false, false, false},
		{"disposition", "lifecycle/disposition", "<meeting-id>", "disposition", true, false, false},
	}
	parent := &cobra.Command{Use: name, Short: "Read meeting " + name + " and submit explicit preparation commands",
		Long: "Reads return one bounded page or one exact record as JSON. Writes require a human credential and an explicit request file. " +
			"Keep command keys and authorization revisions after uncertain responses; read the exact command or effect before retrying. " +
			"Cancellation plans retain their explicit effect receipts. They never start an agent or provision NAS folders."}
	for _, op := range ops {
		cmd := &cobra.Command{Use: strings.TrimSpace(op.name + " " + op.arguments), Args: exactArgs(len(strings.Fields(op.arguments))),
			Short: op.name + " meeting " + name, RunE: func(cmd *cobra.Command, args []string) error {
				return runCockpitPreparationCLI(cmd, args, op)
			}}
		cmd.Flags().Bool("json", false, "Print the confirmed API response as JSON")
		if op.post {
			cmd.Flags().String("request-file", "", "UTF-8 JSON request; retain this exact file until the result is confirmed")
		}
		if op.page {
			cmd.Flags().Int("page-size", 25, "One page of 1-100 items; no automatic pagination")
			cmd.Flags().String("cursor", "", "Continuation for the same scope and filters")
		}
		if op.search {
			cmd.Flags().String("query", "", "Search metadata (up to 512 bytes)")
		}
		parent.AddCommand(cmd)
	}
	return parent
}

func cockpitPreparationCLIRequest(cmd *cobra.Command, op cockpitPreparationCLIOperation) (map[string]any, string, error) {
	filename, _ := cmd.Flags().GetString("request-file")
	if filename == "" {
		return nil, "", fmt.Errorf("--request-file is required; retain the original command and authorization keys after an unknown result")
	}
	f, err := os.Open(filename)
	if err != nil {
		return nil, "", err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, (1<<20)+1))
	if err != nil {
		return nil, "", err
	}
	var body map[string]any
	if len(data) > 1<<20 || !utf8.Valid(data) || json.Unmarshal(data, &body) != nil || body == nil {
		return nil, "", fmt.Errorf("request file must be one UTF-8 JSON object of at most 1 MiB")
	}
	action := op.action
	if action == "preview" {
		return body, action, nil
	}
	if cockpitNASReceiptUUID(body["command_key"]) == "" {
		return nil, "", fmt.Errorf("command_key must be a UUID")
	}
	if action == "effect" {
		if cockpitNASReceiptUUID(body["authorization_key"]) == "" || !cockpitReceiptNumber(body["authorization_revision"], 1) {
			return nil, "", fmt.Errorf("execute requires the observed authorization_key and positive authorization_revision")
		}
		return body, action, nil
	}
	if !cockpitReceiptNumber(body["expected_revision"], 1) {
		return nil, "", fmt.Errorf("expected_revision must be an observed positive integer")
	}
	if action == "control" || action == "disposition" {
		transition, _ := body["transition"].(string)
		allowed := []string{"pause", "resume", "skip", "claim"}
		if action == "disposition" {
			allowed = []string{"reinstate", "archive", "unarchive"}
		}
		if !slices.Contains(allowed, transition) {
			return nil, "", fmt.Errorf("unsupported %s transition", action)
		}
		if action == "control" {
			transition = "preparation_" + transition
		}
		action = transition
	}
	return body, action, nil
}

func runCockpitPreparationCLI(cmd *cobra.Command, args []string, op cockpitPreparationCLIOperation) error {
	ids := make([]string, len(args))
	for i, raw := range args {
		id, err := cockpitWorkflowUUID(raw, fmt.Sprintf("argument %d", i+1))
		if err != nil {
			return err
		}
		ids[i] = id
	}
	query, size := url.Values{}, 0
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
	}
	if op.search {
		q, _ := cmd.Flags().GetString("query")
		q = strings.TrimSpace(q)
		if len(q) > 512 {
			return fmt.Errorf("query exceeds 512 bytes")
		}
		query.Set("q", q)
	}
	var body map[string]any
	action := ""
	if op.post {
		var err error
		body, action, err = cockpitPreparationCLIRequest(cmd, op)
		if err != nil {
			return err
		}
	}
	path := op.path
	for i, id := range ids {
		path = strings.ReplaceAll(path, fmt.Sprintf("{%d}", i), url.PathEscape(id))
	}
	path = "/api/cockpit/meetings/" + ids[0] + "/" + path
	if len(query) > 0 {
		path += "?" + query.Encode()
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	var result map[string]any
	if op.post {
		err = client.PostJSON(ctx, path, body, &result)
	} else {
		err = client.GetJSON(ctx, path, &result)
	}
	if err != nil {
		return err
	}
	if !confirmCockpitPreparationCLI(result, body, ids, op, action, client.WorkspaceID, query, size) {
		return fmt.Errorf("preparation response was not confirmed; retain the original request and read its exact command/effect before retrying")
	}
	return cli.PrintJSON(os.Stdout, result)
}

func cockpitPreparationCLIHash(value any) bool {
	s, _ := value.(string)
	b, err := hex.DecodeString(s)
	return err == nil && len(b) == 32
}

func confirmCockpitPreparationCLI(result, body map[string]any, ids []string, op cockpitPreparationCLIOperation, action, ws string, query url.Values, size int) bool {
	if result["workspace_id"] != ws || result["meeting_id"] != ids[0] {
		return false
	}
	if op.page {
		items, ok := result["items"].([]any)
		next, exists := result["next_cursor"]
		cursor, cursorOK := next.(string)
		if !ok || len(items) > size || result["page_size"] != float64(size) || !cockpitReceiptNumber(result["total"], float64(len(items))) || !exists || next != nil && (!cursorOK || cursor == "" || len(items) == 0) {
			return false
		}
		if op.search && result["q"] != query.Get("q") {
			return false
		}
		if op.name == "effects" && result["operation_id"] != ids[1] || op.name == "runs" && result["issue_id"] != ids[1] {
			return false
		}
		seen := map[string]bool{}
		for _, raw := range items {
			row, ok := raw.(map[string]any)
			if !ok {
				return false
			}
			key := cockpitNASReceiptUUID(row["id"])
			if op.name == "impact" {
				issue, _ := row["issue"].(map[string]any)
				key = cockpitNASReceiptUUID(issue["id"])
			}
			if key == "" || seen[key] {
				return false
			}
			seen[key] = true
			if op.name == "list" && (row["workspace_id"] != ws || row["meeting_id"] != ids[0]) || op.name == "effects" && row["operation_id"] != ids[1] || op.name == "runs" && row["issue_id"] != ids[1] {
				return false
			}
		}
		return true
	}
	if !op.post {
		switch op.name {
		case "show":
			return result["id"] == ids[1] && cockpitReceiptNumber(result["revision"], 1)
		case "effect":
			effect, _ := result["effect"].(map[string]any)
			return result["operation_id"] == ids[1] && effect["id"] == ids[2] && effect["operation_id"] == ids[1]
		case "authorization":
			token, _ := result["context_token"].(string)
			allowed, known := result["can_confirm"].(bool)
			return known && (!allowed || strings.TrimSpace(token) != "") && result["operation_id"] == ids[1] && result["effect_id"] == ids[2] && cockpitPreparationCLIHash(result["fixed_intent_hash"]) && cockpitReceiptNumber(result["effect_revision"], 1)
		case "basis":
			return result["schema_version"] == float64(1)
		}
		return false
	}
	if action == "preview" {
		effects, ok := result["effects"].([]any)
		token, tokenOK := result["context_token"].(string)
		_, confirm := result["can_confirm"].(bool)
		if !ok || len(effects) > 50 || !tokenOK || token == "" || !confirm {
			return false
		}
		selected, valid := cockpitPreparationCLISelectedEffects(effects)
		if !valid || result["selected_total"] != float64(selected) {
			return false
		}
		return result["intent"] == "cancel" || result["intent"] == "append_disposition"
	}
	receipt, _ := result["receipt"].(map[string]any)
	current, _ := result["current"].(map[string]any)
	_, replayed := result["replayed"].(bool)
	if !replayed || result["command_key"] != body["command_key"] || !cockpitPreparationCLIHash(receipt["request_hash"]) {
		return false
	}
	if current["workspace_id"] != ws || current["meeting_id"] != ids[0] {
		return false
	}
	if action == "effect" {
		if !cockpitPreparationCLIHash(receipt["facts_hash"]) || !cockpitHistoryTimestamp(receipt["applied_at"]) {
			return false
		}
		if result["operation_id"] != ids[1] || result["effect_id"] != ids[2] || current["id"] != ids[1] || receipt["effect_id"] != ids[2] || receipt["command_key"] != body["command_key"] || receipt["authorization_key"] != body["authorization_key"] || receipt["authorization_revision"] != body["authorization_revision"] {
			return false
		}
		if receipt["kind"] == "stop_run" {
			status, _ := receipt["run_status"].(string)
			changed, ok := receipt["changed"].(bool)
			return ok && cockpitNASReceiptUUID(receipt["run_id"]) != "" && slices.Contains([]string{"completed", "failed", "cancelled"}, status) && (!changed || status == "cancelled")
		}
		kind, _ := receipt["kind"].(string)
		if kind == "link_meeting" && (cockpitNASReceiptUUID(receipt["target_meeting_id"]) == "" || cockpitNASReceiptUUID(receipt["issue_id"]) == "") {
			return false
		}
		return slices.Contains([]string{"cancel_issue", "change_due_date", "link_meeting"}, kind)
	}
	if result["action"] != action {
		return false
	}
	if op.name == "disposition" {
		return confirmCockpitPreparationCLIDisposition(action, body, receipt)
	}
	if receipt["operation_id"] != current["id"] || len(ids) > 1 && receipt["operation_id"] != ids[1] {
		return false
	}
	if token, exists := body["context_token"]; exists && receipt["context_token"] != token {
		return false
	}
	reason, _ := body["reason"].(string)
	if receipt["reason"] != strings.TrimSpace(reason) {
		return false
	}
	if action == "preparation_reauthorize" {
		grant, _ := receipt["authorization"].(map[string]any)
		previous, _ := receipt["previous_authorization"].(map[string]any)
		old, ok := previous["revision"].(float64)
		return ok && receipt["effect_id"] == ids[2] && grant["key"] == body["command_key"] && grant["context_token"] == body["context_token"] && grant["revision"] == old+1
	}
	if action == "cancel" || action == "preparation_dispose" {
		occurrence, _ := receipt["occurrence"].(map[string]any)
		choices, ok := body["issues"].([]any)
		runs, valid := cockpitLifecycleCLIStrings(body["run_ids"])
		if !ok || !valid {
			return false
		}
		selected := len(runs)
		for _, raw := range choices {
			choice, ok := raw.(map[string]any)
			if !ok {
				return false
			}
			if choice["action"] != "retain" {
				selected++
			}
		}
		return cockpitPreparationCLIEffectCount(receipt, selected) && receipt["kind"] == "cancel_preparation" && occurrence["state"] == "cancelled" && cockpitHistoryTimestamp(occurrence["cancelled_at"]) && (action != "cancel" || occurrence["cancelled_reason"] == strings.TrimSpace(reason))
	}
	switch action {
	case "preparation_pause":
		return receipt["state"] == "paused"
	case "preparation_resume":
		return receipt["state"] == "active"
	case "preparation_skip":
		return receipt["effect_id"] == body["effect_id"] && cockpitNASReceiptUUID(body["effect_id"]) != ""
	case "preparation_claim":
		return true
	}
	return false
}

func cockpitPreparationCLISelectedEffects(items []any) (int, bool) {
	selected, seen := 0, map[string]bool{}
	for _, raw := range items {
		item, ok := raw.(map[string]any)
		if !ok {
			return 0, false
		}
		id := cockpitNASReceiptUUID(item["slot_id"])
		chosen, valid := item["selected"].(bool)
		if !valid || id == "" || seen[id] {
			return 0, false
		}
		seen[id] = true
		if chosen {
			selected++
		}
	}
	return selected, true
}

func cockpitPreparationCLIEffectCount(receipt map[string]any, expected int) bool {
	ids, ok := receipt["effect_ids"].([]any)
	if !ok || len(ids) != expected || len(ids) > 50 {
		return false
	}
	seen := map[string]bool{}
	for _, raw := range ids {
		id := cockpitNASReceiptUUID(raw)
		if id == "" || seen[id] {
			return false
		}
		seen[id] = true
	}
	return true
}

func confirmCockpitPreparationCLIDisposition(action string, body, receipt map[string]any) bool {
	reason, _ := body["reason"].(string)
	if strings.TrimSpace(reason) == "" || receipt["reason"] != strings.TrimSpace(reason) {
		return false
	}
	if action == "reinstate" {
		occurrence, _ := receipt["occurrence"].(map[string]any)
		previous, _ := receipt["previous_occurrence"].(map[string]any)
		return previous["state"] == "cancelled" && occurrence["state"] == "scheduled" && occurrence["cancelled_at"] == nil && occurrence["cancelled_by"] == nil && occurrence["cancelled_reason"] == ""
	}
	archive, ok := receipt["archive"].(map[string]any)
	_, previous := receipt["previous_archive"].(map[string]any)
	if !ok || !previous {
		return false
	}
	if action == "archive" {
		return cockpitHistoryTimestamp(archive["archived_at"]) && archive["reason"] == strings.TrimSpace(reason)
	}
	return action == "unarchive" && archive["archived_at"] == nil && archive["archived_by"] == nil && archive["reason"] == ""
}
