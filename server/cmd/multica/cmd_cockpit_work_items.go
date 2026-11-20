package main

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strings"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// `multica cockpit work-item` (S3): the plan's third level — the row issues are
// filed under. Create wins over the generic `cockpit node create` because the
// caller names a module, not a level/binding/parent triple; the server decides
// the code, the parent and the directory name.

var cockpitWorkItemCmd = &cobra.Command{
	Use:   "work-item",
	Short: "Manage work items (the rows issues are filed under)",
}

var cockpitWorkItemCreateCmd = &cobra.Command{
	Use:   "create --module <module-code-or-id> --name <title>",
	Short: "Create a work item under a module",
	RunE:  runCockpitWorkItemCreate,
}

var cockpitWorkItemRenameCmd = &cobra.Command{
	Use:   "rename <code-or-id> --name <title>",
	Short: "Rename a work item (human credential)",
	Args:  exactArgs(1),
	RunE:  runCockpitWorkItemRename,
}

var cockpitWorkItemMoveCmd = &cobra.Command{
	Use:   "move <code-or-id> --to <module-row-code-or-id>",
	Short: "Move a work item under another module row; cross-module moves renumber it (human credential)",
	Args:  exactArgs(1),
	RunE:  runCockpitWorkItemMove,
}

var cockpitWorkItemDeleteCmd = &cobra.Command{
	Use:   "delete <code-or-id>",
	Short: "Delete a work item; its issues are unfiled, the directory is kept",
	Args:  exactArgs(1),
	RunE:  runCockpitWorkItemDelete,
}

var cockpitWorkItemRenumberCmd = &cobra.Command{
	Use:   "renumber <node-code-or-id>",
	Short: "Renumber a node's children to the order they are shown in (human credential)",
	Args:  exactArgs(1),
	RunE:  runCockpitWorkItemRenumber,
}

// isUUIDString reports whether the flag already names a row by id.
func isUUIDString(value string) bool { return uuidPattern.MatchString(value) }

func cockpitWorkItemFlags(cmd *cobra.Command) {
	cmd.Flags().String("module", "", "module code or id the work item hangs from")
	cmd.Flags().String("name", "", "work item title")
	cmd.Flags().String("after", "", "work item code or id to insert after")
	cmd.Flags().String("creation-key", "", "idempotency key: a retried create reuses the row it already made")
	cmd.Flags().String("to", "", "destination module row (code or id) for move")
	cmd.Flags().String("output", "json", "json (default) or table; table prints one summary line")
}

func init() {
	for _, cmd := range []*cobra.Command{cockpitWorkItemCreateCmd, cockpitWorkItemRenameCmd,
		cockpitWorkItemMoveCmd, cockpitWorkItemDeleteCmd, cockpitWorkItemRenumberCmd} {
		cockpitWorkItemFlags(cmd)
	}
	cockpitWorkItemCmd.AddCommand(cockpitWorkItemCreateCmd, cockpitWorkItemRenameCmd,
		cockpitWorkItemMoveCmd, cockpitWorkItemDeleteCmd, cockpitWorkItemRenumberCmd)
}

// resolvePlanNode turns a code or id into the plan row it names, so flags can
// accept the codes the gantt shows ("02.01") as well as UUIDs.
func resolvePlanNode(ctx context.Context, client *cli.APIClient, ref string) (map[string]any, error) {
	var node map[string]any
	if err := client.GetJSON(ctx, "/api/cockpit/nodes/"+url.PathEscape(ref), &node); err != nil {
		return nil, fmt.Errorf("node %q: %w", ref, err)
	}
	if inner, ok := node["node"].(map[string]any); ok {
		return inner, nil
	}
	return node, nil
}

func runCockpitWorkItemCreate(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	module, _ := cmd.Flags().GetString("module")
	name, _ := cmd.Flags().GetString("name")
	if strings.TrimSpace(module) == "" || strings.TrimSpace(name) == "" {
		return fmt.Errorf("--module and --name are required")
	}
	// --module takes the module's plan row (code or id); its module_id is what
	// the endpoint wants, so a code is resolved through the node it names.
	// --module takes a module id or the module row's code/id. A UUID is tried
	// as a row first: if it names a module row, its module_id wins; otherwise
	// it is the module id itself.
	moduleID := module
	if isUUIDString(module) {
		if node, err := resolvePlanNode(ctx, client, module); err == nil {
			if rowModule, _ := node["module_id"].(string); rowModule != "" {
				moduleID = rowModule
			}
		}
	} else {
		node, err := resolvePlanNode(ctx, client, module)
		if err != nil {
			return err
		}
		if moduleID, _ = node["module_id"].(string); moduleID == "" {
			return fmt.Errorf("node %q is not a module row", module)
		}
	}
	body := map[string]any{"module_id": moduleID, "name": name}
	if after, _ := cmd.Flags().GetString("after"); after != "" {
		afterID := after
		if !isUUIDString(after) {
			node, err := resolvePlanNode(ctx, client, after)
			if err != nil {
				return err
			}
			afterID, _ = node["id"].(string)
		}
		body["after_id"] = afterID
	}
	if key, _ := cmd.Flags().GetString("creation-key"); key != "" {
		body["creation_key"] = key
	}
	var node map[string]any
	if err := client.PostJSON(ctx, "/api/cockpit/work-items", body, &node); err != nil {
		return fmt.Errorf("create work item: %w", err)
	}
	if output, _ := cmd.Flags().GetString("output"); output == "table" {
		fmt.Fprintf(os.Stdout, "%s %s\n", strVal(node, "code"), strVal(node, "name"))
		return nil
	}
	return cli.PrintJSON(os.Stdout, node)
}

func runCockpitWorkItemRename(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	name, _ := cmd.Flags().GetString("name")
	if strings.TrimSpace(name) == "" {
		return fmt.Errorf("--name is required")
	}
	var node map[string]any
	if err := client.PatchJSON(ctx, "/api/cockpit/nodes/"+url.PathEscape(args[0]), map[string]any{"name": name}, &node); err != nil {
		return fmt.Errorf("rename work item: %w", err)
	}
	if output, _ := cmd.Flags().GetString("output"); output == "table" {
		fmt.Fprintf(os.Stdout, "%s renamed to %s\n", strVal(node, "code"), strVal(node, "name"))
		return nil
	}
	return cli.PrintJSON(os.Stdout, node)
}

func runCockpitWorkItemMove(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	target, _ := cmd.Flags().GetString("to")
	if strings.TrimSpace(target) == "" {
		return fmt.Errorf("--to is required (the destination module row)")
	}
	parentID := target
	if !isUUIDString(target) {
		node, err := resolvePlanNode(ctx, client, target)
		if err != nil {
			return err
		}
		parentID, _ = node["id"].(string)
	}
	var node map[string]any
	if err := client.PatchJSON(ctx, "/api/cockpit/nodes/"+url.PathEscape(args[0]), map[string]any{"parent_id": parentID}, &node); err != nil {
		return fmt.Errorf("move work item: %w", err)
	}
	// JSON is the machine-readable answer; the summary is opt-in, so a caller
	// parsing stdout never trips over a prose line.
	if output, _ := cmd.Flags().GetString("output"); output == "table" {
		fmt.Fprintf(os.Stdout, "code %s | issues refiled: %v | statuses mapped: %v\n",
			strVal(node, "code"), node["refiled_issues"], node["status_mapped"])
		return nil
	}
	return cli.PrintJSON(os.Stdout, node)
}

func runCockpitWorkItemDelete(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	if err := client.DeleteJSON(ctx, "/api/cockpit/nodes/"+url.PathEscape(args[0])); err != nil {
		return fmt.Errorf("delete work item: %w", err)
	}
	if output, _ := cmd.Flags().GetString("output"); output == "table" {
		fmt.Fprintf(os.Stdout, "deleted %s | issues unfiled (project and module kept) | directory kept\n", args[0])
		return nil
	}
	return cli.PrintJSON(os.Stdout, map[string]any{"ref": args[0], "deleted": true})
}

func runCockpitWorkItemRenumber(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	var out map[string]any
	if err := client.PostJSON(ctx, "/api/cockpit/nodes/"+url.PathEscape(args[0])+"/renumber", map[string]any{}, &out); err != nil {
		return fmt.Errorf("renumber: %w", err)
	}
	if output, _ := cmd.Flags().GetString("output"); output == "table" {
		fmt.Fprintf(os.Stdout, "renumbered children of %s | %v row(s) changed\n", args[0], out["changed"])
		return nil
	}
	return cli.PrintJSON(os.Stdout, out)
}
