package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/spf13/cobra"
)

func addCockpitHistoryCommands(parent *cobra.Command) {
	for _, action := range []string{"summary", "versions", "version", "handoffs", "exports"} {
		count, use := 1, action+" <meeting-id>"
		if action == "version" {
			count, use = 2, action+" <meeting-id> <version-id>"
		}
		cmd := &cobra.Command{Use: use, Args: exactArgs(count), Short: "Read bounded meeting " + action,
			RunE: func(cmd *cobra.Command, args []string) error { return runCockpitHistory(cmd, args, action) }}
		if action != "summary" && action != "version" {
			cmd.Flags().Int("page-size", 25, "One page of 1-100 metadata rows; does not download all history")
			cmd.Flags().String("cursor", "", "Opaque cursor from the same meeting, filter and page size")
		}
		if action == "exports" {
			cmd.Flags().String("version-id", "", "Optional fixed version UUID")
			cmd.Flags().String("status", "", "Optional queued, running, retry_wait, succeeded, needs_attention, or active")
		}
		parent.AddCommand(cmd)
	}
}

func cockpitHistoryScope(value map[string]any, wsID, meetingID, revision string) bool {
	return value["workspace_id"] == wsID && value["meeting_id"] == meetingID && cockpitReceiptNumber(value[revision], 0)
}

func cockpitVersionMetadata(value any) bool {
	version, ok := value.(map[string]any)
	if !ok || cockpitNASReceiptUUID(version["id"]) == "" || !cockpitReceiptNumber(version["version_number"], 1) {
		return false
	}
	_, content := version["content"]
	_, feedback := version["feedback"]
	hash, _ := version["content_hash"].(string)
	decoded, err := hex.DecodeString(hash)
	return !content && !feedback && err == nil && len(decoded) == 32
}

func cockpitSummaryReceipt(value map[string]any, wsID, meetingID string) bool {
	if value["representation"] != "summary" || !cockpitHistoryScope(value, wsID, meetingID, "revision") {
		return false
	}
	enabled, ok := value["enabled"].(bool)
	if !ok {
		return false
	}
	if enabled {
		issue, _ := value["minutes_issue"].(map[string]any)
		if !cockpitReceiptNumber(value["revision"], 1) || cockpitNASReceiptUUID(value["reviewer_id"]) == "" || cockpitNASReceiptUUID(issue["id"]) == "" {
			return false
		}
	}
	for _, field := range []string{"versions", "reviewer_handoffs", "nas_exports"} {
		if _, present := value[field]; present {
			return false
		}
	}
	if !confirmCockpitOverviewCounts(value["history_counts"], "versions", "reviewer_handoffs", "nas_exports", "nas_active") {
		return false
	}
	for _, key := range []string{"current_version", "published_version"} {
		pin, present := value[key]
		id, hasID := value[key+"_id"]
		if !present || !hasID || (id == nil && pin != nil) || (id != nil && !cockpitVersionMetadata(pin)) {
			return false
		}
		if id != nil && pin.(map[string]any)["id"] != id {
			return false
		}
	}
	return true
}

func runCockpitHistory(cmd *cobra.Command, args []string, action string) error {
	meetingID, err := cockpitWorkflowUUID(args[0], "meeting-id")
	if err != nil {
		return err
	}
	query := url.Values{}
	endpoint := "/api/cockpit/meetings/" + url.PathEscape(meetingID) + "/workflow/"
	size := 0
	versionID := ""
	switch action {
	case "summary":
		endpoint += "summary"
	case "version":
		versionID, err = cockpitWorkflowUUID(args[1], "version-id")
		if err != nil {
			return err
		}
		endpoint += "versions/" + url.PathEscape(versionID)
	default:
		if action == "handoffs" {
			endpoint += "reviewer-handoffs"
		} else {
			endpoint += action
		}
		size, _ = cmd.Flags().GetInt("page-size")
		if size < 1 || size > 100 {
			return fmt.Errorf("--page-size must be between 1 and 100")
		}
		query.Set("page_size", fmt.Sprint(size))
		cursor, _ := cmd.Flags().GetString("cursor")
		if cursor != "" {
			query.Set("cursor", cursor)
		}
		if action == "exports" {
			if cmd.Flags().Changed("version-id") {
				value, _ := cmd.Flags().GetString("version-id")
				versionID, err = cockpitWorkflowUUID(value, "--version-id")
				if err != nil {
					return err
				}
				query.Set("version_id", versionID)
			}
			status, _ := cmd.Flags().GetString("status")
			switch status {
			case "", "queued", "running", "retry_wait", "succeeded", "needs_attention", "active":
			default:
				return fmt.Errorf("unsupported --status")
			}
			if status != "" {
				query.Set("status", status)
			}
		}
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	var result map[string]any
	if query.Encode() != "" {
		endpoint += "?" + query.Encode()
	}
	if err = client.GetJSON(ctx, endpoint, &result); err != nil {
		return err
	}
	valid := cockpitHistoryScope(result, client.WorkspaceID, meetingID, "workflow_revision")
	if action == "summary" {
		valid = cockpitSummaryReceipt(result, client.WorkspaceID, meetingID)
	} else if action == "version" {
		version, _ := result["version"].(map[string]any)
		_, hasBody := version["content"].(string)
		valid = valid && version["id"] == versionID && hasBody
	} else {
		items, ok := result["items"].([]any)
		cursor, hasCursor := result["next_cursor"]
		_, stringCursor := cursor.(string)
		valid = valid && ok && len(items) <= size && cockpitReceiptNumber(result["total"], float64(len(items))) && hasCursor && (cursor == nil || stringCursor)
		for _, raw := range items {
			row, ok := raw.(map[string]any)
			valid = valid && ok && cockpitNASReceiptUUID(row["id"]) != ""
			if action == "versions" {
				valid = valid && cockpitVersionMetadata(row)
			}
			if action == "exports" {
				valid = valid && cockpitVersionMetadata(row["source_version"])
			}
		}
		if action == "exports" {
			version, present := result["version_id"]
			valid = valid && present && result["status"] == query.Get("status") && ((versionID == "" && version == nil) || version == versionID)
		}
	}
	if !valid {
		return fmt.Errorf("meeting history response does not confirm its scope, representation or bounds")
	}
	return cli.PrintJSON(os.Stdout, result)
}

var cockpitCompactActions = map[string]string{
	"enable": "enabled", "ready": "readiness", "release": "released", "submit": "submitted", "review": "reviewed", "publish": "published",
	"reassign-reviewer": "reviewer_reassigned", "export-nas": "nas_export_queued", "retry-nas": "nas_export_retried",
}

func cockpitHistoryTimestamp(value any) bool {
	stamp, ok := value.(string)
	_, err := time.Parse(time.RFC3339Nano, stamp)
	return ok && err == nil
}

func confirmCockpitCompactReceipt(action string, args []string, body, result map[string]any, workspaceID string) error {
	meetingID := cockpitNASReceiptUUID(args[0])
	workflow, _ := result["workflow"].(map[string]any)
	receipt, _ := result["receipt"].(map[string]any)
	valid := result["representation"] == "compact" && result["workspace_id"] == workspaceID && result["meeting_id"] == meetingID &&
		cockpitSummaryReceipt(workflow, workspaceID, meetingID) && receipt["action"] == cockpitCompactActions[action]
	version, _ := receipt["version"].(map[string]any)
	if revision, ok := body["expected_revision"].(int64); ok && action != "retry-nas" {
		valid = valid && cockpitReceiptNumber(workflow["revision"], float64(revision))
	}
	switch action {
	case "enable":
		valid = valid && workflow["enabled"] == true && workflow["reviewer_id"] == body["reviewer_id"]
		if existing, ok := body["existing_issue_id"].(string); ok {
			issue, _ := workflow["minutes_issue"].(map[string]any)
			valid = valid && (issue["id"] == existing || issue["identifier"] == existing)
		}
	case "ready":
		if ended, ok := body["ended"].(bool); ok && ended {
			valid = valid && cockpitHistoryTimestamp(workflow["ended_at"])
		}
		if ready, ok := body["materials_ready"].(bool); ok {
			valid = valid && workflow["materials_ready"] == ready
		}
	case "release":
		valid = valid && cockpitHistoryTimestamp(workflow["released_at"]) && cockpitHistoryTimestamp(workflow["ended_at"]) && workflow["materials_ready"] == true
	case "submit":
		content, _ := body["content"].(string)
		content = strings.TrimSpace(content)
		hash := sha256.Sum256([]byte(content))
		valid = valid && cockpitNASReceiptUUID(version["id"]) != "" && version["submission_key"] == body["submission_key"] && version["content"] == content && version["content_hash"] == hex.EncodeToString(hash[:])
	case "review", "publish":
		valid = valid && version["id"] == cockpitNASReceiptUUID(args[1])
		if action == "review" {
			valid = valid && version["decision"] == body["decision"] && version["feedback"] == body["feedback"] && cockpitHistoryTimestamp(version["reviewed_at"])
		} else {
			valid = valid && version["decision"] == "approved" && cockpitHistoryTimestamp(version["published_at"])
		}
	case "reassign-reviewer":
		handoff, _ := receipt["handoff"].(map[string]any)
		expected, _ := body["expected_revision"].(int64)
		valid = valid && cockpitNASReceiptUUID(handoff["id"]) != "" && handoff["handoff_key"] == body["handoff_key"] && handoff["to_reviewer_id"] == body["reviewer_id"] && handoff["reason"] == body["reason"] && cockpitReceiptNumber(handoff["revision"], float64(expected+1)) && handoff["revision"] == float64(expected+1)
	}
	if action == "export-nas" || action == "retry-nas" || (action == "publish" && body["nas_export"] != nil) {
		job, _ := receipt["nas_export"].(map[string]any)
		source, _ := job["source_version"].(map[string]any)
		status, _ := job["status"].(string)
		valid = valid && cockpitNASReceiptUUID(job["id"]) != "" && cockpitVersionMetadata(source) && status != "" && job["version_id"] == source["id"] && job["content_hash"] == source["content_hash"] && job["source_issue_id"] == source["source_issue_id"] && job["version_number"] == source["version_number"]
		if action == "retry-nas" {
			expected, _ := body["expected_revision"].(int64)
			valid = valid && job["id"] == cockpitNASReceiptUUID(args[1]) && cockpitReceiptNumber(job["revision"], float64(expected)) &&
				(job["status"] == "queued" || job["status"] == "running" || job["status"] == "succeeded")
		} else {
			target := body
			if action == "publish" {
				target, _ = body["nas_export"].(map[string]any)
			}
			valid = valid && job["version_id"] == cockpitNASReceiptUUID(args[1]) && job["root_id"] == target["root_id"] && job["directory"] == target["directory"]
		}
	}
	if !valid {
		return fmt.Errorf("compact command receipt was not confirmed; read summary and exact operation before retrying")
	}
	return nil
}
