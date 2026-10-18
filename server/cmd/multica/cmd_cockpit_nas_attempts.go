package main

import (
	"context"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"path"
	"strings"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/spf13/cobra"
)

func cockpitNASWriteMode(value map[string]any) string {
	mode, present := value["write_mode"]
	if !present {
		return "atomic"
	}
	text, _ := mode.(string)
	return text
}

func validCockpitNASCopyEvidence(row map[string]any) bool {
	mode := cockpitNASWriteMode(row)
	if mode == "atomic" {
		return true
	}
	if mode != "create_only" {
		return false
	}
	if row["status"] != "succeeded" {
		return true
	}
	directory, _ := row["directory"].(string)
	logical, _ := row["target_path"].(string)
	verified, _ := row["verified_path"].(string)
	receipt, _ := row["receipt_path"].(string)
	hash, _ := row["receipt_hash"].(string)
	decoded, err := hex.DecodeString(hash)
	operation, attempt := cockpitNASReceiptUUID(row["id"]), cockpitNASReceiptUUID(row["verified_attempt_id"])
	if !path.IsAbs(directory) || !path.IsAbs(logical) || path.Clean(logical) != logical || !strings.HasPrefix(logical, strings.TrimRight(directory, "/")+"/") || operation == "" || attempt == "" ||
		err != nil || len(decoded) != 32 || fmt.Sprintf("%x", decoded) != hash || !cockpitReceiptNumber(row["size_bytes"], 1) {
		return false
	}
	expected := path.Join(path.Dir(logical), operation, attempt)
	return verified == path.Join(expected, path.Base(logical)) && receipt == path.Join(expected, ".multica-complete.json")
}

func addCockpitNASAttemptCommand(parent *cobra.Command) {
	cmd := &cobra.Command{Use: "export-attempts <meeting-id> <export-id>", Args: exactArgs(2), Short: "Read one bounded page of recorded NAS attempts",
		RunE: func(cmd *cobra.Command, args []string) error {
			meeting, err := cockpitWorkflowUUID(args[0], "meeting-id")
			if err != nil {
				return err
			}
			exportID, err := cockpitWorkflowUUID(args[1], "export-id")
			if err != nil {
				return err
			}
			size, _ := cmd.Flags().GetInt("page-size")
			if size < 1 || size > 100 {
				return fmt.Errorf("--page-size must be between 1 and 100")
			}
			cursor, _ := cmd.Flags().GetString("cursor")
			query := url.Values{"page_size": {fmt.Sprint(size)}}
			if cursor != "" {
				query.Set("cursor", cursor)
			}
			client, err := newAPIClient(cmd)
			if err != nil {
				return err
			}
			ctx, cancel := cli.APIContext(context.Background())
			defer cancel()
			var result map[string]any
			endpoint := "/api/cockpit/meetings/" + url.PathEscape(meeting) + "/workflow/exports/" + url.PathEscape(exportID) + "/attempts?" + query.Encode()
			if err := client.GetJSON(ctx, endpoint, &result); err != nil {
				return err
			}
			items, ok := result["items"].([]any)
			next, hasNext := result["next_cursor"]
			_, nextString := next.(string)
			valid := result["workspace_id"] == client.WorkspaceID && result["meeting_id"] == meeting && result["export_id"] == exportID && ok && len(items) <= size &&
				cockpitReceiptNumber(result["total"], float64(len(items))) && hasNext && (next == nil || nextString)
			for _, value := range items {
				row, ok := value.(map[string]any)
				_, hasBody := row["content"]
				hash, _ := row["content_hash"].(string)
				decoded, err := hex.DecodeString(hash)
				valid = valid && ok && !hasBody && cockpitNASReceiptUUID(row["id"]) != "" && cockpitReceiptNumber(row["attempt_number"], 1) && err == nil && len(decoded) == 32
			}
			if !valid {
				return fmt.Errorf("NAS attempt page did not confirm its workspace, operation or metadata bounds")
			}
			return cli.PrintJSON(os.Stdout, result)
		}}
	cmd.Flags().Int("page-size", 25, "One page of 1-100 attempt records; does not scan storage")
	cmd.Flags().String("cursor", "", "Opaque cursor from the same export and page size")
	parent.AddCommand(cmd)
}
