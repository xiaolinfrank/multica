// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CockpitOverviewDataSchema } from "../api/cockpit-overview-schemas";
import { cockpitReportData } from "./report-model";
function source() {
  const scope = { workspace_id: "workspace", project_id: null, project_title: "", module_id: null, module_title: "", as_of: "2026-10-10", generated_at: "2026-10-10T10:00:00Z" };
  const counts = { total: 10, active: 6, unstarted: 2, started: 3, done: 3, closed: 1, unknown: 1, overdue: 2, blocked: 1, unassigned: 1 };
  return CockpitOverviewDataSchema.parse({ ...scope, board: { id: "board", title: "Delivery", goal_title: "Approved release", goal_date: "2026-12-31" }, actor: { user_id: "private-actor", role: "admin", is_human: true },
    summary: { primary_issues: counts, my_primary_issues: counts, execution_nodes: { total: 2, with_active_issues: 1 }, attention: { team_total: 20, mine_total: 10, team_by_kind: {}, mine_by_kind: {} } },
    attention: { ...scope, view: "team", kind: "", items: [], total: 20, next_cursor: "private-cursor" },
    execution_nodes: { ...scope, items: [], total: 2, next_cursor: "private-cursor" },
    recent_meetings: { ...scope, range_start: "2026-09-11", range_end: "2026-10-17", items: [], total: 0, next_cursor: null },
  });
}
describe("presentation data whitelist", () => {
  it("removes capabilities, cursor and unsupported sensitive fields before data reaches the report component", () => {
    const input = source(); Object.assign(input, { budget_amount: "private-budget", vendor: "private-vendor", description: "private-description" }); Object.assign(input.board!, { raw_notes: "private-notes" });
    const projected = cockpitReportData(input); const serialized = JSON.stringify(projected);
    expect(serialized).not.toMatch(/private-|can_act|role|assignee_id|next_cursor/); expect(projected.goal).toBe("Approved release");
  });
  it("preserves dates and separates issue completion from the number of execution work items", () => {
    const report = cockpitReportData(source()); expect(report.summary).toMatchObject({ workItems: 2, workItemsWithActiveIssues: 1, issues: { total: 10, active: 6, done: 3, closed: 1, unknown: 1 }, attention: 20 });
    expect(report).toMatchObject({ asOf: "2026-10-10", retrievedAt: "2026-10-10T10:00:00Z" }); expect(report.execution).toEqual({ total: 2, items: [] }); expect(report).not.toHaveProperty("acceptancePercent");
  });
});
