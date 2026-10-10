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

func newCockpitMeetingArtifactReferencesCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "artifact-references <meeting-id>", Args: exactArgs(1), Short: "Read fixed artifact versions explicitly referenced by a meeting",
		RunE: func(cmd *cobra.Command, args []string) error {
			meetingID, err := cockpitWorkflowUUID(args[0], "meeting-id")
			if err != nil {
				return err
			}
			query, size, err := cockpitArtifactCLIQuery(cmd, cockpitArtifactOperation{page: true})
			if err != nil {
				return err
			}
			includeRemoved, _ := cmd.Flags().GetBool("include-removed")
			query.Set("include_removed", strconv.FormatBool(includeRemoved))
			client, err := newAPIClient(cmd)
			if err != nil {
				return err
			}
			ctx, cancel := cli.APIContext(context.Background())
			defer cancel()
			var result map[string]any
			if err = client.GetJSON(ctx, "/api/cockpit/meetings/"+url.PathEscape(meetingID)+"/artifact-references?"+query.Encode(), &result); err != nil {
				return err
			}
			items, ok := result["items"].([]any)
			cursor, hasCursor := result["next_cursor"]
			next, stringCursor := cursor.(string)
			valid := result["workspace_id"] == client.WorkspaceID && result["meeting_id"] == meetingID && result["include_removed"] == includeRemoved && ok && len(items) <= size && cockpitReceiptNumber(result["total"], float64(len(items))) && hasCursor && (cursor == nil || stringCursor && next != "" && next != query.Get("cursor"))
			seen := map[string]bool{}
			for _, raw := range items {
				item := artifactCLIMap(raw)
				id := cockpitNASReceiptUUID(item["id"])
				valid = valid && id != "" && !seen[id] && item["meeting_id"] == meetingID && item["node_id"] == nil && cockpitNASReceiptUUID(item["artifact_id"]) != "" && cockpitNASReceiptUUID(item["version_id"]) != "" && cockpitReceiptNumber(item["version_number"], 1) && artifactCLIHash(item["content_hash"]) && (includeRemoved || item["removed_at"] == nil)
				seen[id] = true
			}
			if !valid {
				return fmt.Errorf("meeting artifact response does not confirm fixed references, scope or page bounds")
			}
			return cli.PrintJSON(os.Stdout, result)
		}}
	cmd.Flags().Int("page-size", 25, "One page of 1-100 fixed references")
	cmd.Flags().String("cursor", "", "Opaque continuation for this meeting, history filter and page size")
	cmd.Flags().Bool("include-removed", false, "Include the history of explicitly removed references")
	return cmd
}

func newCockpitIssueArtifactsCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "artifacts <issue>", Args: exactArgs(1), Short: "Read one page of production, review and acceptance context for an Issue",
		RunE: func(cmd *cobra.Command, args []string) error {
			query, size, err := cockpitArtifactCLIQuery(cmd, cockpitArtifactOperation{page: true})
			if err != nil {
				return err
			}
			client, err := newAPIClient(cmd)
			if err != nil {
				return err
			}
			ctx, cancel := cli.APIContext(context.Background())
			defer cancel()
			issue, err := resolveIssueRef(ctx, client, args[0])
			if err != nil {
				return err
			}
			var result map[string]any
			if err = client.GetJSON(ctx, "/api/cockpit/issues/"+url.PathEscape(issue.ID)+"/artifacts?"+query.Encode(), &result); err != nil {
				return err
			}
			items, itemsOK := result["items"].([]any)
			cursor, hasCursor := result["next_cursor"]
			text, stringCursor := cursor.(string)
			valid := result["workspace_id"] == client.WorkspaceID && result["issue_id"] == issue.ID && itemsOK && len(items) <= size && cockpitReceiptNumber(result["total"], float64(len(items))) && hasCursor && (cursor == nil || stringCursor && text != "" && text != query.Get("cursor"))
			seen := map[string]bool{}
			for _, raw := range items {
				item := artifactCLIMap(raw)
				id, kind := cockpitNASReceiptUUID(item["id"]), strVal(item, "kind")
				roles, ok := item["roles"].([]any)
				valid = valid && id != "" && kind != "" && !seen[kind+":"+id] && ok && len(roles) > 0 && cockpitNASReceiptUUID(item["node_id"]) != ""
				seen[kind+":"+id] = true
				switch kind {
				case "artifact":
					valid = valid && item["artifact_id"] == id && item["version_id"] == nil && item["request_id"] == nil
				case "artifact_version":
					valid = valid && item["version_id"] == id && cockpitNASReceiptUUID(item["artifact_id"]) != "" && cockpitReceiptNumber(item["version_number"], 1) && item["request_id"] == nil
				case "acceptance_request":
					valid = valid && item["request_id"] == id && item["artifact_id"] == nil && item["version_id"] == nil
				}
			}
			if !valid {
				return fmt.Errorf("Issue artifact context response does not confirm its scope or bounded identities")
			}
			return cli.PrintJSON(os.Stdout, result)
		}}
	cmd.Flags().Int("page-size", 25, "One page of 1-100 context rows")
	cmd.Flags().String("cursor", "", "Opaque continuation for the same Issue and page size")
	return cmd
}
