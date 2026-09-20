package main

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

// ---------------------------------------------------------------------------
// Module commands — a module (模块) subdivides a project. An issue keeps its
// project and additionally files into one of that project's modules, so every
// module reference here resolves within a project when one is given.
//
// A module has no collaboration-space path of its own, which is why no command
// here takes --collab-path. Its deliverables belong in a folder named after the
// module inside the project's 人机协作空间路径 (`multica project
// --collab-path`), so the location follows from the module's title. Storing it
// again per module would add a value that can drift from the folder it names,
// and make re-cutting a project's modules a multi-place edit.
// ---------------------------------------------------------------------------

var moduleCmd = &cobra.Command{
	Use:   "module",
	Short: "Work with project modules",
}

var moduleListCmd = &cobra.Command{
	Use:   "list",
	Short: "List modules, in module order",
	RunE:  runModuleList,
}

var moduleGetCmd = &cobra.Command{
	Use:   "get <id>",
	Short: "Get module details",
	Args:  exactArgs(1),
	RunE:  runModuleGet,
}

var moduleCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create a new module in a project",
	RunE:  runModuleCreate,
}

var moduleUpdateCmd = &cobra.Command{
	Use:   "update <id>",
	Short: "Update a module",
	Args:  exactArgs(1),
	RunE:  runModuleUpdate,
}

var moduleDeleteCmd = &cobra.Command{
	Use:   "delete <id>",
	Short: "Delete a module; its issues stay in the project (owner/admin only)",
	Args:  exactArgs(1),
	RunE:  runModuleDelete,
}

// moduleProjectFlagHelp is shared by the commands that take a module reference:
// --project only narrows how that reference is resolved, it never moves a
// module between projects (the API has no such field).
const moduleProjectFlagHelp = "Project ID (full UUID or unique prefix; run `multica project list` for ids); narrows the module lookup when the module is named by title or short id"

func init() {
	moduleCmd.AddCommand(moduleListCmd)
	moduleCmd.AddCommand(moduleGetCmd)
	moduleCmd.AddCommand(moduleCreateCmd)
	moduleCmd.AddCommand(moduleUpdateCmd)
	moduleCmd.AddCommand(moduleDeleteCmd)

	// module list
	moduleListCmd.Flags().String("project", "", "Project ID (full UUID or unique prefix; run `multica project list` for ids); omit to list every module in the workspace")
	moduleListCmd.Flags().String("output", "table", "Output format: table or json")
	moduleListCmd.Flags().Bool("full-id", false, "Show full UUIDs in table output")

	// module get
	moduleGetCmd.Flags().String("project", "", moduleProjectFlagHelp)
	moduleGetCmd.Flags().String("output", "json", "Output format: table or json")

	// module create
	moduleCreateCmd.Flags().String("project", "", "Project ID, required (full UUID or unique prefix; run `multica project list` for ids)")
	moduleCreateCmd.Flags().String("title", "", "Module title (required)")
	moduleCreateCmd.Flags().String("description", "", "Module description")
	moduleCreateCmd.Flags().String("output", "json", "Output format: table or json")

	// module update
	moduleUpdateCmd.Flags().String("project", "", moduleProjectFlagHelp)
	moduleUpdateCmd.Flags().String("title", "", "New title")
	moduleUpdateCmd.Flags().String("description", "", "New description; pass an empty string to clear")
	moduleUpdateCmd.Flags().Float64("position", 0, "New position within the project's module order (lower sorts first)")
	moduleUpdateCmd.Flags().String("output", "json", "Output format: table or json")

	// module delete
	moduleDeleteCmd.Flags().String("project", "", moduleProjectFlagHelp)
	moduleDeleteCmd.Flags().String("output", "table", "Output format: table or json")
}

// moduleProjectScope resolves the optional --project flag into a project id
// that narrows module lookups. An unset flag returns "", which searches the
// whole workspace — what GET /api/modules does without project_id.
func moduleProjectScope(ctx context.Context, client *cli.APIClient, cmd *cobra.Command) (string, error) {
	v, _ := cmd.Flags().GetString("project")
	if strings.TrimSpace(v) == "" {
		return "", nil
	}
	project, err := resolveProjectID(ctx, client, v)
	if err != nil {
		return "", fmt.Errorf("resolve project: %w", err)
	}
	return project.ID, nil
}

// unwrapModule returns the module object from a single-module response. The
// module endpoints wrap their payload as {"module": {...}}, unlike the project
// endpoints, which answer with the object itself.
func unwrapModule(result map[string]any) map[string]any {
	if m, ok := result["module"].(map[string]any); ok {
		return m
	}
	return result
}

// formatModuleProgress renders the done/total issue counts the module
// endpoints attach to every module they return.
func formatModuleProgress(m map[string]any) string {
	return fmt.Sprintf("%d/%d", int64(floatVal(m, "done_count")), int64(floatVal(m, "issue_count")))
}

func runModuleList(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}

	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	projectID, err := moduleProjectScope(ctx, client, cmd)
	if err != nil {
		return err
	}

	path := "/api/modules"
	if projectID != "" {
		path += "?" + url.Values{"project_id": {projectID}}.Encode()
	}

	var result map[string]any
	if err := client.GetJSON(ctx, path, &result); err != nil {
		return fmt.Errorf("list modules: %w", err)
	}
	modulesRaw, _ := result["modules"].([]any)

	output, _ := cmd.Flags().GetString("output")
	if output == "json" {
		return cli.PrintJSON(os.Stdout, modulesRaw)
	}

	fullID, _ := cmd.Flags().GetBool("full-id")
	headers := []string{"ID", "TITLE", "ISSUES"}
	rows := make([][]string, 0, len(modulesRaw))
	for _, raw := range modulesRaw {
		m, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		rows = append(rows, []string{
			displayID(strVal(m, "id"), fullID),
			strVal(m, "title"),
			formatModuleProgress(m),
		})
	}
	cli.PrintTable(os.Stdout, headers, rows)
	return nil
}

func runModuleGet(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}

	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	projectID, err := moduleProjectScope(ctx, client, cmd)
	if err != nil {
		return err
	}
	moduleRef, err := resolveModuleID(ctx, client, projectID, args[0])
	if err != nil {
		return err
	}

	var result map[string]any
	if err := client.GetJSON(ctx, "/api/modules/"+moduleRef.ID, &result); err != nil {
		return fmt.Errorf("get module: %w", err)
	}
	module := unwrapModule(result)

	output, _ := cmd.Flags().GetString("output")
	if output == "table" {
		headers := []string{"ID", "TITLE", "ISSUES", "DESCRIPTION"}
		rows := [][]string{{
			strVal(module, "id"),
			strVal(module, "title"),
			formatModuleProgress(module),
			strVal(module, "description"),
		}}
		cli.PrintTable(os.Stdout, headers, rows)
		return nil
	}

	return cli.PrintJSON(os.Stdout, module)
}

func runModuleCreate(cmd *cobra.Command, _ []string) error {
	title, _ := cmd.Flags().GetString("title")
	if title == "" {
		return fmt.Errorf("--title is required")
	}
	projectFlag, _ := cmd.Flags().GetString("project")
	if strings.TrimSpace(projectFlag) == "" {
		return fmt.Errorf("--project is required; a module always belongs to a project")
	}

	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}

	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	project, err := resolveProjectID(ctx, client, projectFlag)
	if err != nil {
		return fmt.Errorf("resolve project: %w", err)
	}

	body := map[string]any{"project_id": project.ID, "title": title}
	if v, _ := cmd.Flags().GetString("description"); v != "" {
		body["description"] = v
	}

	var result map[string]any
	if err := client.PostJSON(ctx, "/api/modules", body, &result); err != nil {
		return fmt.Errorf("create module: %w", err)
	}
	module := unwrapModule(result)

	output, _ := cmd.Flags().GetString("output")
	if output == "table" {
		headers := []string{"ID", "TITLE"}
		rows := [][]string{{
			strVal(module, "id"),
			strVal(module, "title"),
		}}
		cli.PrintTable(os.Stdout, headers, rows)
		return nil
	}

	return cli.PrintJSON(os.Stdout, module)
}

func runModuleUpdate(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}

	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	projectID, err := moduleProjectScope(ctx, client, cmd)
	if err != nil {
		return err
	}
	moduleRef, err := resolveModuleID(ctx, client, projectID, args[0])
	if err != nil {
		return err
	}

	body := map[string]any{}
	if cmd.Flags().Changed("title") {
		v, _ := cmd.Flags().GetString("title")
		body["title"] = v
	}
	// Changed() (not "") so an explicit --description "" reaches the server as
	// a clear, mirroring `project update`.
	if cmd.Flags().Changed("description") {
		v, _ := cmd.Flags().GetString("description")
		body["description"] = v
	}
	if cmd.Flags().Changed("position") {
		v, _ := cmd.Flags().GetFloat64("position")
		body["position"] = v
	}

	if len(body) == 0 {
		return fmt.Errorf("no fields to update; use flags like --title, --description, --position")
	}

	var result map[string]any
	if err := client.PutJSON(ctx, "/api/modules/"+moduleRef.ID, body, &result); err != nil {
		return fmt.Errorf("update module: %w", err)
	}
	module := unwrapModule(result)

	output, _ := cmd.Flags().GetString("output")
	if output == "table" {
		headers := []string{"ID", "TITLE"}
		rows := [][]string{{
			strVal(module, "id"),
			strVal(module, "title"),
		}}
		cli.PrintTable(os.Stdout, headers, rows)
		return nil
	}

	return cli.PrintJSON(os.Stdout, module)
}

func runModuleDelete(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}

	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	projectID, err := moduleProjectScope(ctx, client, cmd)
	if err != nil {
		return err
	}
	moduleRef, err := resolveModuleID(ctx, client, projectID, args[0])
	if err != nil {
		return err
	}

	if err := client.DeleteJSON(ctx, "/api/modules/"+moduleRef.ID); err != nil {
		return fmt.Errorf("delete module: %w", err)
	}

	// JSON consumers get machine-readable output; humans get natural language,
	// including where the module's issues went.
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(os.Stdout, map[string]any{"id": moduleRef.ID, "deleted": true})
	}
	fmt.Fprintf(os.Stdout, "Module %s deleted; its issues now sit directly under the project.\n", moduleRef.Display)
	return nil
}
