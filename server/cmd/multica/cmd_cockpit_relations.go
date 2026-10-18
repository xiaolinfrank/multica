package main

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"slices"
	"strconv"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/spf13/cobra"
)

func newCockpitMeetingRelationCommand(kind string) *cobra.Command {
	root := &cobra.Command{Use: kind, Short: "Manage a meeting's " + kind + " associations without replacing unloaded links"}
	actions := []string{"list", "link", "unlink"}
	if kind == "issue" {
		actions = append(actions, "roles")
	}
	for _, action := range actions {
		count := 2
		use := action + " <meeting-id> <" + kind + "-id>"
		if action == "list" {
			count, use = 1, "list <meeting-id>"
		}
		cmd := &cobra.Command{Use: use, Args: exactArgs(count), Short: action + " meeting " + kind + " associations",
			RunE: func(cmd *cobra.Command, args []string) error {
				return runCockpitMeetingRelation(cmd, args, kind, action)
			}}
		if action == "list" {
			cmd.Flags().Int("page-size", 25, "One page of 1-100 links")
			cmd.Flags().String("cursor", "", "Continuation from this meeting's same relation list")
		}
		if action == "roles" {
			cmd.Flags().StringArray("role", nil, "Purpose; repeat for several purposes")
			cmd.Flags().Bool("clear", false, "Explicitly remove all optional purposes; workflow-owned purposes remain protected")
			cmd.MarkFlagsMutuallyExclusive("role", "clear")
		}
		root.AddCommand(cmd)
	}
	return root
}

func runCockpitMeetingRelation(cmd *cobra.Command, args []string, kind, action string) error {
	meeting, err := cockpitWorkflowUUID(args[0], "meeting-id")
	if err != nil {
		return err
	}
	var target string
	if len(args) > 1 {
		target, err = cockpitWorkflowUUID(args[1], kind+"-id")
		if err != nil {
			return err
		}
	}
	query := url.Values{}
	body := map[string]any{kind + "_id": target}
	if action == "list" {
		size, _ := cmd.Flags().GetInt("page-size")
		if size < 1 || size > 100 {
			return fmt.Errorf("--page-size must be between 1 and 100")
		}
		cursor, _ := cmd.Flags().GetString("cursor")
		if len(cursor) > 4096 {
			return fmt.Errorf("--cursor exceeds 4096 bytes")
		}
		query.Set("page_size", strconv.Itoa(size))
		if cursor != "" {
			query.Set("cursor", cursor)
		}
	}
	if action == "roles" {
		roles, _ := cmd.Flags().GetStringArray("role")
		clear, _ := cmd.Flags().GetBool("clear")
		if !clear && len(roles) == 0 {
			return fmt.Errorf("pass --role or --clear; omitted roles must not clear existing purposes")
		}
		for _, role := range roles {
			if !slices.Contains([]string{"preparation", "support", "minutes", "review", "action", "delivery", "reference"}, role) {
				return fmt.Errorf("unknown meeting purpose %q", role)
			}
		}
		if roles == nil {
			roles = []string{}
		}
		body = map[string]any{"roles": roles}
		query.Set("response", "compact")
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	endpoint := "/api/cockpit/meetings/" + meeting + "/" + kind + "s"
	if action == "unlink" || action == "roles" {
		endpoint += "/" + target
	}
	if action == "roles" {
		endpoint += "/roles"
	}
	if len(query) > 0 {
		endpoint += "?" + query.Encode()
	}
	var result map[string]any
	switch action {
	case "list":
		err = client.GetJSON(ctx, endpoint, &result)
	case "link":
		err = client.PostJSON(ctx, endpoint, body, &result)
	case "roles":
		err = client.PutJSON(ctx, endpoint, body, &result)
	case "unlink":
		err = client.DeleteJSON(ctx, endpoint)
	}
	if err != nil {
		return fmt.Errorf("%s meeting %s association: %w", action, kind, err)
	}
	if action == "unlink" {
		return cli.PrintJSON(os.Stdout, map[string]any{"meeting_id": meeting, kind + "_id": target, "unlinked": true})
	}
	if action == "link" || action == "roles" {
		link, _ := result["link"].(map[string]any)
		if result["meeting_id"] != meeting || link["meeting_id"] != meeting || link[kind+"_id"] != target {
			return fmt.Errorf("server returned a mismatched relation receipt; the write may have committed, reread this meeting")
		}
	}
	return cli.PrintJSON(os.Stdout, result)
}

func newCockpitNextNodeCodeCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "next-code <parent-id>", Args: exactArgs(1), Short: "Preview the next execution-task code; does not reserve it",
		RunE: func(cmd *cobra.Command, args []string) error {
			parent, err := cockpitWorkflowUUID(args[0], "parent-id")
			if err != nil {
				return err
			}
			client, err := newAPIClient(cmd)
			if err != nil {
				return err
			}
			ctx, cancel := cli.APIContext(context.Background())
			defer cancel()
			var result map[string]any
			if err := client.GetJSON(ctx, "/api/cockpit/nodes/next-code?parent_id="+parent, &result); err != nil {
				return err
			}
			return cli.PrintJSON(os.Stdout, result)
		}}
	return cmd
}
