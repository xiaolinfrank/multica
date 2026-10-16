package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"strconv"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/spf13/cobra"
)

func newCockpitChangeCommand() *cobra.Command {
	root := &cobra.Command{Use: "change", Short: "Read and propose plan changes; human decisions stay in the cockpit"}
	for _, action := range []string{"list", "propose", "ingest", "preview", "withdraw"} {
		count, use := 0, action
		if action == "preview" || action == "withdraw" {
			count, use = 1, action+" <change-id>"
		}
		cmd := &cobra.Command{Use: use, Args: exactArgs(count), Short: action + " plan changes",
			RunE: func(cmd *cobra.Command, args []string) error { return runCockpitChange(cmd, args, action) }}
		switch action {
		case "ingest":
			cmd.Flags().String("file", "", `JSON proposals: an array of {"node","field","new_value","reason"} or an object with a "changes" array; "-" or omitting reads stdin`)
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
	case "ingest":
		path, _ := cmd.Flags().GetString("file")
		raw, err := readCockpitIngestFile(cmd, path)
		if err != nil {
			return err
		}
		var doc struct {
			Changes []map[string]any `json:"changes"`
		}
		trimmed := []byte{}
		for _, b := range raw {
			if b != ' ' && b != '\t' && b != '\r' && b != '\n' {
				trimmed = append(trimmed, b)
			}
		}
		if len(trimmed) > 0 && trimmed[0] == '[' {
			if err := json.Unmarshal(raw, &doc.Changes); err != nil {
				return fmt.Errorf("ingest: proposals are not a JSON array: %w", err)
			}
		} else if err := json.Unmarshal(raw, &doc); err != nil {
			return fmt.Errorf("ingest: file is neither a proposal array nor an object with a changes array: %w", err)
		}
		if len(doc.Changes) == 0 {
			return fmt.Errorf("ingest: no proposals found")
		}
		if len(doc.Changes) > 500 {
			return fmt.Errorf("ingest: at most 500 proposals per request, got %d", len(doc.Changes))
		}
		endpoint += "/ingest"
		body["changes"] = doc.Changes
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

// readCockpitIngestFile reads the proposals document from a path, or from
// stdin when the path is empty or "-": agents pipe a report's observations
// straight into the funnel.
func readCockpitIngestFile(cmd *cobra.Command, path string) ([]byte, error) {
	if path != "" && path != "-" {
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("ingest: read %s: %w", path, err)
		}
		return raw, nil
	}
	raw, err := io.ReadAll(cmd.InOrStdin())
	if err != nil {
		return nil, fmt.Errorf("ingest: read stdin: %w", err)
	}
	return raw, nil
}
