// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CockpitNodeSchema } from "@multica/core/api/schemas";
import { buildPlanRows, planDefaultExpanded, planIssueProgress, planModules } from "./plan-rows";

const n = (o: Record<string, unknown>) => CockpitNodeSchema.parse(o);

const nodes = [
  n({ id: "p1", code: "01", name: "项目一", kind: "project", position: 0 }),
  n({ id: "m1", code: "01.01", name: "模块一", kind: "module", parent_id: "p1", position: 0 }),
  n({ id: "w1", code: "01.01.01", name: "工作项一", kind: "work_item", parent_id: "m1", position: 0 }),
  n({ id: "w2", code: "01.01.02", name: "工作项二", kind: "work_item", parent_id: "m1", position: 1 }),
  n({ id: "m2", code: "01.02", name: "模块二", kind: "module", parent_id: "p1", position: 1 }),
  n({ id: "w3", code: "01.02.01", name: "工作项三", kind: "work_item", parent_id: "m2", position: 0 }),
];
const counts = [
  { node_id: "w1", primary_total: 4, reference_total: 0, active: 1, done: 2, closed: 1 },
  { node_id: "w2", primary_total: 0, reference_total: 0, active: 0, done: 0, closed: 0 },
];

describe("buildPlanRows", () => {
  it("orders parents before children and reads the level from kind", () => {
    const rows = buildPlanRows({ nodes, counts, expanded: planDefaultExpanded(nodes) });
    expect(rows.map((r) => [r.node.id, r.kind, r.depth])).toEqual([
      ["p1", "project", 0], ["m1", "module", 1], ["w1", "work_item", 2], ["w2", "work_item", 2],
      ["m2", "module", 1], ["w3", "work_item", 2],
    ]);
    expect(rows[0]?.code).toBe("01");
  });

  it("falls back to the parent chain when a row carries no kind", () => {
    // An older board row has no kind and a code that says nothing about depth.
    const legacy = [n({ id: "a", code: "x" }), n({ id: "b", code: "y", parent_id: "a" }), n({ id: "c", code: "z", parent_id: "b" })];
    const rows = buildPlanRows({ nodes: legacy, counts: [], expanded: planDefaultExpanded(legacy) });
    expect(rows.map((r) => r.kind)).toEqual(["project", "module", "work_item"]);
  });

  it("skips a collapsed subtree but keeps a search hit's ancestor path open", () => {
    const collapsed = buildPlanRows({ nodes, counts, expanded: new Set(["p1", "m2"]) });
    expect(collapsed.map((r) => r.node.id)).not.toContain("w1");
    const searching = buildPlanRows({ nodes, counts, expanded: new Set(["p1", "m2"]), query: "工作项一" });
    expect(searching.map((r) => r.node.id)).toContain("w1");
    expect(searching.map((r) => r.node.id)).toContain("m1");
  });

  it("counts a work item's progress without cancelled work in the denominator", () => {
    const rows = buildPlanRows({ nodes, counts, expanded: planDefaultExpanded(nodes) });
    // 4 primary − 1 closed = 3 countable, 2 done → 67%.
    expect(planIssueProgress(rows.find((r) => r.node.id === "w1")!.counts)).toBe(67);
    expect(planIssueProgress(rows.find((r) => r.node.id === "w2")!.counts)).toBeNull();
    expect(planIssueProgress({ node_id: "x", primary_total: 3, reference_total: 0, active: 0, done: 0, closed: 3 })).toBeNull();
  });

  it("lists modules in plan order for the move menu", () => {
    expect(planModules(nodes).map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("scopes to the picked branches and keeps their depth", () => {
    const rows = buildPlanRows({ nodes, counts, expanded: planDefaultExpanded(nodes), rootIds: new Set(["m2"]) });
    // The module still reads at level 2, not at the top of the list.
    expect(rows.map((r) => [r.node.id, r.depth])).toEqual([["m2", 1], ["w3", 2]]);
    // A branch the plan no longer has falls back to the whole plan, rather
    // than rendering an empty grid after a scope switch.
    const stale = buildPlanRows({ nodes, counts, expanded: planDefaultExpanded(nodes), rootIds: new Set(["gone"]) });
    expect(stale).toHaveLength(6);
  });
});
