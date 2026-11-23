// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CockpitNodeSchema } from "@multica/core/api/schemas";
import { buildPlanRows, planModuleGroups, planModules } from "./plan-rows";
import { cockpitIssueProgress } from "@multica/core/cockpit";

const n = (o: Record<string, unknown>) => CockpitNodeSchema.parse(o);

const nodes = [
  n({ id: "p1", code: "01", name: "项目一", kind: "project", position: 0 }),
  n({ id: "m1", code: "01.01", name: "模块一", kind: "module", parent_id: "p1", position: 0 }),
  n({ id: "w1", code: "01.01.01", name: "工作项一", kind: "work_item", parent_id: "m1", position: 0 }),
  n({ id: "w2", code: "01.01.02", name: "工作项二", kind: "work_item", parent_id: "m1", position: 1 }),
  n({ id: "m2", code: "01.02", name: "模块二", kind: "module", parent_id: "p1", position: 1 }),
  n({ id: "w3", code: "01.02.01", name: "工作项三", kind: "work_item", parent_id: "m2", position: 0 }),
];
const allOpen = new Set(nodes.map((node) => node.id));
const counts = [
  { node_id: "w1", primary_total: 4, reference_total: 0, active: 1, done: 2, closed: 1 },
  { node_id: "w2", primary_total: 0, reference_total: 0, active: 0, done: 0, closed: 0 },
];

describe("buildPlanRows", () => {
  it("orders parents before children and reads the level from kind", () => {
    const rows = buildPlanRows({ nodes, counts, expanded: allOpen });
    expect(rows.map((r) => [r.node.id, r.kind, r.depth])).toEqual([
      ["p1", "project", 0], ["m1", "module", 1], ["w1", "work_item", 2], ["w2", "work_item", 2],
      ["m2", "module", 1], ["w3", "work_item", 2],
    ]);
    expect(rows[0]?.code).toBe("01");
  });

  it("falls back to the parent chain when a row carries no kind", () => {
    // An older board row has no kind and a code that says nothing about depth.
    const legacy = [n({ id: "a", code: "x" }), n({ id: "b", code: "y", parent_id: "a" }), n({ id: "c", code: "z", parent_id: "b" })];
    const rows = buildPlanRows({ nodes: legacy, counts: [], expanded: new Set(legacy.map((node) => node.id)) });
    expect(rows.map((r) => r.kind)).toEqual(["project", "module", "work_item"]);
  });

  it("skips a collapsed subtree, and a search filters to the hits and their parents", () => {
    const collapsed = buildPlanRows({ nodes, counts, expanded: new Set(["p1", "m2"]) });
    expect(collapsed.map((r) => r.node.id)).not.toContain("w1");
    // Searching is a filter, not an expander: the hit shows with its path
    // even inside a closed branch, and the non-matching sibling is gone.
    const searching = buildPlanRows({ nodes, counts, expanded: new Set(), query: "工作项一" });
    expect(searching.map((r) => r.node.id)).toEqual(["p1", "m1", "w1"]);
    // A code is searchable too — the address is how rows are named.
    expect(buildPlanRows({ nodes, counts, expanded: new Set(), query: "01.02.01" }).map((r) => r.node.id))
      .toEqual(["p1", "m2", "w3"]);
  });

  it("counts a work item's progress without cancelled work in the denominator", () => {
    const rows = buildPlanRows({ nodes, counts, expanded: allOpen });
    // 4 primary − 1 closed = 3 countable, 2 done → 67%.
    expect(cockpitIssueProgress(rows.find((r) => r.node.id === "w1")!.counts)).toBe(67);
    expect(cockpitIssueProgress(rows.find((r) => r.node.id === "w2")!.counts)).toBeNull();
    expect(cockpitIssueProgress({ node_id: "x", primary_total: 3, reference_total: 0, active: 0, done: 0, closed: 3 })).toBeNull();
  });

  it("lists modules in plan order for the move menu", () => {
    expect(planModules(nodes).map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("scopes to the picked branches and keeps their depth", () => {
    const rows = buildPlanRows({ nodes, counts, expanded: allOpen, rootIds: new Set(["m2"]) });
    // The module still reads at level 2, not at the top of the list.
    expect(rows.map((r) => [r.node.id, r.depth])).toEqual([["m2", 1], ["w3", 2]]);
    // A branch the plan no longer has falls back to the whole plan, rather
    // than rendering an empty grid after a scope switch.
    const stale = buildPlanRows({ nodes, counts, expanded: allOpen, rootIds: new Set(["gone"]) });
    expect(stale).toHaveLength(6);
  });
});

describe("planModuleGroups", () => {
  it("lists modules in plan order, each with its work items in plan order", () => {
    // The read arrives in neither order: modules reversed, work items
    // reversed, ids that sort against the codes. The plan's position and
    // code decide, so the tree and the ownership picker read the same way.
    const shuffled = [nodes[4]!, nodes[0]!, nodes[5]!, nodes[2]!, nodes[1]!, nodes[3]!];
    const groups = planModuleGroups({ nodes: shuffled, counts });

    expect(groups.map((g) => [g.moduleRow.node.id, g.workItems.map((w) => w.node.id)])).toEqual([
      ["m1", ["w1", "w2"]],
      ["m2", ["w3"]],
    ]);
    expect(groups.map((g) => g.moduleRow.code)).toEqual(["01.01", "01.02"]);
  });

  it("files a work item under its parent module by the parent chain, not by a code prefix", () => {
    // A work item whose code does not share its module's prefix still belongs
    // to the module its parent chain names.
    const odd = [
      n({ id: "mx", code: "02", name: "模块X", kind: "module", position: 0 }),
      n({ id: "wx", code: "07.07", name: "工作项X", kind: "work_item", parent_id: "mx", position: 0 }),
    ];
    const groups = planModuleGroups({ nodes: odd, counts: [] });
    expect(groups.map((g) => [g.moduleRow.node.id, g.workItems.map((w) => w.node.id)])).toEqual([["mx", ["wx"]]]);
  });

  it("gives a module with no work items an empty list, and never borrows another module's", () => {
    const sparse = [nodes[0]!, nodes[1]!, nodes[2]!, nodes[4]!];
    const groups = planModuleGroups({ nodes: sparse, counts });
    expect(groups.map((g) => [g.moduleRow.node.id, g.workItems.length])).toEqual([["m1", 1], ["m2", 0]]);
  });
});
