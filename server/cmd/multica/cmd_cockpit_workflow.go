package main

import (
	"context"
	"encoding/hex"
	"fmt"
	"io"
	"net/url"
	"os"
	"path"
	"strings"
	"unicode"
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
		Long: "Read a bounded meeting summary, history page or fixed version, or advance its minutes workflow. " +
			"Use --compact on writes for the summary and exact command receipt; show and default writes retain their full JSON output. " +
			"Enable, readiness, release, reviewer handover, review, publication and NAS export/retry require a human credential; the server enforces permissions. " +
			"An authorized minutes-issue agent may submit a text version. Completing its review issue does not approve or publish it.",
	}
	addCockpitHistoryCommands(workflow)
	for _, action := range []string{"show", "enable", "ready", "release", "submit", "review", "publish", "reassign-reviewer", "export-nas", "retry-nas"} {
		count := 1
		use := action + " <meeting-id>"
		if action == "review" || action == "publish" || action == "export-nas" {
			count = 2
			use += " <version-id>"
		} else if action == "retry-nas" {
			count = 2
			use += " <export-id>"
		}
		cmd := &cobra.Command{
			Use: use, Args: exactArgs(count), Short: action + " meeting workflow",
			RunE: func(cmd *cobra.Command, args []string) error { return runCockpitMeetingWorkflow(cmd, args, action) },
		}
		if action != "show" {
			cmd.Flags().Bool("compact", false, "Return bounded summary and the exact command receipt, without complete history")
		}
		if action != "show" && action != "enable" && action != "export-nas" {
			help := "Required positive workflow revision observed with workflow summary"
			if action == "retry-nas" {
				help = "Required positive revision of the export operation, not the workflow revision"
			}
			cmd.Flags().Int64("revision", 0, help)
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
		case "publish":
			cmd.Flags().String("nas-root-id", "", "Optional configured NAS root UUID; requires --nas-directory")
			cmd.Flags().String("nas-directory", "", "Optional confirmed absolute meeting directory on the server; requires --nas-root-id")
		case "export-nas":
			cmd.Flags().String("root-id", "", "Required configured NAS root UUID from workflow summary")
			cmd.Flags().String("directory", "", "Required confirmed absolute meeting directory on the server from workflow summary")
		case "reassign-reviewer":
			cmd.Flags().String("handoff-key", "", "Required UUID for this handover; reuse it with the same inputs on retry")
			cmd.Flags().String("reviewer-id", "", "Required new human reviewer user UUID in this workspace")
			cmd.Flags().String("reason", "", "Required reason for transferring review responsibility")
		}
		workflow.AddCommand(cmd)
	}
	return workflow
}

func cockpitWorkflowUUID(value, field string) (string, error) {
	id, err := util.ParseUUID(strings.TrimSpace(value))
	if err != nil || !id.Valid || id.Bytes == [16]byte{} {
		return "", fmt.Errorf("%s must be a UUID", field)
	}
	return util.UUIDToString(id), nil
}

// NAS paths name the server's macOS/Linux filesystem, not the CLI host's disk.
// Validation is lexical so a disconnected share can still be queued safely.
func cockpitWorkflowNASTarget(cmd *cobra.Command, rootFlag, directoryFlag string, required bool) (map[string]any, error) {
	hasRoot, hasDirectory := cmd.Flags().Changed(rootFlag), cmd.Flags().Changed(directoryFlag)
	if !required && !hasRoot && !hasDirectory {
		return nil, nil
	}
	if !hasRoot || !hasDirectory {
		return nil, fmt.Errorf("--%s and --%s must be supplied together", rootFlag, directoryFlag)
	}
	root, _ := cmd.Flags().GetString(rootFlag)
	id, err := cockpitWorkflowUUID(root, "--"+rootFlag)
	if err != nil {
		return nil, err
	}
	directory, _ := cmd.Flags().GetString(directoryFlag)
	valid := path.IsAbs(directory) && len(directory) <= 4096 && strings.TrimSpace(directory) == directory && utf8.ValidString(directory)
	for _, part := range strings.Split(directory, "/") {
		valid = valid && part != "." && part != ".."
	}
	for _, r := range directory {
		valid = valid && !unicode.IsControl(r)
	}
	if !valid {
		return nil, fmt.Errorf("--%s must be an absolute server path without dot segments or control characters", directoryFlag)
	}
	return map[string]any{"root_id": id, "directory": path.Clean(directory)}, nil
}

func cockpitNASReceiptUUID(value any) string {
	s, ok := value.(string)
	if !ok {
		return ""
	}
	id, err := util.ParseUUID(s)
	if err != nil || !id.Valid || id.Bytes == [16]byte{} {
		return ""
	}
	return util.UUIDToString(id)
}

// A legacy publish endpoint may ignore nas_export and return HTTP 200 after
// publication alone. Confirm an operation receipt before claiming the NAS
// request was accepted; this is not a claim that filesystem work has finished.
func confirmCockpitNASReceipt(action string, args []string, body, result map[string]any) error {
	var target map[string]any
	switch action {
	case "publish":
		target, _ = body["nas_export"].(map[string]any)
		if target == nil {
			return nil
		}
	case "export-nas":
		target = body
	case "retry-nas":
	default:
		return nil
	}
	resourceID := cockpitNASReceiptUUID(strings.TrimSpace(args[1]))
	rows, _ := result["nas_exports"].([]any)
	if action == "retry-nas" {
		expected, _ := body["expected_revision"].(int64)
		for _, raw := range rows {
			row, _ := raw.(map[string]any)
			if cockpitNASReceiptUUID(row["id"]) != resourceID {
				continue
			}
			revision, ok := row["revision"].(float64)
			status, _ := row["status"].(string)
			if ok && revision >= float64(expected) && revision <= 1<<53-1 && revision == float64(int64(revision)) &&
				(status == "queued" || status == "running" || status == "succeeded") {
				return nil
			}
		}
		return fmt.Errorf("NAS export retry was not confirmed; reload workflow before retrying")
	}
	versionHash := ""
	versions, _ := result["versions"].([]any)
	for _, raw := range versions {
		version, _ := raw.(map[string]any)
		if cockpitNASReceiptUUID(version["id"]) == resourceID {
			versionHash, _ = version["content_hash"].(string)
			break
		}
	}
	hash, hashErr := hex.DecodeString(versionHash)
	if hashErr == nil && len(hash) == 32 {
		for _, raw := range rows {
			row, _ := raw.(map[string]any)
			status, _ := row["status"].(string)
			if cockpitNASReceiptUUID(row["id"]) != "" && cockpitNASReceiptUUID(row["version_id"]) == resourceID &&
				cockpitNASReceiptUUID(row["root_id"]) == target["root_id"] && row["directory"] == target["directory"] &&
				row["content_hash"] == versionHash && strings.TrimSpace(status) != "" {
				return nil
			}
		}
	}
	if action == "publish" {
		return fmt.Errorf("publication may have succeeded; reload workflow to verify NAS export")
	}
	return fmt.Errorf("NAS export was not confirmed; reload workflow before retrying")
}

func cockpitWorkflowBody(cmd *cobra.Command, action string) (map[string]any, error) {
	body := map[string]any{}
	if action == "show" {
		return body, nil
	}
	if action != "enable" && action != "export-nas" {
		revision, err := cmd.Flags().GetInt64("revision")
		if err != nil || !cmd.Flags().Changed("revision") || revision < 1 {
			return nil, fmt.Errorf("--revision is required and must be a positive integer")
		}
		body["expected_revision"] = revision
	}
	switch action {
	case "publish":
		target, err := cockpitWorkflowNASTarget(cmd, "nas-root-id", "nas-directory", false)
		if err != nil {
			return nil, err
		}
		if target != nil {
			body["nas_export"] = target
		}
	case "export-nas":
		return cockpitWorkflowNASTarget(cmd, "root-id", "directory", true)
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
	case "reassign-reviewer":
		for _, field := range []struct{ flag, key string }{{"handoff-key", "handoff_key"}, {"reviewer-id", "reviewer_id"}} {
			value, _ := cmd.Flags().GetString(field.flag)
			id, err := cockpitWorkflowUUID(value, "--"+field.flag)
			if err != nil {
				return nil, err
			}
			body[field.key] = id
		}
		reason, _ := cmd.Flags().GetString("reason")
		reason = strings.TrimSpace(reason)
		if reason == "" || len(reason) > 16000 {
			return nil, fmt.Errorf("--reason must contain 1–16000 bytes of text")
		}
		body["reason"] = reason
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
	case "reassign-reviewer":
		path += "/reviewer"
	case "review", "publish", "export-nas":
		versionID, err := cockpitWorkflowUUID(args[1], "version-id")
		if err != nil {
			return err
		}
		suffix := action
		if action == "export-nas" {
			suffix = "nas-export"
		}
		path += "/versions/" + url.PathEscape(versionID) + "/" + suffix
	case "retry-nas":
		exportID, err := cockpitWorkflowUUID(args[1], "export-id")
		if err != nil {
			return err
		}
		path += "/exports/" + url.PathEscape(exportID) + "/retry"
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	compact, _ := cmd.Flags().GetBool("compact")
	if compact {
		path += "?response=compact"
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
	if compact {
		err = confirmCockpitCompactReceipt(action, args, body, result, client.WorkspaceID)
	} else {
		err = confirmCockpitNASReceipt(action, args, body, result)
	}
	if err != nil {
		return err
	}
	return cli.PrintJSON(os.Stdout, result)
}
