package main

import (
	"context"
	"fmt"
	"net/url"
	"os"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/spf13/cobra"
)

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
