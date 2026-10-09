package main

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"
	"unicode/utf8"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/multica-ai/multica/server/internal/util"
	"github.com/spf13/cobra"
)

const cockpitMinutesContentLimit = 128 * 1024

func newCockpitMeetingWorkflowCommand() *cobra.Command {
	workflow := &cobra.Command{
		Use:   "workflow",
		Short: "Manage a meeting's minutes work package and fixed review versions",
		Long: "Read or advance a meeting's minutes workflow. Commands return the JSON workflow read model. " +
			"Enable, readiness, release, review and publication require a human credential; the server enforces permissions. " +
			"An authorized minutes-issue agent may submit a text version. Completing its review issue does not approve or publish it.",
	}
	for _, action := range []string{"show", "enable", "ready", "release", "submit", "review", "publish"} {
		count := 1
		use := action + " <meeting-id>"
		if action == "review" || action == "publish" {
			count = 2
			use += " <version-id>"
		}
		cmd := &cobra.Command{
			Use: use, Args: exactArgs(count), Short: action + " meeting workflow",
			RunE: func(cmd *cobra.Command, args []string) error { return runCockpitMeetingWorkflow(cmd, args, action) },
		}
		if action != "show" && action != "enable" {
			cmd.Flags().Int64("revision", 0, "Required positive workflow revision observed with workflow show")
		}
		switch action {
		case "enable":
			cmd.Flags().String("reviewer-id", "", "Required human reviewer user UUID in this workspace")
			cmd.Flags().String("existing-issue-id", "", "Explicitly adopt an unstarted backlog issue (UUID or issue identifier)")
			cmd.Flags().String("project-id", "", "New issue project UUID; an explicitly empty value clears the board default")
			cmd.Flags().String("module-id", "", "New issue module UUID; an explicitly empty value clears the board default")
			cmd.Flags().String("node-id", "", "Archive execution node UUID or cockpit code")
			cmd.Flags().String("assignee-type", "", "New issue executor: member, agent or squad (requires --assignee-id)")
			cmd.Flags().String("assignee-id", "", "New issue executor UUID (requires --assignee-type); defaults to the current member")
		case "ready":
			cmd.Flags().Bool("ended", false, "Confirm the meeting has ended; this fact cannot be withdrawn")
			cmd.Flags().Bool("materials-ready", false, "Set materials readiness before release; use =false to withdraw it")
		case "submit":
			cmd.Flags().String("submission-key", "", "Required UUID identifying this submission; reuse it when retrying the same text")
			cmd.Flags().String("content-file", "", "Required UTF-8 minutes file (at most 128 KiB)")
		case "review":
			cmd.Flags().String("decision", "", "Required decision: approved, changes_requested or rejected")
			cmd.Flags().String("feedback", "", "Review feedback; required for changes_requested and rejected")
		}
		workflow.AddCommand(cmd)
	}
	return workflow
}

func cockpitWorkflowUUID(value, field string) (string, error) {
	id, err := util.ParseUUID(strings.TrimSpace(value))
	if err != nil || !id.Valid {
		return "", fmt.Errorf("%s must be a UUID", field)
	}
	return util.UUIDToString(id), nil
}

func cockpitWorkflowBody(cmd *cobra.Command, action string) (map[string]any, error) {
	body := map[string]any{}
	if action == "show" {
		return body, nil
	}
	if action != "enable" {
		revision, err := cmd.Flags().GetInt64("revision")
		if err != nil || !cmd.Flags().Changed("revision") || revision < 1 {
			return nil, fmt.Errorf("--revision is required and must be a positive integer")
		}
		body["expected_revision"] = revision
	}
	switch action {
	case "enable":
		reviewer, _ := cmd.Flags().GetString("reviewer-id")
		id, err := cockpitWorkflowUUID(reviewer, "--reviewer-id")
		if err != nil {
			return nil, err
		}
		body["reviewer_id"] = id
		existing, _ := cmd.Flags().GetString("existing-issue-id")
		if cmd.Flags().Changed("existing-issue-id") {
			if strings.TrimSpace(existing) == "" {
				return nil, fmt.Errorf("--existing-issue-id must name an issue")
			}
			for _, flag := range []string{"project-id", "module-id", "assignee-type", "assignee-id"} {
				if cmd.Flags().Changed(flag) {
					return nil, fmt.Errorf("--%s cannot be used with --existing-issue-id; adoption preserves the existing issue", flag)
				}
			}
			body["existing_issue_id"] = strings.TrimSpace(existing)
		}
		for _, field := range []struct{ flag, key string }{{"project-id", "project_id"}, {"module-id", "module_id"}} {
			if !cmd.Flags().Changed(field.flag) {
				continue
			}
			value, _ := cmd.Flags().GetString(field.flag)
			if value = strings.TrimSpace(value); value != "" {
				value, err = cockpitWorkflowUUID(value, "--"+field.flag)
				if err != nil {
					return nil, err
				}
			}
			body[field.key] = value
		}
		if cmd.Flags().Changed("node-id") {
			value, _ := cmd.Flags().GetString("node-id")
			if strings.TrimSpace(value) == "" {
				return nil, fmt.Errorf("--node-id must name an execution node")
			}
			body["node_id"] = strings.TrimSpace(value)
		}
		hasType, hasID := cmd.Flags().Changed("assignee-type"), cmd.Flags().Changed("assignee-id")
		if hasType != hasID {
			return nil, fmt.Errorf("--assignee-type and --assignee-id must be supplied together")
		}
		if hasType {
			kind, _ := cmd.Flags().GetString("assignee-type")
			if kind != "member" && kind != "agent" && kind != "squad" {
				return nil, fmt.Errorf("--assignee-type must be member, agent or squad")
			}
			value, _ := cmd.Flags().GetString("assignee-id")
			id, err := cockpitWorkflowUUID(value, "--assignee-id")
			if err != nil {
				return nil, err
			}
			body["assignee_type"], body["assignee_id"] = kind, id
		}
	case "ready":
		if !cmd.Flags().Changed("ended") && !cmd.Flags().Changed("materials-ready") {
			return nil, fmt.Errorf("ready requires --ended or --materials-ready")
		}
		if cmd.Flags().Changed("ended") {
			ended, _ := cmd.Flags().GetBool("ended")
			if !ended {
				return nil, fmt.Errorf("--ended cannot be false; an ended meeting cannot be reopened here")
			}
			body["ended"] = true
		}
		if cmd.Flags().Changed("materials-ready") {
			body["materials_ready"], _ = cmd.Flags().GetBool("materials-ready")
		}
	case "submit":
		value, _ := cmd.Flags().GetString("submission-key")
		key, err := cockpitWorkflowUUID(value, "--submission-key")
		if err != nil {
			return nil, err
		}
		path, _ := cmd.Flags().GetString("content-file")
		if path == "" {
			return nil, fmt.Errorf("--content-file is required")
		}
		file, err := os.Open(path)
		if err != nil {
			return nil, fmt.Errorf("read minutes file: %w", err)
		}
		defer file.Close()
		content, err := io.ReadAll(io.LimitReader(file, cockpitMinutesContentLimit+1))
		if err != nil {
			return nil, fmt.Errorf("read minutes file: %w", err)
		}
		if len(content) > cockpitMinutesContentLimit || !utf8.Valid(content) || strings.TrimSpace(string(content)) == "" {
			return nil, fmt.Errorf("--content-file must contain nonempty UTF-8 text of at most 128 KiB")
		}
		body["submission_key"], body["content"] = key, string(content)
	case "review":
		decision, _ := cmd.Flags().GetString("decision")
		feedback, _ := cmd.Flags().GetString("feedback")
		feedback = strings.TrimSpace(feedback)
		if decision != "approved" && decision != "changes_requested" && decision != "rejected" {
			return nil, fmt.Errorf("--decision must be approved, changes_requested or rejected")
		}
		if decision != "approved" && feedback == "" {
			return nil, fmt.Errorf("--feedback is required for %s", decision)
		}
		if len(feedback) > 16000 {
			return nil, fmt.Errorf("--feedback must not exceed 16000 bytes")
		}
		body["decision"], body["feedback"] = decision, feedback
	}
	return body, nil
}

func runCockpitMeetingWorkflow(cmd *cobra.Command, args []string, action string) error {
	meetingID, err := cockpitWorkflowUUID(args[0], "meeting-id")
	if err != nil {
		return err
	}
	body, err := cockpitWorkflowBody(cmd, action)
	if err != nil {
		return err
	}
	path := "/api/cockpit/meetings/" + url.PathEscape(meetingID) + "/workflow"
	switch action {
	case "release":
		path += "/release"
	case "submit":
		path += "/versions"
	case "review", "publish":
		versionID, err := cockpitWorkflowUUID(args[1], "version-id")
		if err != nil {
			return err
		}
		path += "/versions/" + url.PathEscape(versionID) + "/" + action
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	var result map[string]any
	switch action {
	case "show":
		err = client.GetJSON(ctx, path, &result)
	case "ready":
		err = client.PatchJSON(ctx, path, body, &result)
	default:
		err = client.PostJSON(ctx, path, body, &result)
	}
	if err != nil {
		return err
	}
	return cli.PrintJSON(os.Stdout, result)
}
