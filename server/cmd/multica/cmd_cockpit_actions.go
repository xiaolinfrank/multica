package main

import (
	"context"
	"fmt"
	"math"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/spf13/cobra"
)

func cockpitPageFlags(cmd *cobra.Command) {
	cmd.Flags().String("query", "", "Server-side search; change filters only after clearing the cursor")
	cmd.Flags().String("status", "", "Exact status filter")
	cmd.Flags().String("cursor", "", "Opaque next_cursor from the same scope and filters")
	cmd.Flags().Int("page-size", 25, "Items in this page (1-100); does not fetch every page")
}

func cockpitNewTaskFlags(cmd *cobra.Command) {
	cmd.Flags().String("assignee-type", "", "member, agent or squad; requires --assignee-id; defaults to the current human")
	cmd.Flags().String("assignee-id", "", "Executor UUID; requires --assignee-type; creation does not dispatch an agent")
	cmd.Flags().String("priority", "none", "urgent, high, medium, low or none")
	cmd.Flags().String("due-date", "", "Optional due date (YYYY-MM-DD)")
}

func newCockpitMeetingActionCommand() *cobra.Command {
	root := &cobra.Command{Use: "action", Short: "Review actions from fixed, published meeting minutes",
		Long: "List bounded pages of meeting actions, or explicitly propose, edit and resolve them with a human credential. " +
			"Accepted actions use existing issues; creation enters backlog without starting an agent. Reuse preserves issue fields."}
	for _, verb := range []string{"list", "show", "add", "edit", "resolve"} {
		use, count := verb+" <meeting-id>", 1
		if verb == "add" {
			use, count = use+" <version-id>", 2
		} else if verb == "show" || verb == "edit" || verb == "resolve" {
			use, count = use+" <action-id>", 2
		}
		cmd := &cobra.Command{Use: use, Args: exactArgs(count), Short: verb + " meeting actions",
			RunE: func(cmd *cobra.Command, args []string) error { return runCockpitMeetingAction(cmd, args, verb) }}
		switch verb {
		case "list":
			cockpitPageFlags(cmd)
			cmd.Flags().String("version-id", "", "Filter by a fixed minutes version UUID")
		case "add", "edit":
			cmd.Flags().String("title", "", "Required action title")
			cmd.Flags().String("description", "", "Action description; edit requires this flag explicitly (empty clears)")
			cmd.Flags().String("source-quote", "", "Exact excerpt of the fixed source version; edit requires this flag explicitly (empty clears)")
			if verb == "add" {
				cmd.Flags().String("proposal-key", "", "Required UUID; retain this key and payload when retrying the same proposal")
			} else {
				cmd.Flags().Int64("revision", 0, "Required action revision observed in action list")
			}
		case "resolve":
			cmd.Flags().Int64("revision", 0, "Required action revision, not the meeting workflow revision")
			cmd.Flags().String("decision-key", "", "Required UUID; retain this key and payload when retrying this decision")
			cmd.Flags().String("outcome", "", "Required: create, reuse or dismiss")
			cmd.Flags().String("node-id", "", "Required L3 UUID for create/reuse; no implicit project or module move")
			cmd.Flags().String("issue-id", "", "Required existing issue UUID or identifier for reuse")
			cmd.Flags().String("reason", "", "Reason for this decision; required for dismiss")
			cockpitNewTaskFlags(cmd)
		}
		root.AddCommand(cmd)
	}
	return root
}

func cockpitPageQuery(cmd *cobra.Command) (url.Values, error) {
	values := url.Values{}
	size, _ := cmd.Flags().GetInt("page-size")
	if size < 1 || size > 100 {
		return nil, fmt.Errorf("--page-size must be between 1 and 100")
	}
	values.Set("page_size", fmt.Sprint(size))
	for _, field := range []struct{ flag, key string }{{"query", "q"}, {"status", "status"}, {"cursor", "cursor"}} {
		value, _ := cmd.Flags().GetString(field.flag)
		if value != "" {
			values.Set(field.key, value)
		}
	}
	return values, nil
}

func cockpitActionRevision(cmd *cobra.Command, allowZero bool) (int64, error) {
	revision, _ := cmd.Flags().GetInt64("revision")
	if !cmd.Flags().Changed("revision") || revision < 0 || (!allowZero && revision == 0) {
		return 0, fmt.Errorf("--revision is required and must be %s", map[bool]string{true: "non-negative", false: "positive"}[allowZero])
	}
	return revision, nil
}

func cockpitNewTaskBody(cmd *cobra.Command, body map[string]any) error {
	hasType, hasID := cmd.Flags().Changed("assignee-type"), cmd.Flags().Changed("assignee-id")
	if hasType != hasID {
		return fmt.Errorf("--assignee-type and --assignee-id must be supplied together")
	}
	if hasType {
		kind, _ := cmd.Flags().GetString("assignee-type")
		if kind != "member" && kind != "agent" && kind != "squad" {
			return fmt.Errorf("--assignee-type must be member, agent or squad")
		}
		value, _ := cmd.Flags().GetString("assignee-id")
		id, err := cockpitWorkflowUUID(value, "--assignee-id")
		if err != nil {
			return err
		}
		body["assignee_type"], body["assignee_id"] = kind, id
	}
	priority, _ := cmd.Flags().GetString("priority")
	if priority != "urgent" && priority != "high" && priority != "medium" && priority != "low" && priority != "none" {
		return fmt.Errorf("--priority must be urgent, high, medium, low or none")
	}
	body["priority"] = priority
	if cmd.Flags().Changed("due-date") {
		date, _ := cmd.Flags().GetString("due-date")
		if _, err := time.Parse("2006-01-02", date); err != nil {
			return fmt.Errorf("--due-date must be a valid YYYY-MM-DD date")
		}
		body["due_date"] = date
	}
	return nil
}

func cockpitActionBody(cmd *cobra.Command, verb string) (map[string]any, error) {
	body := map[string]any{}
	if verb == "edit" || verb == "resolve" {
		revision, err := cockpitActionRevision(cmd, false)
		if err != nil {
			return nil, err
		}
		body["expected_revision"] = revision
	}
	if verb == "add" || verb == "edit" {
		for _, field := range []struct{ flag, key string }{{"title", "title"}, {"description", "description"}, {"source-quote", "source_quote"}} {
			value, _ := cmd.Flags().GetString(field.flag)
			if field.flag != "source-quote" || strings.TrimSpace(value) == "" {
				value = strings.TrimSpace(value)
			}
			if field.flag == "title" && value == "" {
				return nil, fmt.Errorf("--title must not be empty")
			}
			if verb == "edit" && !cmd.Flags().Changed(field.flag) {
				return nil, fmt.Errorf("edit replaces all proposal text: provide --%s explicitly", field.flag)
			}
			body[field.key] = value
		}
		if verb == "add" {
			value, _ := cmd.Flags().GetString("proposal-key")
			key, err := cockpitWorkflowUUID(value, "--proposal-key")
			if err != nil {
				return nil, err
			}
			body["proposal_key"] = key
		}
		return body, nil
	}
	if verb != "resolve" {
		return body, nil
	}
	value, _ := cmd.Flags().GetString("decision-key")
	key, err := cockpitWorkflowUUID(value, "--decision-key")
	if err != nil {
		return nil, err
	}
	body["decision_key"] = key
	outcome, _ := cmd.Flags().GetString("outcome")
	if outcome != "create" && outcome != "reuse" && outcome != "dismiss" {
		return nil, fmt.Errorf("--outcome must be create, reuse or dismiss")
	}
	body["outcome"] = outcome
	reason, _ := cmd.Flags().GetString("reason")
	reason = strings.TrimSpace(reason)
	if reason != "" {
		body["reason"] = reason
	}
	if outcome == "dismiss" {
		if reason == "" {
			return nil, fmt.Errorf("--reason is required for dismiss")
		}
		if cmd.Flags().Changed("node-id") || cmd.Flags().Changed("issue-id") {
			return nil, fmt.Errorf("dismiss cannot assign a node or issue")
		}
	} else {
		value, _ := cmd.Flags().GetString("node-id")
		node, err := cockpitWorkflowUUID(value, "--node-id")
		if err != nil {
			return nil, err
		}
		body["node_id"] = node
	}
	if outcome == "reuse" {
		issue, _ := cmd.Flags().GetString("issue-id")
		if strings.TrimSpace(issue) == "" {
			return nil, fmt.Errorf("--issue-id is required for reuse")
		}
		body["issue_id"] = strings.TrimSpace(issue)
	} else if cmd.Flags().Changed("issue-id") {
		return nil, fmt.Errorf("--issue-id is only valid for reuse")
	}
	if outcome != "create" {
		for _, flag := range []string{"assignee-type", "assignee-id", "priority", "due-date"} {
			if cmd.Flags().Changed(flag) {
				return nil, fmt.Errorf("--%s is only valid for create; reuse preserves issue fields", flag)
			}
		}
	} else if err := cockpitNewTaskBody(cmd, body); err != nil {
		return nil, err
	}
	return body, nil
}

func cockpitReceiptNumber(value any, minimum float64) bool {
	n, ok := value.(float64)
	return ok && n >= minimum && n <= 9007199254740991 && math.Trunc(n) == n
}

func confirmCockpitPage(result map[string]any, scope, id string) error {
	_, itemsOK := result["items"].([]any)
	cursor, hasCursor := result["next_cursor"]
	_, cursorOK := cursor.(string)
	if result[scope] != id || !itemsOK || !cockpitReceiptNumber(result["total"], 0) ||
		!cockpitReceiptNumber(result["filtered_total"], 0) || !hasCursor || (cursor != nil && !cursorOK) {
		return fmt.Errorf("server did not return a valid scoped page; no complete-list claim can be made")
	}
	return nil
}

func confirmCockpitAction(verb, meeting, resource string, body, result map[string]any) error {
	valid := cockpitNASReceiptUUID(result["id"]) != "" && result["meeting_id"] == meeting &&
		cockpitNASReceiptUUID(result["version_id"]) != "" && cockpitReceiptNumber(result["revision"], 1)
	switch verb {
	case "show":
		valid = valid && result["id"] == resource
	case "add":
		valid = valid && result["version_id"] == resource && result["proposal_key"] == body["proposal_key"]
	case "edit":
		valid = valid && result["id"] == resource && result["title"] == body["title"] &&
			result["description"] == body["description"] && result["source_quote"] == body["source_quote"]
		if valid {
			valid = result["revision"].(float64) > float64(body["expected_revision"].(int64))
		}
	case "resolve":
		valid = valid && result["id"] == resource && result["decision_key"] == body["decision_key"] && result["resolution"] == body["outcome"]
		if body["outcome"] == "dismiss" {
			valid = valid && result["status"] == "dismissed" && result["reason"] == body["reason"]
		} else {
			issue, _ := result["issue"].(map[string]any)
			valid = valid && result["status"] == "accepted" && result["node_id"] == body["node_id"] && cockpitNASReceiptUUID(issue["id"]) != ""
			if body["outcome"] == "reuse" {
				valid = valid && issue["id"] == body["issue_id"]
			}
		}
	}
	if !valid {
		return fmt.Errorf("action may have changed, but its receipt was not confirmed; reload action list and retain the original request key before retrying")
	}
	return nil
}

func runCockpitMeetingAction(cmd *cobra.Command, args []string, verb string) error {
	meeting, err := cockpitWorkflowUUID(args[0], "meeting-id")
	if err != nil {
		return err
	}
	body, err := cockpitActionBody(cmd, verb)
	if err != nil {
		return err
	}
	resource := ""
	base := "/api/cockpit/meetings/" + meeting + "/workflow"
	endpoint := base + "/actions"
	if verb == "list" {
		query, err := cockpitPageQuery(cmd)
		if err != nil {
			return err
		}
		version, _ := cmd.Flags().GetString("version-id")
		if cmd.Flags().Changed("version-id") {
			version, err = cockpitWorkflowUUID(version, "--version-id")
			if err != nil {
				return err
			}
			query.Set("version_id", version)
		}
		endpoint += "?" + query.Encode()
	} else {
		resource, err = cockpitWorkflowUUID(args[1], "version-id/action-id")
		if err != nil {
			return err
		}
		if verb == "add" {
			endpoint = base + "/versions/" + resource + "/actions"
		} else {
			endpoint += "/" + resource
			if verb == "resolve" {
				endpoint += "/resolve"
			}
		}
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	if verb == "resolve" && body["outcome"] == "reuse" {
		issue, err := resolveIssueRef(ctx, client, body["issue_id"].(string))
		if err != nil {
			return err
		}
		body["issue_id"] = issue.ID
	}
	var result map[string]any
	switch verb {
	case "list", "show":
		err = client.GetJSON(ctx, endpoint, &result)
	case "edit":
		err = client.PatchJSON(ctx, endpoint, body, &result)
	default:
		err = client.PostJSON(ctx, endpoint, body, &result)
	}
	if err != nil {
		return err
	}
	if verb == "list" {
		err = confirmCockpitPage(result, "meeting_id", meeting)
	} else {
		err = confirmCockpitAction(verb, meeting, resource, body, result)
	}
	if err != nil {
		return err
	}
	return cli.PrintJSON(os.Stdout, result)
}

func newCockpitNodeTasksCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "tasks <node-id>", Args: exactArgs(1), Short: "Read one bounded page of L3 tasks and full-scope counts",
		RunE: func(cmd *cobra.Command, args []string) error {
			node, err := cockpitWorkflowUUID(args[0], "node-id")
			if err != nil {
				return err
			}
			query, err := cockpitPageQuery(cmd)
			if err != nil {
				return err
			}
			relation, _ := cmd.Flags().GetString("relation")
			if relation != "primary" && relation != "reference" {
				return fmt.Errorf("--relation must be primary or reference")
			}
			query.Set("relation", relation)
			category, _ := cmd.Flags().GetString("category")
			if category != "" {
				if category != "active" && category != "unstarted" && category != "started" && category != "done" && category != "closed" && category != "unknown" {
					return fmt.Errorf("--category must be active, unstarted, started, done, closed or unknown")
				}
				query.Set("category", category)
			}
			client, err := newAPIClient(cmd)
			if err != nil {
				return err
			}
			ctx, cancel := cli.APIContext(context.Background())
			defer cancel()
			var result map[string]any
			if err := client.GetJSON(ctx, "/api/cockpit/nodes/"+node+"/tasks?"+query.Encode(), &result); err != nil {
				return err
			}
			if err := confirmCockpitPage(result, "node_id", node); err != nil {
				return err
			}
			return cli.PrintJSON(os.Stdout, result)
		}}
	cockpitPageFlags(cmd)
	cmd.Flags().String("relation", "primary", "primary tasks or legacy reference links; references do not imply ownership")
	cmd.Flags().String("category", "", "Lifecycle category or active (excludes done/closed); combined with the exact status filter")
	return cmd
}

func newCockpitNodeCreateTaskCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "create-task <node-id>", Args: exactArgs(1), Short: "Atomically create a backlog issue with L3 primary ownership",
		RunE: func(cmd *cobra.Command, args []string) error {
			node, err := cockpitWorkflowUUID(args[0], "node-id")
			if err != nil {
				return err
			}
			value, _ := cmd.Flags().GetString("creation-key")
			key, err := cockpitWorkflowUUID(value, "--creation-key")
			if err != nil {
				return err
			}
			title, _ := cmd.Flags().GetString("title")
			if strings.TrimSpace(title) == "" {
				return fmt.Errorf("--title must not be empty")
			}
			description, _ := cmd.Flags().GetString("description")
			body := map[string]any{"creation_key": key, "title": strings.TrimSpace(title), "description": strings.TrimSpace(description)}
			if err := cockpitNewTaskBody(cmd, body); err != nil {
				return err
			}
			client, err := newAPIClient(cmd)
			if err != nil {
				return err
			}
			ctx, cancel := cli.APIContext(context.Background())
			defer cancel()
			var result map[string]any
			if err := client.PostJSON(ctx, "/api/cockpit/nodes/"+node+"/tasks", body, &result); err != nil {
				return err
			}
			if cockpitNASReceiptUUID(result["id"]) == "" || result["creation_key"] != key {
				return fmt.Errorf("task creation may have succeeded; reload node tasks and retain the original creation key before retrying")
			}
			return cli.PrintJSON(os.Stdout, result)
		}}
	cmd.Flags().String("creation-key", "", "Required UUID; retain this key and payload when retrying")
	cmd.Flags().String("title", "", "Required issue title")
	cmd.Flags().String("description", "", "Issue description")
	cockpitNewTaskFlags(cmd)
	return cmd
}

func newCockpitIssueCommand() *cobra.Command {
	root := &cobra.Command{Use: "issue", Short: "Manage an issue's explicit cockpit ownership"}
	cmd := &cobra.Command{Use: "primary <issue>", Args: exactArgs(1), Short: "Read primary ownership, or set/clear it with an observed revision",
		RunE: func(cmd *cobra.Command, args []string) error {
			set, clear := cmd.Flags().Changed("node-id"), cmd.Flags().Changed("clear")
			body := map[string]any{}
			if set && clear {
				return fmt.Errorf("choose either --node-id or --clear")
			}
			if !set && !clear && cmd.Flags().Changed("revision") {
				return fmt.Errorf("--revision requires --node-id or --clear")
			}
			if set || clear {
				revision, err := cockpitActionRevision(cmd, true)
				if err != nil {
					return err
				}
				body["expected_revision"], body["node_id"] = revision, nil
				if set {
					value, _ := cmd.Flags().GetString("node-id")
					node, err := cockpitWorkflowUUID(value, "--node-id")
					if err != nil {
						return err
					}
					body["node_id"] = node
				} else if value, _ := cmd.Flags().GetBool("clear"); !value {
					return fmt.Errorf("--clear=false is not an ownership command")
				}
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
			endpoint := "/api/cockpit/issues/" + url.PathEscape(issue.ID) + "/primary-node"
			if set || clear {
				err = client.PutJSON(ctx, endpoint, body, &result)
			} else {
				err = client.GetJSON(ctx, endpoint, &result)
			}
			if err != nil {
				return err
			}
			node, hasNode := result["node_id"]
			valid := result["issue_id"] == issue.ID && cockpitReceiptNumber(result["revision"], 0) && hasNode &&
				(node == nil || cockpitNASReceiptUUID(node) != "")
			if set || clear {
				valid = valid && node == body["node_id"]
				if valid {
					valid = result["revision"].(float64) >= float64(body["expected_revision"].(int64))
				}
			}
			if !valid {
				return fmt.Errorf("primary ownership receipt was not confirmed; reload before retrying a change")
			}
			return cli.PrintJSON(os.Stdout, result)
		}}
	cmd.Flags().String("node-id", "", "Set a primary L3 UUID; preserves the issue's project and module")
	cmd.Flags().Bool("clear", false, "Explicitly clear primary ownership")
	cmd.Flags().Int64("revision", 0, "Required ownership revision for a change; 0 only when no ownership record exists")
	root.AddCommand(cmd)
	return root
}
