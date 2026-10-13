package main

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strconv"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/spf13/cobra"
)

func newCockpitChangeCommand() *cobra.Command {
	root := &cobra.Command{Use: "change", Short: "Read and propose plan changes; human decisions stay in the cockpit"}
	for _, action := range []string{"list", "propose", "preview", "withdraw"} {
		count, use := 0, action
		if action == "preview" || action == "withdraw" {
			count, use = 1, action+" <change-id>"
		}
		cmd := &cobra.Command{Use: use, Args: exactArgs(count), Short: action + " plan changes",
			RunE: func(cmd *cobra.Command, args []string) error { return runCockpitChange(cmd, args, action) }}
		switch action {
		case "list":
			addCockpitSurfaceFlags(cmd, true, true)
			cmd.Flags().String("status", "pending", "pending, decided or all")
		case "propose":
			cmd.Flags().String("node", "", "Required stored node code or UUID; displayed row numbers are not stored codes")
			cmd.Flags().String("field", "", "Required editable node field")
			cmd.Flags().String("value", "", "Required proposed value; an explicitly empty string clears the field")
			cmd.Flags().String("reason", "", "Evidence and reason for the proposal")
			for _, flag := range []string{"node", "field", "value"} {
				_ = cmd.MarkFlagRequired(flag)
			}
		}
		root.AddCommand(cmd)
	}
	return root
}

func runCockpitChange(cmd *cobra.Command, args []string, action string) error {
	endpoint := "/api/cockpit/changes"
	body := map[string]any{}
	switch action {
	case "list":
		query, err := cockpitSurfaceScopeQuery(cmd)
		if err != nil {
			return err
		}
		status, _ := cmd.Flags().GetString("status")
		if status != "pending" && status != "decided" && status != "all" {
			return fmt.Errorf("--status must be pending, decided or all")
		}
		size, _ := cmd.Flags().GetInt("page-size")
		if size < 1 || size > 100 {
			return fmt.Errorf("--page-size must be between 1 and 100")
		}
		cursor, _ := cmd.Flags().GetString("cursor")
		if len(cursor) > 4096 {
			return fmt.Errorf("--cursor exceeds 4096 bytes")
		}
		query.Set("status", status)
		query.Set("page_size", strconv.Itoa(size))
		if cursor != "" {
			query.Set("cursor", cursor)
		}
		endpoint += "/page?" + query.Encode()
	case "propose":
		for flag, field := range map[string]string{"node": "node", "field": "field", "value": "new_value", "reason": "reason"} {
			value, _ := cmd.Flags().GetString(flag)
			body[field] = value
		}
	case "preview", "withdraw":
		id, err := cockpitWorkflowUUID(args[0], "change-id")
		if err != nil {
			return err
		}
		endpoint += "/" + url.PathEscape(id) + "/" + action
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	var result map[string]any
	if action == "list" || action == "preview" {
		err = client.GetJSON(ctx, endpoint, &result)
	} else {
		err = client.PostJSON(ctx, endpoint, body, &result)
	}
	if err != nil {
		return fmt.Errorf("%s plan change: %w", action, err)
	}
	return cli.PrintJSON(os.Stdout, result)
}
