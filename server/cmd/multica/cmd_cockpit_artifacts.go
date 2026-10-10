package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/spf13/cobra"
)

type cockpitArtifactOperation struct {
	name, method, suffix string
	args                 int
	page                 bool
}

func newCockpitArtifactCommand() *cobra.Command {
	root := &cobra.Command{Use: "artifact", Short: "Manage fixed deliverables, production responsibility and human reviews",
		Long: "Read bounded artifact metadata or submit an explicit JSON command. Writes use --request-file; keep its command key and original body when retrying a lost response. A queued capture is not a completed or approved version. Formal decisions require the designated human; the server enforces authority."}
	for _, op := range []cockpitArtifactOperation{
		{"list", "GET", "", 0, true}, {"show", "GET", "", 1, false}, {"create", "POST", "", 0, false}, {"edit", "PATCH", "", 1, false},
		{"versions", "GET", "/versions", 1, true}, {"version", "GET", "/versions/{1}", 2, false}, {"submit", "POST", "/versions", 1, false},
		{"review", "POST", "/versions/{1}/review", 2, false}, {"retry-capture", "POST", "/versions/{1}/capture/retry", 2, false},
		{"download-link", "GET", "/versions/{1}/download-link", 2, false}, {"attachments", "GET", "/source-attachments", 1, true},
		{"assign-producer", "POST", "/producer", 1, false}, {"producer-history", "GET", "/producer-history", 1, true},
		{"reassign-reviewer", "POST", "/reviewer", 1, false}, {"reviewer-history", "GET", "/reviewer-handoffs", 1, true},
		{"archive", "POST", "/archive", 1, false}, {"unarchive", "POST", "/unarchive", 1, false},
		{"node-references", "GET", "/node-references", 1, true}, {"reference-node", "POST", "/node-references", 1, false}, {"remove-node-reference", "DELETE", "/node-references/{1}", 2, false},
		{"meeting-references", "GET", "/meeting-references", 1, true}, {"reference-meeting", "POST", "/meeting-references", 1, false}, {"remove-meeting-reference", "DELETE", "/meeting-references/{1}", 2, false},
	} {
		cmd := cockpitArtifactCLICommand(op, false)
		if op.name == "list" {
			cmd.Flags().String("project-id", "", "Optional owning project UUID")
			cmd.Flags().String("module-id", "", "Optional module UUID; requires project")
			cmd.Flags().String("node-id", "", "Optional L3 UUID")
			cmd.Flags().String("source-issue-id", "", "Optional original source Issue UUID")
			cmd.Flags().String("relation", "owned", "owned, referenced or all; non-owned requires --node-id")
			cmd.Flags().String("status", "", "Optional artifact status")
			cmd.Flags().String("ids", "", "Up to 100 comma-separated artifact UUIDs; cannot combine with query or status")
		}
		if op.name == "show" {
			cmd.Flags().String("node-id", "", "Optional L3 context for current evidence eligibility")
		}
		if op.name == "list" || op.name == "attachments" {
			cmd.Flags().String("query", "", "Search within this bounded page scope")
		}
		root.AddCommand(cmd)
	}
	return root
}

func newCockpitAcceptanceCommand() *cobra.Command {
	root := &cobra.Command{Use: "acceptance", Short: "Manage L3 criteria, fixed evidence requests and human acceptance"}
	for _, op := range []cockpitArtifactOperation{
		{"show", "GET", "", 1, false}, {"criteria", "GET", "/criteria", 1, false}, {"save-criteria", "PUT", "/criteria", 1, false},
		{"requests", "GET", "/requests", 1, true}, {"request", "GET", "/requests/{1}", 2, false}, {"submit", "POST", "/requests", 1, false},
		{"review", "POST", "/requests/{1}/review", 2, false}, {"reassign-reviewer", "POST", "/requests/{1}/reviewer", 2, false}, {"reviewer-history", "GET", "/reviewer-handoffs", 1, true},
	} {
		root.AddCommand(cockpitArtifactCLICommand(op, true))
	}
	return root
}

func cockpitArtifactCLICommand(op cockpitArtifactOperation, acceptance bool) *cobra.Command {
	use := op.name
	if op.args > 0 {
		if acceptance {
			use += " <node-id>"
		} else {
			use += " <artifact-id>"
		}
	}
	if op.args > 1 {
		if strings.Contains(op.name, "reference") {
			use += " <reference-id>"
		} else if acceptance {
			use += " <request-id>"
		} else {
			use += " <version-id>"
		}
	}
	cmd := &cobra.Command{Use: use, Args: exactArgs(op.args), Short: op.name + " with an exact scoped JSON response",
		RunE: func(cmd *cobra.Command, args []string) error { return runCockpitArtifactCLI(cmd, args, op, acceptance) }}
	if op.page {
		cmd.Flags().Int("page-size", 25, "One page of 1-100 records; no automatic continuation")
		cmd.Flags().String("cursor", "", "Opaque cursor from this exact query")
	}
	if op.method != "GET" && op.method != "DELETE" {
		cmd.Flags().String("request-file", "", "Required UTF-8 JSON command file, including observed revision and stable command key where applicable")
	}
	return cmd
}

func cockpitArtifactCLIQuery(cmd *cobra.Command, op cockpitArtifactOperation) (url.Values, int, error) {
	query, size := url.Values{}, 0
	if op.page {
		size, _ = cmd.Flags().GetInt("page-size")
		cursor, _ := cmd.Flags().GetString("cursor")
		if size < 1 || size > 100 || len(cursor) > 4096 {
			return nil, 0, fmt.Errorf("page size must be 1-100 and cursor at most 4096 bytes")
		}
		query.Set("page_size", strconv.Itoa(size))
		if cursor != "" {
			query.Set("cursor", cursor)
		}
	}
	for _, flag := range []string{"project-id", "module-id", "node-id", "source-issue-id"} {
		if cmd.Flags().Lookup(flag) != nil && cmd.Flags().Changed(flag) {
			value, _ := cmd.Flags().GetString(flag)
			id, err := cockpitWorkflowUUID(value, "--"+flag)
			if err != nil {
				return nil, 0, err
			}
			query.Set(strings.ReplaceAll(flag, "-", "_"), id)
		}
	}
	if query.Get("module_id") != "" && query.Get("project_id") == "" {
		return nil, 0, fmt.Errorf("--module-id requires --project-id")
	}
	for _, flag := range []string{"query", "status", "relation"} {
		if cmd.Flags().Lookup(flag) == nil {
			continue
		}
		value, _ := cmd.Flags().GetString(flag)
		value = strings.TrimSpace(value)
		if len(value) > 512 {
			return nil, 0, fmt.Errorf("--%s exceeds 512 bytes", flag)
		}
		if flag == "relation" && (value != "owned" && value != "referenced" && value != "all" || value != "owned" && query.Get("node_id") == "") {
			return nil, 0, fmt.Errorf("--relation must be owned, referenced or all; non-owned requires --node-id")
		}
		if value != "" {
			if flag == "query" {
				flag = "q"
			}
			query.Set(flag, value)
		}
	}
	if cmd.Flags().Lookup("ids") != nil && cmd.Flags().Changed("ids") {
		raw, _ := cmd.Flags().GetString("ids")
		values := strings.Split(raw, ",")
		if len(values) > 100 || query.Get("q") != "" || query.Get("status") != "" {
			return nil, 0, fmt.Errorf("--ids accepts at most 100 UUIDs without --query or --status")
		}
		for i, value := range values {
			id, err := cockpitWorkflowUUID(value, "--ids")
			if err != nil {
				return nil, 0, err
			}
			values[i] = id
		}
		slices.Sort(values)
		query.Set("ids", strings.Join(slices.Compact(values), ","))
	}
	return query, size, nil
}

func cockpitArtifactCLIReadBody(cmd *cobra.Command, action string, acceptance bool) (map[string]any, error) {
	filename, _ := cmd.Flags().GetString("request-file")
	if filename == "" {
		return nil, fmt.Errorf("--request-file is required; retain the exact command file when retrying")
	}
	file, err := os.Open(filename)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, (2<<20)+1))
	if err != nil {
		return nil, err
	}
	var body map[string]any
	if len(data) > 2<<20 || json.Unmarshal(data, &body) != nil || body == nil {
		return nil, fmt.Errorf("request file must contain one JSON object of at most 2 MiB")
	}
	if err := validateCockpitArtifactCLICommand(action, acceptance, body); err != nil {
		return nil, err
	}
	return body, nil
}

func runCockpitArtifactCLI(cmd *cobra.Command, args []string, op cockpitArtifactOperation, acceptance bool) error {
	ids := make([]string, len(args))
	for i, value := range args {
		var err error
		ids[i], err = cockpitWorkflowUUID(value, fmt.Sprintf("argument %d", i+1))
		if err != nil {
			return err
		}
	}
	query, size, err := cockpitArtifactCLIQuery(cmd, op)
	if err != nil {
		return err
	}
	var body map[string]any
	if op.method != "GET" && op.method != "DELETE" {
		body, err = cockpitArtifactCLIReadBody(cmd, op.name, acceptance)
		if err != nil {
			return err
		}
	}
	endpoint := "/api/cockpit/artifacts"
	if len(ids) > 0 {
		endpoint += "/" + url.PathEscape(ids[0])
	}
	if acceptance {
		endpoint = "/api/cockpit/nodes/" + url.PathEscape(ids[0]) + "/acceptance"
	}
	suffix := op.suffix
	if len(ids) > 1 {
		suffix = strings.ReplaceAll(suffix, "{1}", url.PathEscape(ids[1]))
	}
	endpoint += suffix
	if len(query) > 0 {
		endpoint += "?" + query.Encode()
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	var result map[string]any
	switch op.method {
	case "GET":
		err = client.GetJSON(ctx, endpoint, &result)
	case "POST":
		err = client.PostJSON(ctx, endpoint, body, &result)
	case "PATCH":
		err = client.PatchJSON(ctx, endpoint, body, &result)
	case "PUT":
		err = client.PutJSON(ctx, endpoint, body, &result)
	case "DELETE":
		err = client.DeleteJSONResponse(ctx, endpoint, &result)
	}
	if err != nil {
		return err
	}
	if !confirmCockpitArtifactCLIReceipt(op, acceptance, ids, query, size, body, result, client.WorkspaceID) {
		return fmt.Errorf("artifact or acceptance response was not confirmed; inspect the exact operation and retry the same command key, never generate a replacement key for an unknown result")
	}
	return cli.PrintJSON(os.Stdout, result)
}
