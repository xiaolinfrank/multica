package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/spf13/cobra"
)

func addCockpitSurfaceFlags(cmd *cobra.Command, scope, page bool) {
	if scope {
		cmd.Flags().String("project-id", "", "Optional project UUID")
		cmd.Flags().String("module-id", "", "Optional module UUID; requires its project UUID")
	}
	if page {
		cmd.Flags().String("cursor", "", "Opaque continuation for this exact scope and page size")
		cmd.Flags().Int("page-size", 25, "One page of 1-100 items; never automatically fetches subsequent pages")
	}
	cmd.Flags().Bool("json", false, "Print the confirmed API response as JSON")
	cmd.Flags().String("output", "table", "Output format: table or json (--json is equivalent to --output json)")
}
func newCockpitSurfaceCommand(kind string) *cobra.Command {
	cmd := &cobra.Command{Use: kind, Args: exactArgs(0), Short: "Read the scoped cockpit " + kind, RunE: func(cmd *cobra.Command, args []string) error { return runCockpitSurface(cmd, args, kind) }}
	addCockpitSurfaceFlags(cmd, true, false)
	return cmd
}
func newCockpitMeetingPageCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "page", Args: exactArgs(0), Short: "Read one bounded page from the meeting register", RunE: func(cmd *cobra.Command, args []string) error { return runCockpitSurface(cmd, args, "meetings") }}
	addCockpitSurfaceFlags(cmd, true, true)
	cmd.Flags().String("q", "", "Search meeting metadata (up to 512 bytes)")
	cmd.Flags().String("from", "", "Inclusive calendar date YYYY-MM-DD")
	cmd.Flags().String("to", "", "Inclusive calendar date YYYY-MM-DD")
	cmd.Flags().String("node-id", "", "Optional node UUID; includes meetings linked to descendants")
	for _, flag := range []string{"party", "track", "kind", "status", "only"} {
		cmd.Flags().StringArray(flag, nil, "Repeat to select several values; commas stay inside each value")
	}
	return cmd
}
func newCockpitVersionCompareCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "compare <snapshot-id>", Args: exactArgs(1), Short: "Read one page of stable-UUID plan differences; does not restore or approve", RunE: func(cmd *cobra.Command, args []string) error { return runCockpitSurface(cmd, args, "diff") }}
	addCockpitSurfaceFlags(cmd, false, true)
	return cmd
}

func cockpitSurfaceScopeQuery(cmd *cobra.Command) (url.Values, error) {
	query := url.Values{}
	for _, flag := range []string{"project-id", "module-id"} {
		if cmd.Flags().Changed(flag) {
			value, _ := cmd.Flags().GetString(flag)
			id, err := cockpitWorkflowUUID(value, "--"+flag)
			if err != nil {
				return nil, err
			}
			query.Set(strings.ReplaceAll(flag, "-", "_"), id)
		}
	}
	if query.Get("module_id") != "" && query.Get("project_id") == "" {
		return nil, fmt.Errorf("--module-id requires --project-id")
	}
	return query, nil
}
func cockpitSurfaceQuery(cmd *cobra.Command, kind string) (url.Values, int, error) {
	query := url.Values{}
	var err error
	if kind != "diff" {
		query, err = cockpitSurfaceScopeQuery(cmd)
		if err != nil {
			return nil, 0, err
		}
	}
	size := 0
	if kind == "meetings" || kind == "diff" {
		size, _ = cmd.Flags().GetInt("page-size")
		if size < 1 || size > 100 {
			return nil, 0, fmt.Errorf("--page-size must be between 1 and 100")
		}
		query.Set("page_size", strconv.Itoa(size))
		cursor, _ := cmd.Flags().GetString("cursor")
		if len(cursor) > 4096 {
			return nil, 0, fmt.Errorf("--cursor exceeds 4096 bytes")
		}
		if cursor != "" {
			query.Set("cursor", cursor)
		}
	}
	if kind != "meetings" {
		return query, size, nil
	}
	search, _ := cmd.Flags().GetString("q")
	search = strings.TrimSpace(search)
	if len(search) > 512 {
		return nil, 0, fmt.Errorf("--q exceeds 512 bytes")
	}
	if search != "" {
		query.Set("q", search)
	}
	for _, flag := range []string{"from", "to"} {
		if cmd.Flags().Changed(flag) {
			value, _ := cmd.Flags().GetString(flag)
			if _, err := time.Parse("2006-01-02", value); err != nil {
				return nil, 0, fmt.Errorf("--%s requires YYYY-MM-DD", flag)
			}
			query.Set("date_"+flag, value)
		}
	}
	if query.Get("date_from") != "" && query.Get("date_to") != "" && query.Get("date_from") > query.Get("date_to") {
		return nil, 0, fmt.Errorf("--to precedes --from")
	}
	if cmd.Flags().Changed("node-id") {
		value, _ := cmd.Flags().GetString("node-id")
		id, e := cockpitWorkflowUUID(value, "--node-id")
		if e != nil {
			return nil, 0, e
		}
		query.Set("node_id", id)
	}
	for flag, key := range map[string]string{"party": "parties", "track": "tracks", "kind": "kinds", "status": "statuses", "only": "only"} {
		values, _ := cmd.Flags().GetStringArray(flag)
		if len(values) > 30 {
			return nil, 0, fmt.Errorf("--%s allows at most 30 values", flag)
		}
		for _, value := range values {
			if len(value) > 200 {
				return nil, 0, fmt.Errorf("--%s value exceeds 200 bytes", flag)
			}
			value = strings.TrimSpace(value)
			if flag == "only" && !slices.Contains([]string{"consensus", "folder", "links", "detected"}, value) {
				return nil, 0, fmt.Errorf("--only must be consensus, folder, links or detected")
			}
			query.Add(key, value)
		}
	}
	return query, size, nil
}

func cockpitNullableScope(value map[string]any, key, expected string, allowMissing bool) bool {
	actual, present := value[key]
	if expected != "" {
		return present && actual == expected
	}
	return (!present && allowMissing) || (present && actual == nil)
}
func confirmCockpitSurfaceScope(value map[string]any, ws string, q url.Values) bool {
	scope, ok := value["scope"].(map[string]any)
	return value["workspace_id"] == ws && ok && cockpitNullableScope(scope, "project_id", q.Get("project_id"), false) && cockpitNullableScope(scope, "module_id", q.Get("module_id"), false)
}
func confirmCockpitSurfaceContext(value map[string]any, ws string, q url.Values) bool {
	if !confirmCockpitSurfaceScope(value, ws, q) {
		return false
	}
	actor, ok := value["actor"].(map[string]any)
	if !ok || cockpitNASReceiptUUID(actor["user_id"]) == "" {
		return false
	}
	board, present := value["cockpit"]
	if !present {
		return false
	}
	if board == nil {
		return true
	}
	row, ok := board.(map[string]any)
	return ok && cockpitNASReceiptUUID(row["id"]) != "" && row["workspace_id"] == ws
}
func cockpitSurfaceItems(value map[string]any, key string, limit int) ([]any, bool) {
	items, ok := value[key].([]any)
	return items, ok && len(items) <= limit
}
func cockpitSurfacePage(value map[string]any, limit int) bool {
	items, ok := cockpitSurfaceItems(value, "items", limit)
	cursor, present := value["next_cursor"]
	text, isText := cursor.(string)
	return ok && cockpitReceiptNumber(value["total"], float64(len(items))) && present && (cursor == nil || (isText && text != "" && len(text) <= 4096))
}
func confirmCockpitPlanReceipt(value map[string]any, ws string, q url.Values) bool {
	if !confirmCockpitSurfaceContext(value, ws, q) || value["complete"] != true {
		return false
	}
	counts, ok := value["counts"].(map[string]any)
	if !ok {
		return false
	}
	nodeIDs := map[string]bool{}
	for _, pair := range []struct {
		key, count string
		limit      int
	}{{"nodes", "nodes", 5000}, {"payments", "payments", 25000}, {"milestones", "milestones", 2000}, {"node_index", "index_nodes", 20000}} {
		items, valid := cockpitSurfaceItems(value, pair.key, pair.limit)
		if !valid || !cockpitReceiptNumber(counts[pair.count], 0) || counts[pair.count] != float64(len(items)) {
			return false
		}
		seen := map[string]bool{}
		for _, entry := range items {
			row, yes := entry.(map[string]any)
			id := cockpitNASReceiptUUID(row["id"])
			if !yes || id == "" || seen[id] {
				return false
			}
			seen[id] = true
			if pair.key == "nodes" {
				nodeIDs[id] = true
			}
		}
	}
	context, ok := cockpitSurfaceItems(value, "context_node_ids", 5000)
	if !ok {
		return false
	}
	for _, id := range context {
		key, valid := id.(string)
		if !valid || !nodeIDs[key] {
			return false
		}
	}
	_, ok = cockpitSurfaceItems(value, "task_counts", 5000)
	return ok
}
func confirmCockpitMeetingPage(value map[string]any, ws string, q url.Values, size int) bool {
	if !confirmCockpitSurfaceScope(value, ws, q) || !cockpitSurfacePage(value, size) || !cockpitNullableScope(value, "node_id", q.Get("node_id"), false) || !cockpitNullableScope(value, "date_from", q.Get("date_from"), false) || !cockpitNullableScope(value, "date_to", q.Get("date_to"), false) {
		return false
	}
	for _, entry := range value["items"].([]any) {
		row, ok := entry.(map[string]any)
		if !ok || cockpitNASReceiptUUID(row["id"]) == "" {
			return false
		}
		if _, ok := row["title"].(string); !ok {
			return false
		}
		for _, field := range []string{"minutes", "decisions", "actions", "note"} {
			if _, present := row[field]; present {
				return false
			}
		}
	}
	return true
}
func cockpitHexDigest(value any) bool {
	text, ok := value.(string)
	decoded, err := hex.DecodeString(text)
	return ok && err == nil && len(decoded) == 32 && strings.ToLower(text) == text
}
func confirmCockpitDiffReceipt(value map[string]any, ws, id string, size int) bool {
	if value["workspace_id"] != ws || value["snapshot_id"] != id || value["scope"] != "workspace" || value["page_size"] != float64(size) || !cockpitSurfacePage(value, size) {
		return false
	}
	for _, key := range []string{"generated_at", "snapshot_created_at"} {
		stamp, ok := value[key].(string)
		if !ok {
			return false
		}
		if _, err := time.Parse(time.RFC3339Nano, stamp); err != nil {
			return false
		}
	}
	if cockpitNASReceiptUUID(value["snapshot_cockpit_id"]) == "" || !confirmCockpitOverviewCounts(value["snapshot_counts"], "nodes", "payments", "milestones") || !confirmCockpitOverviewCounts(value["current_counts"], "nodes", "payments", "milestones") || !confirmCockpitOverviewCounts(value["counts"], "added", "removed", "modified", "unchanged") {
		return false
	}
	comparable, ok := value["comparable"].(bool)
	reason, reasonOK := value["reason"].(string)
	if !ok || !reasonOK {
		return false
	}
	if !comparable {
		return reason != "" && value["total"] == float64(0) && len(value["items"].([]any)) == 0 && value["next_cursor"] == nil && value["comparison_token"] == ""
	}
	if reason != "" || value["snapshot_complete"] != true || value["current_complete"] != true || value["current_cockpit_id"] != value["snapshot_cockpit_id"] || !cockpitHexDigest(value["comparison_token"]) {
		return false
	}
	counts := value["counts"].(map[string]any)
	if counts["added"].(float64)+counts["removed"].(float64)+counts["modified"].(float64) != value["total"] {
		return false
	}
	for _, entry := range value["items"].([]any) {
		row, ok := entry.(map[string]any)
		if !ok || cockpitNASReceiptUUID(row["id"]) == "" || !slices.Contains([]string{"board", "node", "payment", "milestone"}, strVal(row, "entity_kind")) || !slices.Contains([]string{"added", "removed", "modified"}, strVal(row, "change")) {
			return false
		}
		changes, ok := row["field_changes"].([]any)
		if !ok || (row["change"] == "modified" && len(changes) == 0) || (row["change"] != "modified" && len(changes) != 0) {
			return false
		}
		for _, entry := range changes {
			field, ok := entry.(map[string]any)
			if !ok || strVal(field, "field") == "" {
				return false
			}
			for _, key := range []string{"before", "after"} {
				part, ok := field[key].(map[string]any)
				if !ok || !cockpitHexDigest(part["sha256"]) {
					return false
				}
				if _, ok := part["truncated"].(bool); !ok {
					return false
				}
				scalar, present := part["value"]
				if !present {
					return false
				}
				switch v := scalar.(type) {
				case nil, bool, float64:
				case string:
					if len([]rune(v)) > 512 {
						return false
					}
				default:
					return false
				}
			}
		}
	}
	return true
}

func runCockpitSurface(cmd *cobra.Command, args []string, kind string) error {
	query, size, err := cockpitSurfaceQuery(cmd, kind)
	if err != nil {
		return err
	}
	format, _ := cmd.Flags().GetString("output")
	asJSON, _ := cmd.Flags().GetBool("json")
	if format != "table" && format != "json" {
		return fmt.Errorf("--output must be table or json")
	}
	if asJSON && cmd.Flags().Changed("output") && format != "json" {
		return fmt.Errorf("--json conflicts with --output table")
	}
	endpoint := "/api/cockpit/" + kind
	id := ""
	if kind == "diff" {
		id, err = cockpitWorkflowUUID(args[0], "snapshot-id")
		if err != nil {
			return err
		}
		endpoint = "/api/cockpit/snapshots/" + id + "/diff"
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	if len(query) > 0 {
		endpoint += "?" + query.Encode()
	}
	var raw json.RawMessage
	if err = client.GetJSON(ctx, endpoint, &raw); err != nil {
		return err
	}
	var result map[string]any
	if err = json.Unmarshal(raw, &result); err != nil {
		return fmt.Errorf("invalid %s response: %w", kind, err)
	}
	valid := false
	switch kind {
	case "context":
		valid = confirmCockpitSurfaceContext(result, client.WorkspaceID, query)
	case "plan":
		valid = confirmCockpitPlanReceipt(result, client.WorkspaceID, query)
	case "meetings":
		valid = confirmCockpitMeetingPage(result, client.WorkspaceID, query, size)
	case "diff":
		valid = confirmCockpitDiffReceipt(result, client.WorkspaceID, id, size)
	}
	if !valid {
		return fmt.Errorf("%s response does not confirm its workspace, scope, identity or collection bounds; no result can be claimed", kind)
	}
	if asJSON || format == "json" {
		// Validate with the map, but retain exact wire decimals in machine output.
		return cli.PrintJSON(os.Stdout, raw)
	}
	printCockpitSurfaceResult(kind, result, query)
	return nil
}
func printCockpitSurfaceResult(kind string, value map[string]any, q url.Values) {
	fmt.Fprintf(os.Stdout, "Workspace: %s\nScope: project=%s module=%s\n", strVal(value, "workspace_id"), scopeCLIValue(q.Get("project_id")), scopeCLIValue(q.Get("module_id")))
	if kind == "context" {
		if value["cockpit"] == nil {
			fmt.Fprintln(os.Stdout, "No cockpit has been created.")
		} else {
			board := value["cockpit"].(map[string]any)
			fmt.Fprintf(os.Stdout, "Cockpit: %s (%s)\n", strVal(board, "title"), strVal(board, "id"))
		}
		return
	}
	if kind == "plan" {
		counts := value["counts"].(map[string]any)
		fmt.Fprintf(os.Stdout, "Complete plan: %.0f nodes, %.0f payments, %.0f milestones. Context ancestors: %d.\n", counts["nodes"], counts["payments"], counts["milestones"], len(value["context_node_ids"].([]any)))
		rows := [][]string{}
		for _, entry := range value["nodes"].([]any) {
			row := entry.(map[string]any)
			rows = append(rows, []string{strVal(row, "code"), strVal(row, "name"), strVal(row, "id")})
		}
		cli.PrintTable(os.Stdout, []string{"CODE", "NAME", "ID"}, rows)
		return
	}
	if kind == "diff" {
		fmt.Fprintf(os.Stdout, "Snapshot: %s\n", strVal(value, "snapshot_id"))
		if value["comparable"] != true {
			fmt.Fprintf(os.Stdout, "Not comparable: %s. No changes or restore can be inferred.\n", strVal(value, "reason"))
			if explanation := map[string]string{
				"legacy_identity_missing":      "This snapshot has no stable UUID identities. Save a new snapshot to compare future changes; do not match old names or codes.",
				"unsupported_identity_version": "The stored identity format requires a service that supports that version.",
				"incomplete_identity":          "The saved identity collection is incomplete.",
				"invalid_identity":             "The saved identity data is inconsistent or damaged.",
				"cockpit_missing":              "The current cockpit no longer exists; this read did not create one.",
				"cockpit_replaced":             "The current cockpit is a different object from the saved cockpit.",
			}[strVal(value, "reason")]; explanation != "" {
				fmt.Fprintln(os.Stdout, explanation)
			}
			return
		}
		counts := value["counts"].(map[string]any)
		fmt.Fprintf(os.Stdout, "Current versus snapshot: %.0f added, %.0f missing, %.0f modified, %.0f unchanged.\n", counts["added"], counts["removed"], counts["modified"], counts["unchanged"])
	} else {
		fmt.Fprintf(os.Stdout, "Dates: %s to %s; node: %s\n", scopeCLIValue(q.Get("date_from")), scopeCLIValue(q.Get("date_to")), scopeCLIValue(q.Get("node_id")))
	}
	items := value["items"].([]any)
	fmt.Fprintf(os.Stdout, "This page: %d of %.0f. No further pages were requested.\n", len(items), value["total"])
	rows := [][]string{}
	for _, entry := range items {
		row := entry.(map[string]any)
		if kind == "diff" {
			fields := []string{}
			for _, entry := range row["field_changes"].([]any) {
				fields = append(fields, strVal(entry.(map[string]any), "field"))
			}
			rows = append(rows, []string{strVal(row, "entity_kind"), strVal(row, "id"), strVal(row, "name"), strVal(row, "change"), strings.Join(fields, ", ")})
		} else {
			rows = append(rows, []string{strVal(row, "id"), strVal(row, "title"), strVal(row, "meet_date"), strVal(row, "status"), strVal(row, "workflow_stage")})
		}
	}
	if kind == "diff" {
		cli.PrintTable(os.Stdout, []string{"ENTITY", "ID", "NAME", "CHANGE", "FIELDS"}, rows)
	} else {
		cli.PrintTable(os.Stdout, []string{"ID", "TITLE", "DATE", "MEETING STATUS", "WORKFLOW"}, rows)
	}
	if cursor, ok := value["next_cursor"].(string); ok {
		fmt.Fprintf(os.Stdout, "Next cursor: %s\n", strconv.Quote(cursor))
	}
}
func scopeCLIValue(value string) string {
	if value == "" {
		return "all"
	}
	return value
}
