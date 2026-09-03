package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

// `multica cockpit` — the agent-facing surface of the project cockpit.
//
// Everything the board's UI can do, an agent can do here: read the whole board,
// edit any node field, link issues, manage instalments, milestones and
// meetings, and replace the board wholesale from a document.
//
// Nodes are addressed by their human code ("L1-02", "L3-01-08") as well as by
// UUID, because that is how a plan names its own work — an agent told to "push
// L3-01-08 out two weeks" should not have to look a UUID up first.

var cockpitCmd = &cobra.Command{
	Use:   "cockpit",
	Short: "Work with the project cockpit (programme board)",
}

var cockpitShowCmd = &cobra.Command{
	Use:   "show",
	Short: "Show the whole cockpit board",
	RunE:  runCockpitShow,
}

var cockpitUpdateCmd = &cobra.Command{
	Use:   "update",
	Short: "Update board-level fields (title, annual goal, summary cards)",
	RunE:  runCockpitUpdate,
}

var cockpitNodeCmd = &cobra.Command{
	Use:   "node",
	Short: "Manage work-breakdown nodes",
}

var cockpitNodeListCmd = &cobra.Command{
	Use:   "list",
	Short: "List nodes in the board",
	RunE:  runCockpitNodeList,
}

var cockpitNodeGetCmd = &cobra.Command{
	Use:   "get <code-or-id>",
	Short: "Show one node with its payments and linked issues",
	Args:  exactArgs(1),
	RunE:  runCockpitNodeGet,
}

var cockpitNodeCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create a node",
	RunE:  runCockpitNodeCreate,
}

var cockpitNodeUpdateCmd = &cobra.Command{
	Use:   "update <code-or-id>",
	Short: "Update a node",
	Args:  exactArgs(1),
	RunE:  runCockpitNodeUpdate,
}

var cockpitNodeDeleteCmd = &cobra.Command{
	Use:   "delete <code-or-id>",
	Short: "Delete a leaf node",
	Args:  exactArgs(1),
	RunE:  runCockpitNodeDelete,
}

var cockpitNodeLinkCmd = &cobra.Command{
	Use:   "link <code-or-id> <issue>...",
	Short: "Link issues to a node (accepts BIO-314 or a UUID)",
	Args:  cobra.MinimumNArgs(2),
	RunE:  runCockpitNodeLink,
}

var cockpitNodeUnlinkCmd = &cobra.Command{
	Use:   "unlink <code-or-id> <issue>",
	Short: "Unlink one issue from a node",
	Args:  exactArgs(2),
	RunE:  runCockpitNodeUnlink,
}

var cockpitPaymentCmd = &cobra.Command{
	Use:   "payment",
	Short: "Manage a node's instalments",
}

var cockpitPaymentAddCmd = &cobra.Command{
	Use:   "add <node-code-or-id>",
	Short: "Add an instalment to a node",
	Args:  exactArgs(1),
	RunE:  runCockpitPaymentAdd,
}

var cockpitPaymentUpdateCmd = &cobra.Command{
	Use:   "update <payment-id>",
	Short: "Update an instalment",
	Args:  exactArgs(1),
	RunE:  runCockpitPaymentUpdate,
}

var cockpitPaymentRemoveCmd = &cobra.Command{
	Use:   "remove <payment-id>",
	Short: "Remove an instalment",
	Args:  exactArgs(1),
	RunE:  runCockpitPaymentRemove,
}

var cockpitMilestoneCmd = &cobra.Command{
	Use:   "milestone",
	Short: "Manage milestones",
}

var cockpitMilestoneListCmd = &cobra.Command{
	Use:   "list",
	Short: "List milestones",
	RunE:  runCockpitMilestoneList,
}

var cockpitMilestoneAddCmd = &cobra.Command{
	Use:   "add",
	Short: "Add a milestone",
	RunE:  runCockpitMilestoneAdd,
}

var cockpitMilestoneUpdateCmd = &cobra.Command{
	Use:   "update <milestone-id>",
	Short: "Update a milestone",
	Args:  exactArgs(1),
	RunE:  runCockpitMilestoneUpdate,
}

var cockpitMilestoneRemoveCmd = &cobra.Command{
	Use:   "remove <milestone-id>",
	Short: "Remove a milestone",
	Args:  exactArgs(1),
	RunE:  runCockpitMilestoneRemove,
}

var cockpitMeetingCmd = &cobra.Command{
	Use:   "meeting",
	Short: "Manage the meeting log",
}

var cockpitMeetingListCmd = &cobra.Command{
	Use:   "list",
	Short: "List meetings",
	RunE:  runCockpitMeetingList,
}

var cockpitMeetingAddCmd = &cobra.Command{
	Use:   "add",
	Short: "Add a meeting",
	RunE:  runCockpitMeetingAdd,
}

var cockpitMeetingUpdateCmd = &cobra.Command{
	Use:   "update <meeting-id>",
	Short: "Update a meeting",
	Args:  exactArgs(1),
	RunE:  runCockpitMeetingUpdate,
}

var cockpitMeetingRemoveCmd = &cobra.Command{
	Use:   "remove <meeting-id>",
	Short: "Remove a meeting",
	Args:  exactArgs(1),
	RunE:  runCockpitMeetingRemove,
}

var cockpitImportCmd = &cobra.Command{
	Use:   "import <file.json>",
	Short: "Replace the whole board from a JSON document (owner/admin; destructive)",
	Args:  exactArgs(1),
	RunE:  runCockpitImport,
}

func init() {
	cockpitCmd.AddCommand(cockpitShowCmd, cockpitUpdateCmd, cockpitNodeCmd,
		cockpitPaymentCmd, cockpitMilestoneCmd, cockpitMeetingCmd, cockpitImportCmd)
	cockpitNodeCmd.AddCommand(cockpitNodeListCmd, cockpitNodeGetCmd, cockpitNodeCreateCmd,
		cockpitNodeUpdateCmd, cockpitNodeDeleteCmd, cockpitNodeLinkCmd, cockpitNodeUnlinkCmd)
	cockpitPaymentCmd.AddCommand(cockpitPaymentAddCmd, cockpitPaymentUpdateCmd, cockpitPaymentRemoveCmd)
	cockpitMilestoneCmd.AddCommand(cockpitMilestoneListCmd, cockpitMilestoneAddCmd,
		cockpitMilestoneUpdateCmd, cockpitMilestoneRemoveCmd)
	cockpitMeetingCmd.AddCommand(cockpitMeetingListCmd, cockpitMeetingAddCmd,
		cockpitMeetingUpdateCmd, cockpitMeetingRemoveCmd)

	cockpitShowCmd.Flags().String("output", "table", "Output format: table or json")

	cockpitUpdateCmd.Flags().String("title", "", "Board title")
	cockpitUpdateCmd.Flags().String("goal-title", "", "Annual objective")
	cockpitUpdateCmd.Flags().String("goal-date", "", "Annual objective target date (YYYY-MM-DD; empty string clears)")
	cockpitUpdateCmd.Flags().String("summary-overall", "", "Overview card: current progress")
	cockpitUpdateCmd.Flags().String("summary-next", "", "Overview card: what is next")
	cockpitUpdateCmd.Flags().String("summary-support", "", "Overview card: support needed")
	cockpitUpdateCmd.Flags().String("basis", "", "Provenance line for the board")
	cockpitUpdateCmd.Flags().String("output", "json", "Output format: table or json")

	cockpitNodeListCmd.Flags().String("output", "table", "Output format: table or json")
	cockpitNodeListCmd.Flags().String("owner", "", "Only nodes with this owner")
	cockpitNodeListCmd.Flags().String("status", "", "Only nodes with this status")
	cockpitNodeListCmd.Flags().Bool("full-id", false, "Show full UUIDs in table output")
	cockpitNodeGetCmd.Flags().String("output", "json", "Output format: table or json")

	for _, c := range []*cobra.Command{cockpitNodeCreateCmd, cockpitNodeUpdateCmd} {
		c.Flags().String("code", "", "Node code, e.g. L3-01-08")
		c.Flags().String("parent", "", "Parent node code or UUID (empty string detaches)")
		c.Flags().String("name", "", "Node name")
		c.Flags().String("owner", "", "Owner")
		c.Flags().String("collaborators", "", "Collaborators")
		c.Flags().String("color", "", "Branch colour, e.g. #2563eb")
		c.Flags().String("start-date", "", "Planned start (YYYY-MM-DD; empty string clears)")
		c.Flags().String("end-date", "", "Planned end (YYYY-MM-DD; empty string clears)")
		c.Flags().String("status", "", "Execution status")
		c.Flags().Float64("progress", 0, "Progress percent (0-100)")
		c.Flags().String("deliverable", "", "Deliverable / outcome")
		c.Flags().String("dependencies", "", "Dependencies")
		c.Flags().String("note", "", "Note")
		c.Flags().String("current-progress", "", "One-line current progress")
		c.Flags().String("vendor", "", "Vendor / delivering party")
		c.Flags().String("budget-category", "", "Budget category")
		c.Flags().Float64("budget", 0, "Annual budget in the board's unit")
		c.Flags().Bool("clear-budget", false, "Clear the budget instead of setting it")
		c.Flags().String("exec-status", "", "Budget execution status")
		c.Flags().String("contract", "", "Contract reference")
		c.Flags().String("source", "", "Provenance of the row")
		c.Flags().Float64("position", 0, "Sort position among siblings")
		c.Flags().String("output", "json", "Output format: table or json")
	}
	cockpitNodeDeleteCmd.Flags().String("output", "table", "Output format: table or json")

	cockpitNodeLinkCmd.Flags().Bool("replace", false, "Replace the node's links instead of adding to them")
	cockpitNodeLinkCmd.Flags().String("output", "json", "Output format: table or json")
	cockpitNodeUnlinkCmd.Flags().String("output", "table", "Output format: table or json")

	for _, c := range []*cobra.Command{cockpitPaymentAddCmd, cockpitPaymentUpdateCmd} {
		c.Flags().String("label", "", "Instalment label, e.g. 第1笔")
		c.Flags().String("pay-date", "", "Payment date (YYYY-MM-DD; empty string clears)")
		c.Flags().Float64("amount", 0, "Amount in the board's unit")
		c.Flags().Float64("position", 0, "Sort position")
		c.Flags().String("output", "json", "Output format: table or json")
	}
	cockpitPaymentRemoveCmd.Flags().String("output", "table", "Output format: table or json")

	cockpitMilestoneListCmd.Flags().String("output", "table", "Output format: table or json")
	cockpitMilestoneListCmd.Flags().Bool("full-id", false, "Show full UUIDs in table output")
	for _, c := range []*cobra.Command{cockpitMilestoneAddCmd, cockpitMilestoneUpdateCmd} {
		c.Flags().String("name", "", "Milestone name")
		c.Flags().String("plan-date", "", "Planned date (YYYY-MM-DD; empty string clears)")
		c.Flags().String("actual-date", "", "Actual date (YYYY-MM-DD; empty string clears)")
		c.Flags().String("status", "", "Milestone status")
		c.Flags().String("node", "", "Owning node code or UUID (empty string detaches)")
		c.Flags().String("condition", "", "Acceptance condition")
		c.Flags().String("guard", "", "Governance that protects the date")
		c.Flags().Float64("position", 0, "Sort position")
		c.Flags().String("output", "json", "Output format: table or json")
	}
	cockpitMilestoneRemoveCmd.Flags().String("output", "table", "Output format: table or json")

	cockpitMeetingListCmd.Flags().String("output", "table", "Output format: table or json")
	cockpitMeetingListCmd.Flags().Bool("full-id", false, "Show full UUIDs in table output")
	for _, c := range []*cobra.Command{cockpitMeetingAddCmd, cockpitMeetingUpdateCmd} {
		c.Flags().String("title", "", "Meeting title")
		c.Flags().String("date", "", "Meeting date (YYYY-MM-DD; empty string clears)")
		c.Flags().String("time-range", "", "Time span as written, e.g. 10:00–11:00")
		c.Flags().String("attendees", "", "Attendees")
		c.Flags().String("meet-no", "", "Conference number")
		c.Flags().String("link", "", "Meeting link")
		c.Flags().String("note", "", "Note")
		c.Flags().String("output", "json", "Output format: table or json")
	}
	cockpitMeetingRemoveCmd.Flags().String("output", "table", "Output format: table or json")

	cockpitImportCmd.Flags().String("output", "json", "Output format: table or json")
}

// ---------------------------------------------------------------------------
// Flag → request body
//
// A partial update has to send only the fields the caller actually named.
// cobra's Changed() is the only thing that separates "--owner ''" (clear it)
// from "--owner never passed" (leave it), so every optional field goes through
// these helpers rather than reading the flag value directly.
// ---------------------------------------------------------------------------

func cockpitStringFlag(cmd *cobra.Command, body map[string]any, flag, field string) {
	if !cmd.Flags().Changed(flag) {
		return
	}
	v, _ := cmd.Flags().GetString(flag)
	body[field] = v
}

func cockpitFloatFlag(cmd *cobra.Command, body map[string]any, flag, field string) {
	if !cmd.Flags().Changed(flag) {
		return
	}
	v, _ := cmd.Flags().GetFloat64(flag)
	body[field] = v
}

func cockpitNodeBody(cmd *cobra.Command) map[string]any {
	body := map[string]any{}
	cockpitStringFlag(cmd, body, "code", "code")
	cockpitStringFlag(cmd, body, "parent", "parent_id")
	cockpitStringFlag(cmd, body, "name", "name")
	cockpitStringFlag(cmd, body, "owner", "owner")
	cockpitStringFlag(cmd, body, "collaborators", "collaborators")
	cockpitStringFlag(cmd, body, "color", "color")
	cockpitStringFlag(cmd, body, "start-date", "start_date")
	cockpitStringFlag(cmd, body, "end-date", "end_date")
	cockpitStringFlag(cmd, body, "status", "status")
	cockpitStringFlag(cmd, body, "deliverable", "deliverable")
	cockpitStringFlag(cmd, body, "dependencies", "dependencies")
	cockpitStringFlag(cmd, body, "note", "note")
	cockpitStringFlag(cmd, body, "current-progress", "current_progress")
	cockpitStringFlag(cmd, body, "vendor", "vendor")
	cockpitStringFlag(cmd, body, "budget-category", "budget_category")
	cockpitStringFlag(cmd, body, "exec-status", "exec_status")
	cockpitStringFlag(cmd, body, "contract", "contract")
	cockpitStringFlag(cmd, body, "source", "source")
	cockpitFloatFlag(cmd, body, "progress", "progress")
	cockpitFloatFlag(cmd, body, "position", "position")
	// --clear-budget wins over --budget: JSON null is how the API hears
	// "empty this column", and a float flag has no null.
	if clear, _ := cmd.Flags().GetBool("clear-budget"); clear {
		body["budget_amount"] = nil
	} else {
		cockpitFloatFlag(cmd, body, "budget", "budget_amount")
	}
	return body
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

func cockpitBoard(ctx context.Context, client *cli.APIClient) (map[string]any, error) {
	var board map[string]any
	if err := client.GetJSON(ctx, "/api/cockpit", &board); err != nil {
		return nil, fmt.Errorf("get cockpit: %w", err)
	}
	return board, nil
}

func mapList(board map[string]any, key string) []map[string]any {
	raw, _ := board[key].([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		if m, ok := item.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

func runCockpitShow(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	board, err := cockpitBoard(ctx, client)
	if err != nil {
		return err
	}

	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(os.Stdout, board)
	}

	meta, _ := board["cockpit"].(map[string]any)
	nodes := mapList(board, "nodes")
	fmt.Fprintf(os.Stdout, "%s\n", strVal(meta, "title"))
	if goal := strVal(meta, "goal_title"); goal != "" {
		fmt.Fprintf(os.Stdout, "Goal: %s (%s)\n", goal, strVal(meta, "goal_date"))
	}
	fmt.Fprintf(os.Stdout, "%d nodes · %d payments · %d issue links · %d milestones · %d meetings\n\n",
		len(nodes), len(mapList(board, "payments")), len(mapList(board, "issue_links")),
		len(mapList(board, "milestones")), len(mapList(board, "meetings")))

	printCockpitNodeTable(nodes, false)
	return nil
}

func runCockpitUpdate(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	body := map[string]any{}
	cockpitStringFlag(cmd, body, "title", "title")
	cockpitStringFlag(cmd, body, "goal-title", "goal_title")
	cockpitStringFlag(cmd, body, "goal-date", "goal_date")
	cockpitStringFlag(cmd, body, "summary-overall", "summary_overall")
	cockpitStringFlag(cmd, body, "summary-next", "summary_next")
	cockpitStringFlag(cmd, body, "summary-support", "summary_support")
	cockpitStringFlag(cmd, body, "basis", "basis")
	if len(body) == 0 {
		return fmt.Errorf("nothing to update; pass at least one field flag")
	}

	var updated map[string]any
	if err := client.PatchJSON(ctx, "/api/cockpit", body, &updated); err != nil {
		return fmt.Errorf("update cockpit: %w", err)
	}
	return cli.PrintJSON(os.Stdout, updated)
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

func printCockpitNodeTable(nodes []map[string]any, fullID bool) {
	headers := []string{"CODE", "NAME", "OWNER", "STATUS", "PROGRESS", "START", "END", "BUDGET"}
	rows := make([][]string, 0, len(nodes))
	for _, n := range nodes {
		progress := ""
		if p, ok := n["progress"].(float64); ok {
			progress = strconv.FormatFloat(p, 'f', -1, 64) + "%"
		}
		budget := ""
		if b, ok := n["budget_amount"].(float64); ok {
			budget = strconv.FormatFloat(b, 'f', -1, 64)
		}
		rows = append(rows, []string{
			strVal(n, "code"), strVal(n, "name"), strVal(n, "owner"), strVal(n, "status"),
			progress, strVal(n, "start_date"), strVal(n, "end_date"), budget,
		})
	}
	cli.PrintTable(os.Stdout, headers, rows)
}

func runCockpitNodeList(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	board, err := cockpitBoard(ctx, client)
	if err != nil {
		return err
	}
	nodes := mapList(board, "nodes")

	owner, _ := cmd.Flags().GetString("owner")
	status, _ := cmd.Flags().GetString("status")
	if owner != "" || status != "" {
		filtered := make([]map[string]any, 0, len(nodes))
		for _, n := range nodes {
			if owner != "" && strVal(n, "owner") != owner {
				continue
			}
			if status != "" && strVal(n, "status") != status {
				continue
			}
			filtered = append(filtered, n)
		}
		nodes = filtered
	}

	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(os.Stdout, nodes)
	}
	fullID, _ := cmd.Flags().GetBool("full-id")
	printCockpitNodeTable(nodes, fullID)
	return nil
}

func runCockpitNodeGet(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	board, err := cockpitBoard(ctx, client)
	if err != nil {
		return err
	}

	ref := strings.TrimSpace(args[0])
	var node map[string]any
	for _, n := range mapList(board, "nodes") {
		if strVal(n, "code") == ref || strVal(n, "id") == ref {
			node = n
			break
		}
	}
	if node == nil {
		return fmt.Errorf("node %q not found on this board", ref)
	}

	// The node plus everything hanging off it, so one call answers "what is the
	// state of L3-01-08" without a second round trip per collection.
	nodeID := strVal(node, "id")
	payments := []map[string]any{}
	for _, p := range mapList(board, "payments") {
		if strVal(p, "node_id") == nodeID {
			payments = append(payments, p)
		}
	}
	issues := []map[string]any{}
	for _, l := range mapList(board, "issue_links") {
		if strVal(l, "node_id") == nodeID {
			issues = append(issues, l)
		}
	}
	detail := map[string]any{"node": node, "payments": payments, "issues": issues}

	if output, _ := cmd.Flags().GetString("output"); output == "table" {
		printCockpitNodeTable([]map[string]any{node}, true)
		return nil
	}
	return cli.PrintJSON(os.Stdout, detail)
}

func runCockpitNodeCreate(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	body := cockpitNodeBody(cmd)
	if _, ok := body["code"]; !ok {
		return fmt.Errorf("--code is required")
	}

	var node map[string]any
	if err := client.PostJSON(ctx, "/api/cockpit/nodes", body, &node); err != nil {
		return fmt.Errorf("create cockpit node: %w", err)
	}
	return cli.PrintJSON(os.Stdout, node)
}

func runCockpitNodeUpdate(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	body := cockpitNodeBody(cmd)
	if len(body) == 0 {
		return fmt.Errorf("nothing to update; pass at least one field flag")
	}

	var node map[string]any
	if err := client.PatchJSON(ctx, "/api/cockpit/nodes/"+url.PathEscape(args[0]), body, &node); err != nil {
		return fmt.Errorf("update cockpit node: %w", err)
	}
	return cli.PrintJSON(os.Stdout, node)
}

func runCockpitNodeDelete(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	if err := client.DeleteJSON(ctx, "/api/cockpit/nodes/"+url.PathEscape(args[0])); err != nil {
		return fmt.Errorf("delete cockpit node: %w", err)
	}
	fmt.Fprintf(os.Stdout, "Deleted node %s\n", args[0])
	return nil
}

func runCockpitNodeLink(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	replace, _ := cmd.Flags().GetBool("replace")
	body := map[string]any{"issue_ids": args[1:], "replace": replace}

	var result map[string]any
	path := "/api/cockpit/nodes/" + url.PathEscape(args[0]) + "/issues"
	if err := client.PutJSON(ctx, path, body, &result); err != nil {
		return fmt.Errorf("link issues: %w", err)
	}
	return cli.PrintJSON(os.Stdout, result)
}

func runCockpitNodeUnlink(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	path := "/api/cockpit/nodes/" + url.PathEscape(args[0]) + "/issues/" + url.PathEscape(args[1])
	if err := client.DeleteJSON(ctx, path); err != nil {
		return fmt.Errorf("unlink issue: %w", err)
	}
	fmt.Fprintf(os.Stdout, "Unlinked %s from %s\n", args[1], args[0])
	return nil
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

func cockpitPaymentBody(cmd *cobra.Command) map[string]any {
	body := map[string]any{}
	cockpitStringFlag(cmd, body, "label", "label")
	cockpitStringFlag(cmd, body, "pay-date", "pay_date")
	cockpitFloatFlag(cmd, body, "amount", "amount")
	cockpitFloatFlag(cmd, body, "position", "position")
	return body
}

func runCockpitPaymentAdd(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	var payment map[string]any
	path := "/api/cockpit/nodes/" + url.PathEscape(args[0]) + "/payments"
	if err := client.PostJSON(ctx, path, cockpitPaymentBody(cmd), &payment); err != nil {
		return fmt.Errorf("add payment: %w", err)
	}
	return cli.PrintJSON(os.Stdout, payment)
}

func runCockpitPaymentUpdate(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	body := cockpitPaymentBody(cmd)
	if len(body) == 0 {
		return fmt.Errorf("nothing to update; pass at least one field flag")
	}
	var payment map[string]any
	if err := client.PatchJSON(ctx, "/api/cockpit/payments/"+url.PathEscape(args[0]), body, &payment); err != nil {
		return fmt.Errorf("update payment: %w", err)
	}
	return cli.PrintJSON(os.Stdout, payment)
}

func runCockpitPaymentRemove(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	if err := client.DeleteJSON(ctx, "/api/cockpit/payments/"+url.PathEscape(args[0])); err != nil {
		return fmt.Errorf("remove payment: %w", err)
	}
	fmt.Fprintf(os.Stdout, "Removed payment %s\n", args[0])
	return nil
}

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

func cockpitMilestoneBody(cmd *cobra.Command) map[string]any {
	body := map[string]any{}
	cockpitStringFlag(cmd, body, "name", "name")
	cockpitStringFlag(cmd, body, "plan-date", "plan_date")
	cockpitStringFlag(cmd, body, "actual-date", "actual_date")
	cockpitStringFlag(cmd, body, "status", "status")
	cockpitStringFlag(cmd, body, "node", "node_id")
	cockpitStringFlag(cmd, body, "condition", "condition")
	cockpitStringFlag(cmd, body, "guard", "guard")
	cockpitFloatFlag(cmd, body, "position", "position")
	return body
}

func runCockpitMilestoneList(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	board, err := cockpitBoard(ctx, client)
	if err != nil {
		return err
	}
	milestones := mapList(board, "milestones")
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(os.Stdout, milestones)
	}
	fullID, _ := cmd.Flags().GetBool("full-id")
	headers := []string{"ID", "NAME", "PLAN", "ACTUAL", "STATUS"}
	rows := make([][]string, 0, len(milestones))
	for _, m := range milestones {
		rows = append(rows, []string{
			displayID(strVal(m, "id"), fullID), strVal(m, "name"),
			strVal(m, "plan_date"), strVal(m, "actual_date"), strVal(m, "status"),
		})
	}
	cli.PrintTable(os.Stdout, headers, rows)
	return nil
}

func runCockpitMilestoneAdd(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	var milestone map[string]any
	if err := client.PostJSON(ctx, "/api/cockpit/milestones", cockpitMilestoneBody(cmd), &milestone); err != nil {
		return fmt.Errorf("add milestone: %w", err)
	}
	return cli.PrintJSON(os.Stdout, milestone)
}

func runCockpitMilestoneUpdate(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	body := cockpitMilestoneBody(cmd)
	if len(body) == 0 {
		return fmt.Errorf("nothing to update; pass at least one field flag")
	}
	var milestone map[string]any
	if err := client.PatchJSON(ctx, "/api/cockpit/milestones/"+url.PathEscape(args[0]), body, &milestone); err != nil {
		return fmt.Errorf("update milestone: %w", err)
	}
	return cli.PrintJSON(os.Stdout, milestone)
}

func runCockpitMilestoneRemove(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	if err := client.DeleteJSON(ctx, "/api/cockpit/milestones/"+url.PathEscape(args[0])); err != nil {
		return fmt.Errorf("remove milestone: %w", err)
	}
	fmt.Fprintf(os.Stdout, "Removed milestone %s\n", args[0])
	return nil
}

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------

func cockpitMeetingBody(cmd *cobra.Command) map[string]any {
	body := map[string]any{}
	cockpitStringFlag(cmd, body, "title", "title")
	cockpitStringFlag(cmd, body, "date", "meet_date")
	cockpitStringFlag(cmd, body, "time-range", "time_range")
	cockpitStringFlag(cmd, body, "attendees", "attendees")
	cockpitStringFlag(cmd, body, "meet-no", "meet_no")
	cockpitStringFlag(cmd, body, "link", "link")
	cockpitStringFlag(cmd, body, "note", "note")
	return body
}

func runCockpitMeetingList(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	board, err := cockpitBoard(ctx, client)
	if err != nil {
		return err
	}
	meetings := mapList(board, "meetings")
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(os.Stdout, meetings)
	}
	fullID, _ := cmd.Flags().GetBool("full-id")
	headers := []string{"ID", "DATE", "TIME", "TITLE", "ATTENDEES"}
	rows := make([][]string, 0, len(meetings))
	for _, m := range meetings {
		rows = append(rows, []string{
			displayID(strVal(m, "id"), fullID), strVal(m, "meet_date"),
			strVal(m, "time_range"), strVal(m, "title"), strVal(m, "attendees"),
		})
	}
	cli.PrintTable(os.Stdout, headers, rows)
	return nil
}

func runCockpitMeetingAdd(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	var meeting map[string]any
	if err := client.PostJSON(ctx, "/api/cockpit/meetings", cockpitMeetingBody(cmd), &meeting); err != nil {
		return fmt.Errorf("add meeting: %w", err)
	}
	return cli.PrintJSON(os.Stdout, meeting)
}

func runCockpitMeetingUpdate(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	body := cockpitMeetingBody(cmd)
	if len(body) == 0 {
		return fmt.Errorf("nothing to update; pass at least one field flag")
	}
	var meeting map[string]any
	if err := client.PatchJSON(ctx, "/api/cockpit/meetings/"+url.PathEscape(args[0]), body, &meeting); err != nil {
		return fmt.Errorf("update meeting: %w", err)
	}
	return cli.PrintJSON(os.Stdout, meeting)
}

func runCockpitMeetingRemove(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	if err := client.DeleteJSON(ctx, "/api/cockpit/meetings/"+url.PathEscape(args[0])); err != nil {
		return fmt.Errorf("remove meeting: %w", err)
	}
	fmt.Fprintf(os.Stdout, "Removed meeting %s\n", args[0])
	return nil
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

func runCockpitImport(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	data, err := os.ReadFile(args[0])
	if err != nil {
		return fmt.Errorf("read import document: %w", err)
	}
	var document map[string]any
	if err := json.Unmarshal(data, &document); err != nil {
		return fmt.Errorf("parse import document: %w", err)
	}

	var result map[string]any
	if err := client.PutJSON(ctx, "/api/cockpit/import", document, &result); err != nil {
		return fmt.Errorf("import cockpit: %w", err)
	}

	// Unresolved issue references go to stderr so JSON on stdout stays
	// parseable; they are also in the response body for programmatic callers.
	if unresolved, _ := result["unresolved_issues"].([]any); len(unresolved) > 0 {
		refs := make([]string, 0, len(unresolved))
		for _, u := range unresolved {
			if s, ok := u.(string); ok {
				refs = append(refs, s)
			}
		}
		fmt.Fprintf(os.Stderr, "%d issue reference(s) did not resolve and were skipped: %s\n",
			len(refs), strings.Join(refs, ", "))
	}
	return cli.PrintJSON(os.Stdout, result)
}
