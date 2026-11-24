package main

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

// "multica cockpit directories fill" is the operator's pass over a reconciled
// plan: create the folders that are missing and rename the ones whose row name
// moved on. A preview is the default, because the first run on a real share is
// exactly when someone wants to read the list before it is acted on.
func newCockpitDirectoriesCommand() *cobra.Command {
	root := &cobra.Command{Use: "directories", Short: "Inspect and repair the plan's collaboration folders"}
	root.AddCommand(newCockpitDirectoriesFillCommand())
	return root
}

type cockpitDirectoryFillItem struct {
	NodeID        string `json:"node_id"`
	Code          string `json:"code"`
	Name          string `json:"name"`
	Kind          string `json:"kind"`
	Action        string `json:"action"`
	DirectoryName string `json:"directory_name"`
	FullPath      string `json:"full_path"`
	Status        string `json:"status"`
	Reason        string `json:"reason"`
	Error         string `json:"error"`
}

type cockpitDirectoryFillResponse struct {
	Applied bool                       `json:"applied"`
	Items   []cockpitDirectoryFillItem `json:"items"`
	Counts  map[string]int             `json:"counts"`
	Shared  []map[string]any           `json:"shared_collab_projects"`
}

func newCockpitDirectoriesFillCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "fill",
		Short: "Create missing module/work-item folders and sync renamed ones (preview unless --apply)",
		RunE: func(cmd *cobra.Command, args []string) error {
			apply, _ := cmd.Flags().GetBool("apply")
			force, _ := cmd.Flags().GetBool("force")
			project, _ := cmd.Flags().GetString("project")
			output, _ := cmd.Flags().GetString("output")
			body := map[string]any{"apply": apply, "force": force}
			if strings.TrimSpace(project) != "" {
				body["project_id"] = strings.TrimSpace(project)
			}
			client, err := newAPIClient(cmd)
			if err != nil {
				return err
			}
			ctx, cancel := cli.APIContext(context.Background())
			defer cancel()
			var result cockpitDirectoryFillResponse
			if err := client.PostJSON(ctx, "/api/cockpit/plan/directories/fill", body, &result); err != nil {
				return err
			}
			if output == "json" {
				return cli.PrintJSON(os.Stdout, result)
			}
			headers := []string{"CODE", "KIND", "NAME", "ACTION", "STATUS", "FOLDER", "NOTE"}
			rows := make([][]string, 0, len(result.Items))
			for _, item := range result.Items {
				if !apply && item.Action == "none" {
					continue
				}
				note := item.Error
				if note == "" {
					note = item.Reason
				}
				rows = append(rows, []string{item.Code, item.Kind, item.Name, item.Action, item.Status, item.FullPath, note})
			}
			cli.PrintTable(os.Stdout, headers, rows)
			if len(result.Shared) > 0 {
				fmt.Fprintf(os.Stderr, "\nwarning: %d other project(s) share this collaboration space\n", len(result.Shared))
				for _, entry := range result.Shared {
					fmt.Fprintf(os.Stderr, "  - %v / %v\n", entry["workspace_name"], entry["project_title"])
				}
			}
			if !apply {
				fmt.Fprintf(os.Stderr, "\npreview only: %d to create, %d to sync; re-run with --apply to write\n", result.Counts["create"], result.Counts["sync"])
			}
			return nil
		},
	}
	cmd.Flags().Bool("apply", false, "Write the changes (default is a preview)")
	cmd.Flags().String("project", "", "Limit to one project id")
	cmd.Flags().Bool("force", false, "Sync even while agent tasks are running in a folder")
	cmd.Flags().String("output", "table", "Output format: table or json")
	return cmd
}
