package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"reflect"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/spf13/cobra"
)

type cockpitInputCLIOperation struct {
	name, method, path, args, action string
	page                             bool
}

func newCockpitInputCommand() *cobra.Command {
	root := &cobra.Command{Use: "input", Short: "Register fixed materials and inspect their exact Issue and Run inputs", Long: "Read one bounded page, register fixed materials, or recover an original command. Keep the same request file and command key after an uncertain response; use the exact command lookup before explicitly retrying. Registration and manifest commands do not dispatch an Agent. A ready file is not a human review decision."}
	ops := []cockpitInputCLIOperation{
		{"capabilities", "GET", "/cockpit/inputs/capabilities", "", "", false},
		{"list", "GET", "/cockpit/inputs", "", "", true}, {"show", "GET", "/cockpit/inputs/{0}", "<input-id>", "", false},
		{"create", "POST", "/cockpit/inputs", "", "input_create", false}, {"create-command", "GET", "/cockpit/inputs/commands/{0}", "<command-key>", "input_create", false},
		{"edit", "PATCH", "/cockpit/inputs/{0}", "<input-id>", "", false}, {"archive", "POST", "/cockpit/inputs/{0}/archive", "<input-id>", "", false},
		{"versions", "GET", "/cockpit/inputs/{0}/versions", "<input-id>", "", true}, {"version", "GET", "/cockpit/inputs/{0}/versions/{1}", "<input-id> <version-id>", "", false},
		{"submit", "POST", "/cockpit/inputs/{0}/versions", "<input-id>", "input_version_submit", false}, {"version-command", "GET", "/cockpit/inputs/{0}/version-commands/{1}", "<input-id> <command-key>", "input_version_submit", false},
		{"transfers", "GET", "/cockpit/inputs/{0}/versions/{1}/transfers", "<input-id> <version-id>", "", true}, {"transfer", "GET", "/cockpit/inputs/{0}/versions/{1}/transfers/{2}", "<input-id> <version-id> <transfer-id>", "", false},
		{"restart", "POST", "/cockpit/inputs/{0}/versions/{1}/restart", "<input-id> <version-id>", "input_transfer_restart", false}, {"transfer-command", "GET", "/cockpit/inputs/{0}/versions/{1}/transfer-commands/{2}", "<input-id> <version-id> <command-key>", "input_transfer_restart", false},
		{"finalize", "POST", "/cockpit/inputs/{0}/versions/{1}/transfers/{2}/finalize", "<input-id> <version-id> <transfer-id>", "input_transfer_finalize", false}, {"abandon", "POST", "/cockpit/inputs/{0}/versions/{1}/transfers/{2}/abandon", "<input-id> <version-id> <transfer-id>", "input_transfer_abandon", false},
		{"session-command", "GET", "/cockpit/inputs/{0}/versions/{1}/transfers/{2}/commands/{3}", "<input-id> <version-id> <transfer-id> <command-key>", "transfer_command", false},
		{"verify", "POST", "/cockpit/inputs/{0}/versions/{1}/verify", "<input-id> <version-id>", "", false}, {"download-link", "GET", "/cockpit/inputs/{0}/versions/{1}/download-link", "<input-id> <version-id>", "", false},
		{"attachments", "GET", "/cockpit/issues/{0}/input-attachments", "<issue-id>", "", true},
		{"manifest", "GET", "/cockpit/issues/{0}/input-manifest", "<issue-id>", "", false}, {"save-manifest", "PUT", "/cockpit/issues/{0}/input-manifest", "<issue-id>", "input_manifest_save", false},
		{"manifest-command", "GET", "/cockpit/issues/{0}/input-manifest/commands/{1}", "<issue-id> <command-key>", "input_manifest_save", false}, {"manifest-versions", "GET", "/cockpit/issues/{0}/input-manifest/versions", "<issue-id>", "", true},
		{"manifest-version", "GET", "/cockpit/issues/{0}/input-manifest/versions/{1}", "<issue-id> <manifest-version-id>", "", false}, {"manifest-items", "GET", "/cockpit/issues/{0}/input-manifest/versions/{1}/items", "<issue-id> <manifest-version-id>", "", true},
		{"run-manifest", "GET", "/tasks/{0}/input-manifest", "<task-id>", "", false},
		{"spaces", "GET", "/cockpit/input-spaces", "", "", false}, {"browse", "POST", "/cockpit/input-spaces/{0}/entries", "<root-id>", "", false},
	}
	for _, op := range ops {
		command := &cobra.Command{Use: strings.TrimSpace(op.name + " " + op.args), Args: exactArgs(len(strings.Fields(op.args))), Short: op.name + " fixed input materials", RunE: func(cmd *cobra.Command, args []string) error { return runCockpitInputCLI(cmd, args, op) }}
		command.Flags().Bool("json", false, "Print the scoped response as JSON")
		if op.page {
			command.Flags().Int("page-size", 25, "One page of 1-100 records")
			command.Flags().String("cursor", "", "Continuation from this exact scope and page size")
		}
		if op.method != "GET" && op.name != "verify" {
			command.Flags().String("request-file", "", "One UTF-8 JSON object, at most 256 KiB; retain the exact command")
		}
		if op.name == "list" {
			for _, name := range []string{"project-id", "origin-issue-id"} {
				command.Flags().String(name, "", "Optional exact scope UUID")
			}
			command.Flags().String("archive", "active", "active, archived or all")
			command.Flags().String("source-kind", "", "upload, nas_file, attachment or artifact_version")
			command.Flags().StringArray("id", nil, "Select an exact input UUID; repeat up to 100 times")
		}
		if op.name == "list" || op.name == "attachments" {
			command.Flags().String("query", "", "Literal title or filename prefix within this scope")
		}
		root.AddCommand(command)
	}
	upload := &cobra.Command{Use: "upload-bytes <input-id> <version-id> <transfer-id>", Args: exactArgs(3), Short: "Send the complete local file to an existing upload session; does not finalize", RunE: runCockpitInputUploadCLI}
	upload.Flags().String("file", "", "Local regular file matching the declared session size")
	upload.Flags().Int64("revision", 0, "Exact observed transfer revision")
	root.AddCommand(upload)
	return root
}
func cockpitInputCLIQuery(cmd *cobra.Command, op cockpitInputCLIOperation) (url.Values, int, error) {
	query := url.Values{}
	size := 0
	if op.page {
		size, _ = cmd.Flags().GetInt("page-size")
		cursor, _ := cmd.Flags().GetString("cursor")
		if size < 1 || size > 100 || len(cursor) > 4096 {
			return nil, 0, fmt.Errorf("page size must be 1-100 and cursor at most 4096 bytes")
		}
		query.Set("page_size", strconv.Itoa(size))
		if cursor != "" {
			query.Set("cursor", cursor)
		}
	}
	for _, name := range []string{"project-id", "origin-issue-id"} {
		if cmd.Flags().Lookup(name) != nil && cmd.Flags().Changed(name) {
			raw, _ := cmd.Flags().GetString(name)
			id, err := cockpitWorkflowUUID(raw, "--"+name)
			if err != nil {
				return nil, 0, err
			}
			query.Set(strings.ReplaceAll(name, "-", "_"), id)
		}
	}
	for _, name := range []string{"query", "archive", "source-kind", "purpose"} {
		if cmd.Flags().Lookup(name) != nil {
			v, _ := cmd.Flags().GetString(name)
			if !utf8.ValidString(v) || len(v) > 512 {
				return nil, 0, fmt.Errorf("--%s exceeds its text limit", name)
			}
			if v != "" {
				key := strings.ReplaceAll(name, "-", "_")
				if name == "query" {
					key = "q"
				}
				query.Set(key, v)
			}
		}
	}
	if cmd.Flags().Lookup("include-removed") != nil {
		value, _ := cmd.Flags().GetBool("include-removed")
		query.Set("include_removed", strconv.FormatBool(value))
	}
	if cmd.Flags().Lookup("id") != nil {
		ids, _ := cmd.Flags().GetStringArray("id")
		if len(ids) > 100 {
			return nil, 0, fmt.Errorf("select at most 100 input IDs")
		}
		seen := map[string]bool{}
		for _, raw := range ids {
			id, err := cockpitWorkflowUUID(raw, "--id")
			if err != nil {
				return nil, 0, err
			}
			if seen[id] {
				return nil, 0, fmt.Errorf("selected input IDs must be unique")
			}
			seen[id] = true
			query.Add("ids", id)
		}
	}
	return query, size, nil
}
func cockpitInputCLIRequest(cmd *cobra.Command, op cockpitInputCLIOperation) (map[string]any, error) {
	if op.name == "verify" {
		return nil, nil
	}
	filename, _ := cmd.Flags().GetString("request-file")
	if filename == "" {
		return nil, fmt.Errorf("--request-file is required; preserve it after an uncertain response")
	}
	file, err := os.Open(filename)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, (256<<10)+1))
	if err != nil {
		return nil, err
	}
	var body map[string]any
	if len(data) > 256<<10 || !utf8.Valid(data) || json.Unmarshal(data, &body) != nil || body == nil {
		return nil, fmt.Errorf("input request must contain one UTF-8 JSON object of at most 256 KiB")
	}
	if initial, exists := body["initial_reference"]; exists && initial != nil {
		return nil, fmt.Errorf("meeting input references are no longer supported; use the meeting directory or an Issue input manifest")
	}
	if op.action != "" && cockpitNASReceiptUUID(body["command_key"]) == "" {
		return nil, fmt.Errorf("an original command_key UUID is required")
	}
	switch op.name {
	case "edit", "archive", "submit", "restart", "finalize", "abandon":
		if !cockpitReceiptNumber(body["expected_revision"], 1) {
			return nil, fmt.Errorf("the positive observed expected_revision is required")
		}
	case "save-manifest":
		if !cockpitReceiptNumber(body["expected_revision"], 0) {
			return nil, fmt.Errorf("the observed manifest expected_revision is required")
		}
	}
	return body, nil
}
func runCockpitInputCLI(cmd *cobra.Command, args []string, op cockpitInputCLIOperation) error {
	ids := make([]string, len(args))
	path := "/api" + op.path
	for i, raw := range args {
		id, err := cockpitWorkflowUUID(raw, fmt.Sprintf("argument %d", i+1))
		if err != nil {
			return err
		}
		ids[i] = id
		path = strings.ReplaceAll(path, fmt.Sprintf("{%d}", i), url.PathEscape(id))
	}
	query, size, err := cockpitInputCLIQuery(cmd, op)
	if err != nil {
		return err
	}
	if len(query) > 0 {
		path += "?" + query.Encode()
	}
	var body map[string]any
	if op.method != "GET" {
		body, err = cockpitInputCLIRequest(cmd, op)
		if err != nil {
			return err
		}
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(cmd.Context())
	defer cancel()
	var result map[string]any
	var request any
	if body != nil {
		request = body
	}
	if err = client.CockpitInputJSON(ctx, op.method, path, request, &result); err != nil {
		return err
	}
	if !confirmCockpitInputCLI(op, ids, body, result, client.WorkspaceID, size) {
		return fmt.Errorf("input response was not confirmed; retain the original command and read its exact receipt before retrying")
	}
	return cli.PrintJSON(os.Stdout, result)
}
func cockpitInputCLIPage(result map[string]any, size int) bool {
	items, ok := result["items"].([]any)
	if !ok || len(items) > size || result["page_size"] != float64(size) || !cockpitReceiptNumber(result["total"], float64(len(items))) {
		return false
	}
	cursor, exists := result["next_cursor"]
	if !exists {
		return false
	}
	if cursor != nil {
		value, ok := cursor.(string)
		if !ok || value == "" || len(items) == 0 {
			return false
		}
	}
	return true
}
func confirmCockpitInputCLI(op cockpitInputCLIOperation, ids []string, body, result map[string]any, ws string, size int) bool {
	if result["workspace_id"] != ws {
		return false
	}
	if op.action != "" {
		receipt, ok := result["receipt"].(map[string]any)
		if !ok || !cockpitPreparationCLIHash(receipt["request_hash"]) {
			return false
		}
		action, _ := result["action"].(string)
		if op.action == "transfer_command" {
			if action != "input_transfer_finalize" && action != "input_transfer_abandon" {
				return false
			}
		} else if action != op.action {
			return false
		}
		key := body["command_key"]
		if op.method == "GET" {
			key = ids[len(ids)-1]
		}
		if result["command_key"] != key || receipt["command_key"] != key || cockpitNASReceiptUUID(key) == "" {
			return false
		}
		if strings.HasPrefix(op.path, "/cockpit/inputs/{0}") && (result["input_id"] != ids[0] || receipt["input_id"] != ids[0]) {
			return false
		}
		if strings.Contains(op.path, "/versions/{1}/") && (result["version_id"] != ids[1] || receipt["version_id"] != ids[1]) {
			return false
		}
		if strings.Contains(op.path, "/transfers/{2}/") && receipt["transfer_id"] != ids[2] {
			return false
		}
		if strings.HasPrefix(op.path, "/cockpit/issues/{0}") && receipt["issue_id"] != ids[0] {
			return false
		}
		if op.method == "GET" {
			return true
		}
		switch op.name {
		case "create":
			title, _ := body["title"].(string)
			return cockpitNASReceiptUUID(receipt["input_id"]) != "" && receipt["title"] == strings.TrimSpace(title) && receipt["description"] == cockpitInputCLIText(body["description"]) && reflect.DeepEqual(receipt["project_id"], body["project_id"]) && reflect.DeepEqual(receipt["origin_issue_id"], body["origin_issue_id"])
		case "submit":
			if !cockpitInputCLISourceMatches(receipt["source"], body["source"]) || cockpitNASReceiptUUID(receipt["version_id"]) == "" {
				return false
			}
			return true
		case "restart":
			return receipt["mode"] == body["mode"] && reflect.DeepEqual(receipt["replaces_transfer_id"], body["previous_transfer_id"]) && cockpitNASReceiptUUID(receipt["transfer_id"]) != ""
		case "finalize":
			return receipt["content_hash"] == body["expected_content_hash"] && receipt["state"] == "verified"
		case "abandon":
			reason, _ := body["reason"].(string)
			return receipt["reason"] == strings.TrimSpace(reason) && receipt["state"] == "abandoned"
		case "save-manifest":
			return cockpitNASReceiptUUID(receipt["manifest_version_id"]) != "" && cockpitPreparationCLIHash(receipt["manifest_hash"]) && reflect.DeepEqual(receipt["items"], body["items"]) && receipt["note"] == cockpitInputCLIText(body["note"])
		}
		return false
	}
	if op.page && !cockpitInputCLIPage(result, size) {
		return false
	}
	if op.page {
		seen := map[string]bool{}
		for _, raw := range result["items"].([]any) {
			row, ok := raw.(map[string]any)
			if !ok {
				return false
			}
			key := cockpitNASReceiptUUID(row["id"])
			if op.name == "manifest-items" {
				if !cockpitReceiptNumber(row["position"], 0) || !cockpitPreparationCLIHash(row["content_hash"]) || cockpitNASReceiptUUID(row["input_version_id"]) == "" {
					return false
				}
				key = fmt.Sprint(row["position"])
			}
			if key == "" || seen[key] {
				return false
			}
			seen[key] = true
			if value, exists := row["workspace_id"]; exists && value != ws {
				return false
			}
			if (op.name == "versions" || op.name == "transfers") && row["input_id"] != ids[0] {
				return false
			}
			if op.name == "transfers" && row["version_id"] != ids[1] {
				return false
			}
			if (op.name == "attachments" || op.name == "manifest-versions") && row["issue_id"] != ids[0] {
				return false
			}
		}
	}
	if strings.HasPrefix(op.path, "/cockpit/inputs/{0}") {
		if op.name == "show" || op.name == "edit" || op.name == "archive" {
			if result["id"] != ids[0] {
				return false
			}
		} else if result["input_id"] != ids[0] {
			return false
		}
	}
	if strings.Contains(op.path, "/versions/{1}") {
		switch op.name {
		case "version":
			version, _ := result["version"].(map[string]any)
			if version["id"] != ids[1] || version["workspace_id"] != ws || version["input_id"] != ids[0] {
				return false
			}
		case "verify":
			if result["id"] != ids[1] {
				return false
			}
		default:
			if result["version_id"] != ids[1] {
				return false
			}
		}
	}
	if op.name == "transfer" && result["id"] != ids[2] {
		return false
	}
	if strings.HasPrefix(op.path, "/cockpit/issues/{0}") {
		if op.name == "manifest" {
			issue, _ := result["issue"].(map[string]any)
			if issue["id"] != ids[0] {
				return false
			}
		} else if result["issue_id"] != ids[0] {
			return false
		}
	}
	if op.name == "manifest-version" && result["id"] != ids[1] || op.name == "manifest-items" && result["manifest_version_id"] != ids[1] || op.name == "run-manifest" && result["task_id"] != ids[0] || op.name == "browse" && result["root_id"] != ids[0] {
		return false
	}
	if op.name == "edit" || op.name == "archive" {
		expected, ok := body["expected_revision"].(float64)
		if !ok || result["revision"] != expected+1 {
			return false
		}
		if op.name == "edit" && (result["title"] != strings.TrimSpace(cockpitInputCLIText(body["title"])) || result["description"] != cockpitInputCLIText(body["description"])) {
			return false
		}
		if op.name == "archive" {
			archived, ok := body["archived"].(bool)
			_, exists := result["archived_at"]
			if !ok || !exists || archived != (result["archived_at"] != nil) {
				return false
			}
		}
	}
	if op.name == "browse" {
		pageSize := body["page_size"]
		if pageSize == nil {
			pageSize = float64(25)
		}
		limit, ok := pageSize.(float64)
		rows, rowsOK := result["items"].([]any)
		if !ok || !rowsOK || limit < 1 || limit > 100 || result["page_size"] != pageSize || len(rows) > int(limit) || result["relative_directory"] != cockpitInputCLIText(body["relative_directory"]) || result["q"] != cockpitInputCLIText(body["q"]) || !cockpitPreparationCLIHash(result["root_config_hash"]) {
			return false
		}
		more, ok := result["has_more"].(bool)
		cursor, exists := result["next_cursor"]
		if !ok || !exists || more != (cursor != nil) {
			return false
		}
		if cursor != nil && cockpitInputCLIText(cursor) == "" {
			return false
		}
	}
	if op.name == "spaces" {
		rows, ok := result["items"].([]any)
		if !ok || len(rows) > 1 || result["total"] != float64(len(rows)) {
			return false
		}
		for _, raw := range rows {
			row, ok := raw.(map[string]any)
			if !ok || cockpitNASReceiptUUID(row["root_id"]) == "" {
				return false
			}
		}
	}
	if op.name == "download-link" {
		raw, ok := result["url"].(string)
		if !ok || !cockpitPreparationCLIHash(result["content_hash"]) || !cockpitReceiptNumber(result["size_bytes"], 0) {
			return false
		}
		parsed, err := url.Parse(raw)
		if err != nil || parsed.IsAbs() || parsed.Host != "" || parsed.Path != "/api/cockpit/input-files/"+ids[1]+"/download" || parsed.Fragment != "" || len(parsed.Query()) != 1 || len(parsed.Query()["token"]) != 1 || parsed.Query().Get("token") == "" {
			return false
		}
	}
	return true
}
func runCockpitInputUploadCLI(cmd *cobra.Command, args []string) error {
	ids := make([]string, 3)
	for i, raw := range args {
		id, err := cockpitWorkflowUUID(raw, fmt.Sprintf("argument %d", i+1))
		if err != nil {
			return err
		}
		ids[i] = id
	}
	filename, _ := cmd.Flags().GetString("file")
	revision, _ := cmd.Flags().GetInt64("revision")
	if filename == "" || revision < 1 {
		return fmt.Errorf("--file and the positive observed --revision are required")
	}
	file, err := os.Open(filename)
	if err != nil {
		return err
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil {
		return err
	}
	if !stat.Mode().IsRegular() || stat.Size() > 500<<20 {
		return fmt.Errorf("select a regular file of at most 500 MiB")
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	var result map[string]any
	if err = client.UploadCockpitInputBytes(cmd.Context(), ids[0], ids[1], ids[2], revision, stat.Size(), file, &result); err != nil {
		return fmt.Errorf("upload result is unconfirmed; read the exact transfer before recovery: %w", err)
	}
	if result["workspace_id"] != client.WorkspaceID || result["input_id"] != ids[0] || result["version_id"] != ids[1] || result["transfer_id"] != ids[2] {
		return fmt.Errorf("upload response did not confirm this exact session; read it before recovery")
	}
	return cli.PrintJSON(os.Stdout, result)
}

func cockpitInputCLIText(value any) string { text, _ := value.(string); return text }
func cockpitInputCLISourceMatches(received, requested any) bool {
	receipt, ok := received.(map[string]any)
	if !ok {
		return false
	}
	body, ok := requested.(map[string]any)
	if !ok || receipt["kind"] != body["kind"] {
		return false
	}
	kind, _ := body["kind"].(string)
	field := kind
	original, ok := body[field].(map[string]any)
	if !ok {
		return false
	}
	current, ok := receipt[field].(map[string]any)
	if !ok {
		return false
	}
	keys := map[string]bool{}
	for key := range original {
		keys[key] = true
	}
	for key := range current {
		keys[key] = true
	}
	for key := range keys {
		want := original[key]
		if kind == "upload" && (key == "filename" || key == "content_type") {
			want = strings.TrimSpace(cockpitInputCLIText(want))
		}
		if !reflect.DeepEqual(current[key], want) {
			return false
		}
	}
	for _, branch := range []string{"upload", "nas_file", "attachment", "artifact_version"} {
		if branch != field && (receipt[branch] != nil || body[branch] != nil) {
			return false
		}
	}
	return true
}
