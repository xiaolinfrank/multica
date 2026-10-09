package main

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"time"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/spf13/cobra"
)

func newCockpitOverviewCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "overview", Args: exactArgs(0), Short: "Read the bounded project work overview",
		Long: "Read current project facts using an explicit local calendar date for deadlines and meeting windows. " +
			"This is not a historical snapshot. Unresolved work remains visible regardless of age. No action is executed by these reads.",
		RunE: func(cmd *cobra.Command, _ []string) error { return runCockpitOverview(cmd, "") }}
	cmd.PersistentFlags().String("as-of", "", "Required local calendar date (YYYY-MM-DD); do not infer it from the server timezone")
	cmd.PersistentFlags().String("project-id", "", "Optional project UUID; omitted means the workspace scope")
	cmd.PersistentFlags().String("view", "mine", "mine or team; applies to attention only, not overall execution counts")
	for _, section := range []string{"attention", "execution", "meetings"} {
		child := &cobra.Command{Use: section, Args: exactArgs(0), Short: "Read one bounded " + section + " page",
			RunE: func(cmd *cobra.Command, _ []string) error { return runCockpitOverview(cmd, section) }}
		child.Flags().String("cursor", "", "Opaque cursor from the same scope, filters and page size")
		child.Flags().Int("page-size", 25, "One page of 1-100 items; does not fetch all pages")
		if section == "attention" {
			child.Flags().String("kind", "", "Optional filter: workflow, action, nas or issue")
		}
		if section == "meetings" {
			child.Flags().Int("days", 30, "Past calendar days to include (1-90); response also covers the next seven days")
		}
		cmd.AddCommand(child)
	}
	return cmd
}

func cockpitOverviewQuery(cmd *cobra.Command, section string) (url.Values, error) {
	q := url.Values{}
	day, _ := cmd.Flags().GetString("as-of")
	if _, err := time.Parse("2006-01-02", day); err != nil {
		return nil, fmt.Errorf("--as-of requires a valid local YYYY-MM-DD calendar date")
	}
	q.Set("as_of", day)
	if cmd.Flags().Changed("project-id") {
		value, _ := cmd.Flags().GetString("project-id")
		id, err := cockpitWorkflowUUID(value, "--project-id")
		if err != nil {
			return nil, err
		}
		q.Set("project_id", id)
	}
	view, _ := cmd.Flags().GetString("view")
	if view != "mine" && view != "team" {
		return nil, fmt.Errorf("--view must be mine or team")
	}
	if section == "" {
		q.Set("attention_view", view)
	} else if section == "attention" {
		q.Set("view", view)
		kind, _ := cmd.Flags().GetString("kind")
		if kind != "" && kind != "workflow" && kind != "action" && kind != "nas" && kind != "issue" {
			return nil, fmt.Errorf("--kind must be workflow, action, nas or issue")
		}
		if kind != "" {
			q.Set("kind", kind)
		}
	} else if cmd.Flags().Changed("view") {
		return nil, fmt.Errorf("--view applies only to the overview or attention pages")
	}
	if section != "" {
		size, _ := cmd.Flags().GetInt("page-size")
		if size < 1 || size > 100 {
			return nil, fmt.Errorf("--page-size must be between 1 and 100")
		}
		q.Set("page_size", fmt.Sprint(size))
		cursor, _ := cmd.Flags().GetString("cursor")
		if cursor != "" {
			q.Set("cursor", cursor)
		}
	}
	if section == "meetings" {
		days, _ := cmd.Flags().GetInt("days")
		if days < 1 || days > 90 {
			return nil, fmt.Errorf("--days must be between 1 and 90")
		}
		q.Set("days", fmt.Sprint(days))
	}
	return q, nil
}

func confirmCockpitOverviewScope(value map[string]any, ws string, q url.Values) bool {
	project, present := value["project_id"]
	if value["workspace_id"] != ws || value["as_of"] != q.Get("as_of") || !present {
		return false
	}
	if requested := q.Get("project_id"); requested != "" {
		if project != requested {
			return false
		}
	} else if project != nil {
		return false
	}
	stamp, _ := value["generated_at"].(string)
	_, err := time.Parse(time.RFC3339Nano, stamp)
	return err == nil
}

func confirmCockpitOverviewPage(value map[string]any, ws string, q url.Values, limit int) bool {
	items, ok := value["items"].([]any)
	cursor, present := value["next_cursor"]
	_, stringCursor := cursor.(string)
	return confirmCockpitOverviewScope(value, ws, q) && ok && len(items) <= limit &&
		cockpitReceiptNumber(value["total"], float64(len(items))) && present && (cursor == nil || stringCursor)
}

func confirmCockpitOverviewCounts(value any, fields ...string) bool {
	counts, ok := value.(map[string]any)
	if !ok {
		return false
	}
	for _, key := range fields {
		if !cockpitReceiptNumber(counts[key], 0) {
			return false
		}
	}
	return true
}

func confirmCockpitOverviewSummary(value any) bool {
	summary, ok := value.(map[string]any)
	if !ok {
		return false
	}
	fields := []string{"total", "active", "unstarted", "started", "done", "closed", "unknown", "overdue", "blocked", "unassigned"}
	attention, _ := summary["attention"].(map[string]any)
	return confirmCockpitOverviewCounts(summary["primary_issues"], fields...) &&
		confirmCockpitOverviewCounts(summary["my_primary_issues"], fields...) &&
		confirmCockpitOverviewCounts(summary["execution_nodes"], "total", "with_active_issues") &&
		confirmCockpitOverviewCounts(attention, "team_total", "mine_total") &&
		confirmCockpitOverviewCounts(attention["team_by_kind"], "workflow", "action", "nas", "issue") &&
		confirmCockpitOverviewCounts(attention["mine_by_kind"], "workflow", "action", "nas", "issue")
}

func confirmCockpitOverviewMeetingWindow(value map[string]any, day string, days int) bool {
	date, err := time.Parse("2006-01-02", day)
	return err == nil && value["range_start"] == date.AddDate(0, 0, 1-days).Format("2006-01-02") &&
		value["range_end"] == date.AddDate(0, 0, 7).Format("2006-01-02")
}

func runCockpitOverview(cmd *cobra.Command, section string) error {
	query, err := cockpitOverviewQuery(cmd, section)
	if err != nil {
		return err
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	endpoint := "/api/cockpit/overview"
	if section != "" {
		endpoint += "/" + section
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	var result map[string]any
	if err := client.GetJSON(ctx, endpoint+"?"+query.Encode(), &result); err != nil {
		return err
	}
	valid := confirmCockpitOverviewScope(result, client.WorkspaceID, query)
	view, _ := cmd.Flags().GetString("view")
	if section == "" {
		_, hasBoard := result["board"]
		actor, actorOK := result["actor"].(map[string]any)
		valid = valid && confirmCockpitOverviewSummary(result["summary"]) && hasBoard && actorOK && strVal(actor, "user_id") != ""
		for _, preview := range []struct {
			key   string
			limit int
		}{{"attention", 8}, {"execution_nodes", 6}, {"recent_meetings", 6}} {
			page, _ := result[preview.key].(map[string]any)
			valid = valid && confirmCockpitOverviewPage(page, client.WorkspaceID, query, preview.limit)
			if preview.key == "attention" {
				valid = valid && page["view"] == view && page["kind"] == ""
			} else if preview.key == "recent_meetings" {
				valid = valid && confirmCockpitOverviewMeetingWindow(page, query.Get("as_of"), 30)
			}
		}
	} else {
		size, _ := cmd.Flags().GetInt("page-size")
		valid = valid && confirmCockpitOverviewPage(result, client.WorkspaceID, query, size)
		if section == "attention" {
			valid = valid && result["view"] == view && result["kind"] == query.Get("kind")
		} else if section == "meetings" {
			days, _ := cmd.Flags().GetInt("days")
			valid = valid && confirmCockpitOverviewMeetingWindow(result, query.Get("as_of"), days)
		}
	}
	if !valid {
		return fmt.Errorf("overview response does not confirm its scope, date or page bounds; no totals can be claimed")
	}
	return cli.PrintJSON(os.Stdout, result)
}
