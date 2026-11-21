// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { CockpitBoard, CockpitMilestone, CockpitNode } from "../types";
import {
  axisMonths,
  buildCockpitTree,
  cockpitAggStatusColor,
  cockpitCoreNodes,
  cockpitEffectiveProgress,
  cockpitGoalProgress,
  cockpitMissingFields,
  cockpitModuleHighlights,
  cockpitOverallProgress,
  cockpitPaymentTone,
  cockpitStatusColor,
  cockpitSubtreeAverage,
  computeCockpitAxis,
  computeCockpitDigest,
  computeCockpitFinance,
  computeCockpitFinanceRows,
  computeCockpitFinanceLedger,
  computeCockpitMonths,
  computeCockpitRollups,
  flattenCockpitTree,
  groupPaymentsByNode,
  groupSubtreePayments,
  isCockpitWorkItem,
  isCockpitMilestoneDone,
  isCockpitNodeDrifting,
  isCockpitNodeLate,
  isCockpitNodeUnscheduled,
  sortCockpitMilestones,
} from "./model";

function node(over: Partial<CockpitNode> & { id: string; code: string }): CockpitNode {
  return {
    cockpit_id: "cp",
    parent_id: null,
    name: over.code,
    position: 0,
    color: "",
    owner: "",
    collaborators: "",
    start_date: null,
    end_date: null,
    status: "",
    progress: 0,
    deliverable: "",
    dependencies: "",
    note: "",
    current_progress: "",
    vendor: "",
    budget_category: "",
    budget_amount: null,
    exec_status: "",
    contract: "",
    source: "",
    updated_by_type: "",
    updated_by_id: null,
    created_at: "",
    updated_at: "",
    // The plan read writes `kind`; a fixture that does not name one is a task
    // under its parent, or a root project. Branch rows below the root opt in
    // with kind: "module" explicitly.
    kind: over.parent_id ? "work_item" : "project",
    ...over,
  };
}

function board(over: Partial<CockpitBoard>): CockpitBoard {
  return {
    cockpit: {
      id: "cp",
      workspace_id: "ws",
      title: "",
      goal_title: "",
      goal_date: null,
      summary_overall: "",
      summary_next: "",
      summary_support: "",
      basis: "",
      meeting_assignee_type: "",
      meeting_assignee_id: null,
      meeting_project_id: null,
      meeting_module_id: null,
    meeting_node_id: null,
      meeting_dir: "",
      created_at: "",
      updated_at: "",
    },
    nodes: [],
    payments: [],
    issue_links: [],
    milestones: [],
    meetings: [],
    meeting_issues: [],
    meeting_nodes: [],
    ...over,
  };
}

describe("buildCockpitTree", () => {
  it("keeps ancestor context in the hierarchy without charging its own budget to a scoped finance view", () => {
    const tree = buildCockpitTree([
      node({ id: "project", code: "P", budget_amount: 900 }),
      node({ id: "module", code: "M", parent_id: "project", kind: "module", budget_amount: 300 }),
      node({ id: "task", code: "T", parent_id: "module", budget_amount: 40 }),
    ]);
    const payments = [{ id: "payment", node_id: "task", label: "Verification", pay_date: "2026-10-10", amount: 10, position: 0 }];
    const rows = computeCockpitFinanceRows(tree, payments, new Set(["project"]));
    // Per instalment now: only the task carries a listed instalment, so the
    // module contributes no spend row of its own.
    expect(rows.map((row) => [row.node.id, row.rootCode, row.budget])).toEqual([["task", "P", 40]]);
    expect(tree[0]?.node.budget_amount).toBe(900);
    expect(rows[0]?.payment).toEqual(payments[0]);
    const context = new Set(["project"]);
    const snapshot = board({ nodes: [tree[0]!.node, tree[0]!.children[0]!.node, tree[0]!.children[0]!.children[0]!.node], payments: [
      ...payments, { id: "context-payment", node_id: "project", label: "Outside scope", pay_date: "2026-10-10", amount: 900, position: 0 },
    ] });
    // The summary carries instalment figures only (no separate budget total
    // since f44f1a52b); the context root's 900 stays out of every figure.
    expect(computeCockpitFinance(snapshot, context)).toMatchObject({ planned: 10, paymentCount: 1, byModule: [{ code: "P", planned: 10 }] });
    expect(computeCockpitMonths(snapshot, context)[0]).toMatchObject({ amount: 10, plannedSpend: 10, byModule: [{ code: "P", amount: 10 }] });
  });
  it("nests by parent_id and orders siblings by position then code", () => {
    const tree = buildCockpitTree([
      node({ id: "c2", code: "01.02", parent_id: "r", position: 2 }),
      node({ id: "c1", code: "01.01", parent_id: "r", position: 1 }),
      node({ id: "r", code: "L1-01" }),
    ]);

    expect(tree).toHaveLength(1);
    expect(tree[0]!.node.id).toBe("r");
    expect(tree[0]!.children.map((c) => c.node.code)).toEqual(["01.01", "01.02"]);
    expect(tree[0]!.children[0]!.depth).toBe(1);
  });

  it("inherits colour from the nearest ancestor that sets one", () => {
    const tree = buildCockpitTree([
      node({ id: "r", code: "L1-01", color: "#2563eb" }),
      node({ id: "c", code: "01.01", parent_id: "r", kind: "module" }),
      node({ id: "g", code: "L3-1", parent_id: "c", color: "#ff0000" }),
    ]);
    const flat = flattenCockpitTree(tree);
    expect(flat.map((e) => e.color)).toEqual(["#2563eb", "#2563eb", "#ff0000"]);
  });

  it("shows a node whose parent is missing as a root rather than dropping it", () => {
    const tree = buildCockpitTree([node({ id: "orphan", code: "X-1", parent_id: "gone" })]);
    expect(tree.map((e) => e.node.id)).toEqual(["orphan"]);
  });

  it("terminates on a parent cycle and still renders every node", () => {
    const tree = buildCockpitTree([
      node({ id: "a", code: "A", parent_id: "b" }),
      node({ id: "b", code: "B", parent_id: "a" }),
    ]);
    expect(flattenCockpitTree(tree).map((e) => e.node.id).sort()).toEqual(["a", "b"]);
  });
});

describe("computeCockpitRollups", () => {
  const tree = buildCockpitTree([
    node({ id: "r", code: "L1-01" }),
    node({
      id: "a",
      code: "A",
      parent_id: "r",
      progress: 100,
      status: "已完成",
      budget_amount: 30,
      start_date: "2026-01-10",
      end_date: "2026-02-01",
    }),
    node({
      id: "b",
      code: "B",
      parent_id: "r",
      progress: 0,
      status: "未开始",
      budget_amount: 10,
      start_date: "2026-03-01",
      end_date: "2026-03-20",
    }),
  ]);
  const rollups = computeCockpitRollups(tree, "2026-06-01");

  it("sums budget and spans dates over the subtree", () => {
    expect(rollups.get("r")!.budget).toBe(40);
    expect(rollups.get("r")!.start).toBe("2026-01-10");
    expect(rollups.get("r")!.end).toBe("2026-03-20");
  });

  it("counts leaves, not branch rows, and weights progress by leaf count", () => {
    expect(rollups.get("r")!.leafCount).toBe(2);
    expect(rollups.get("r")!.doneCount).toBe(1);
    expect(rollups.get("r")!.progress).toBe(50);
  });

  it("counts a task past its end date and not done as late", () => {
    expect(rollups.get("r")!.lateCount).toBe(1);
  });

  it("counts in-progress and review leaves as active", () => {
    expect(rollups.get("r")!.activeCount).toBe(0);
    const active = computeCockpitRollups(
      buildCockpitTree([
        node({ id: "r2", code: "R2" }),
        node({ id: "x", code: "X", parent_id: "r2", status: "进行中" }),
        node({ id: "y", code: "Y", parent_id: "r2", status: "审查中" }),
        node({ id: "z", code: "Z", parent_id: "r2", status: "未开始" }),
      ]),
      "2026-06-01",
    );
    expect(active.get("r2")!.activeCount).toBe(2);
  });

  // A branch with 40 tasks must not weigh the same as its sibling with 2.
  it("weights a deep branch by how much work it holds", () => {
    const nodes: CockpitNode[] = [node({ id: "root", code: "ROOT" })];
    nodes.push(node({ id: "big", code: "BIG", parent_id: "root", kind: "module" }));
    nodes.push(node({ id: "small", code: "SMALL", parent_id: "root", kind: "module" }));
    for (let i = 0; i < 9; i++) {
      nodes.push(
        node({ id: `big-${i}`, code: `BIG-${i}`, parent_id: "big", progress: 0, status: "未开始" }),
      );
    }
    nodes.push(node({ id: "small-0", code: "SMALL-0", parent_id: "small", progress: 100, status: "已完成" }));

    const rolled = computeCockpitRollups(buildCockpitTree(nodes), "2026-01-01");
    expect(rolled.get("root")!.leafCount).toBe(10);
    expect(rolled.get("root")!.progress).toBe(10);
  });
});

describe("isCockpitNodeLate", () => {
  it("ignores nodes that are done or cancelled", () => {
    expect(isCockpitNodeLate(node({ id: "1", code: "A", end_date: "2026-01-01" }), "2026-02-01")).toBe(true);
    expect(
      isCockpitNodeLate(node({ id: "2", code: "B", end_date: "2026-01-01", status: "已完成" }), "2026-02-01"),
    ).toBe(false);
    expect(
      isCockpitNodeLate(node({ id: "3", code: "C", end_date: "2026-01-01", status: "已取消" }), "2026-02-01"),
    ).toBe(false);
    expect(
      isCockpitNodeLate(node({ id: "4", code: "D", end_date: "2026-01-01", progress: 100 }), "2026-02-01"),
    ).toBe(false);
  });

  it("is never late without a planned end", () => {
    expect(isCockpitNodeLate(node({ id: "1", code: "A" }), "2026-02-01")).toBe(false);
  });
});

describe("computeCockpitFinance", () => {
  it("totals every instalment and uses status only for the paid subset", () => {
    const input = board({
      nodes: [
        node({ id: "paid", code: "P", budget_amount: 20, exec_status: "完全支付" }),
        node({ id: "signed", code: "S", budget_amount: 30, exec_status: "合同已定" }),
        node({ id: "planned", code: "N", budget_amount: 50, exec_status: "规划中" }),
        node({ id: "budget-only", code: "B", budget_amount: 100, exec_status: "完全支付" }),
      ],
      payments: [
        { id: "1", node_id: "paid", label: "", pay_date: "2026-01-05", amount: 20, position: 0 },
        { id: "2", node_id: "signed", label: "", pay_date: "2026-02-05", amount: 30, position: 0 },
      ],
    });

    expect(computeCockpitFinance(input)).toMatchObject({
      planned: 50, actual: 20, outstanding: 30,
      lineCount: 2, paidLineCount: 1, contracted: 30, paymentCount: 2,
    });
    const changed = structuredClone(input);
    changed.nodes[0]!.exec_status = "未支付";
    changed.nodes[1]!.exec_status = "完全支付";
    expect(computeCockpitFinance(changed)).toMatchObject({
      planned: 50, actual: 30, outstanding: 20,
      lineCount: 2, paidLineCount: 1, contracted: 0, paymentCount: 2,
    });
  });

  it("limits annual and three-year rollups to the requested payment years", () => {
    const input = board({
      nodes: [
        node({ id: "r", code: "R" }),
        node({ id: "paid", code: "P", parent_id: "r", exec_status: "完全支付" }),
        node({ id: "signed", code: "S", parent_id: "r", exec_status: "合同已定" }),
      ],
      payments: [
        { id: "2025", node_id: "paid", label: "", pay_date: "2025-12-31", amount: 1, position: 0 },
        { id: "2026-paid", node_id: "paid", label: "", pay_date: "2026-01-05", amount: 10, position: 0 },
        { id: "2026-signed", node_id: "signed", label: "", pay_date: "2026-02-05", amount: 20, position: 0 },
        { id: "2027", node_id: "paid", label: "", pay_date: "2027-01-05", amount: 100, position: 0 },
        { id: "2028", node_id: "signed", label: "", pay_date: "2028-12-31", amount: 200, position: 0 },
        { id: "2029", node_id: "paid", label: "", pay_date: "2029-01-01", amount: 1000, position: 0 },
        { id: "undated", node_id: "paid", label: "", pay_date: null, amount: 10000, position: 0 },
      ],
    });
    const annual = computeCockpitFinance(input, undefined, { startYear: 2026, endYear: 2026 });
    expect(annual).toMatchObject({ planned: 30, actual: 10, outstanding: 20,
      lineCount: 2, paidLineCount: 1, contracted: 20, paymentCount: 2 });
    expect(annual.byModule).toEqual([{ code: "R", name: "R", color: "", lineCount: 2,
      planned: 30, actual: 10, outstanding: 20 }]);
    expect(computeCockpitFinance(input, undefined, { startYear: 2026, endYear: 2028 })).toMatchObject({
      planned: 330, actual: 110, outstanding: 220,
      lineCount: 4, paidLineCount: 2, contracted: 220, paymentCount: 4,
    });
  });

  it("uses only listed instalments, never task budgets, in module totals", () => {
    const summary = computeCockpitFinance(board({
      nodes: [
        node({ id: "m", code: "L1-01", name: "Platform" }),
        node({ id: "a", code: "L3-01-01", parent_id: "m", budget_amount: 40, exec_status: "完全支付" }),
        node({ id: "b", code: "L3-01-02", parent_id: "m", budget_amount: 10 }),
        node({ id: "budget-only", code: "L3-01-03", parent_id: "m", budget_amount: 100, exec_status: "完全支付" }),
      ],
      payments: [
        { id: "1", node_id: "a", label: "one", pay_date: "2026-01-05", amount: 15, position: 0 },
        { id: "2", node_id: "a", label: "two", pay_date: "2026-02-05", amount: 25, position: 1 },
        { id: "3", node_id: "b", label: "one", pay_date: "2026-02-05", amount: 8, position: 0 },
      ],
    }));
    expect(summary).toMatchObject({ planned: 48, actual: 40, outstanding: 8, lineCount: 3 });
    expect(summary.byModule).toEqual([{ code: "L1-01", name: "Platform", color: "", lineCount: 3,
      planned: 48, actual: 40, outstanding: 8 }]);
  });
});

describe("computeCockpitMonths", () => {
  it("omits instalments outside the requested financial period", () => {
    const cells = computeCockpitMonths(board({
      nodes: [node({ id: "a", code: "A", end_date: "2026-06-20" })],
      payments: [
        { id: "annual", node_id: "a", label: "", pay_date: "2026-06-05", amount: 10, position: 0 },
        { id: "later", node_id: "a", label: "", pay_date: "2027-06-05", amount: 100, position: 0 },
        { id: "undated", node_id: "a", label: "", pay_date: null, amount: 1000, position: 0 },
      ],
    }), undefined, { startYear: 2026, endYear: 2026 });
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ month: "2026-06", amount: 10, plannedSpend: 10 });
  });

  it("buckets money and work by month and fills the gaps between them", () => {
    const cells = computeCockpitMonths(
      board({
        nodes: [
          node({ id: "a", code: "A", end_date: "2026-01-20", status: "已完成" }),
          node({ id: "b", code: "B", end_date: "2026-04-10", status: "未开始" }),
        ],
        payments: [{ id: "1", node_id: "a", label: "", pay_date: "2026-01-05", amount: 15, position: 0 }],
      }),
    );

    expect(cells.map((c) => c.month)).toEqual(["2026-01", "2026-02", "2026-03", "2026-04"]);
    expect(cells[0]).toMatchObject({ amount: 15, dueCount: 1, doneCount: 1 });
    expect(cells[1]).toMatchObject({ amount: 0, dueCount: 0 });
    expect(cells[3]).toMatchObject({ dueCount: 1, doneCount: 0 });
  });

  it("returns nothing for a board with no dates at all", () => {
    expect(computeCockpitMonths(board({ nodes: [node({ id: "a", code: "A" })] }))).toEqual([]);
  });

  it("stacks instalments by root module colour and marks the paid share", () => {
    const cells = computeCockpitMonths(
      board({
        nodes: [
          node({ id: "r1", code: "L1-01", color: "#2563eb" }),
          node({ id: "r2", code: "L1-02", color: "#0891b2" }),
          node({
            id: "a",
            code: "A",
            parent_id: "r1",
            exec_status: "完全支付",
            end_date: "2026-01-20",
          }),
          node({ id: "b", code: "B", parent_id: "r2", end_date: "2026-01-25" }),
        ],
        payments: [
          { id: "1", node_id: "a", label: "", pay_date: "2026-01-05", amount: 10, position: 0 },
          { id: "2", node_id: "b", label: "", pay_date: "2026-01-15", amount: 5, position: 0 },
        ],
      }),
    );
    const jan = cells.find((c) => c.month === "2026-01")!;
    expect(jan.amount).toBe(15);
    expect(jan.paidAmount).toBe(10);
    expect(jan).toMatchObject({ plannedSpend: 15, actualSpend: 10, projectedSpend: 5, actualCount: 1 });
    expect(jan.byModule).toEqual([
      { code: "L1-01", color: "#2563eb", amount: 10 },
      { code: "L1-02", color: "#0891b2", amount: 5 },
    ]);
  });

  it("counts active leaves whose plan window covers the month", () => {
    const cells = computeCockpitMonths(
      board({
        nodes: [
          node({
            id: "a",
            code: "A",
            status: "进行中",
            start_date: "2026-01-10",
            end_date: "2026-03-20",
          }),
          node({ id: "b", code: "B", status: "已完成", end_date: "2026-02-01" }),
          node({ id: "c", code: "C", status: "未开始", end_date: "2026-04-01" }),
        ],
        payments: [
          { id: "1", node_id: "a", label: "", pay_date: "2026-01-05", amount: 3, position: 0 },
        ],
      }),
    );
    expect(cells.find((c) => c.month === "2026-01")!.activeCount).toBe(1);
    expect(cells.find((c) => c.month === "2026-02")!.activeCount).toBe(1);
    expect(cells.find((c) => c.month === "2026-03")!.activeCount).toBe(1);
    expect(cells.find((c) => c.month === "2026-04")!.activeCount).toBe(0);
  });
});

describe("cockpitMissingFields", () => {
  it("names the empty core fields and passes a complete task", () => {
    // The fixture fills name from code, so only the other four are missing.
    expect(cockpitMissingFields(node({ id: "x", code: "X" }))).toEqual([
      "owner",
      "start_date",
      "end_date",
      "status",
    ]);
    expect(
      cockpitMissingFields(
        node({
          id: "y",
          code: "Y",
          owner: "W",
          start_date: "2026-01-01",
          end_date: "2026-02-01",
          status: "进行中",
        }),
      ),
    ).toEqual([]);
  });
});

describe("milestones", () => {
  const milestone = (over: Partial<CockpitMilestone> & { id: string }): CockpitMilestone => ({
    name: "",
    plan_date: null,
    actual_date: null,
    status: "",
    node_id: null,
    condition: "",
    guard: "",
    position: 0,
    ...over,
  });

  it("reads as done once an actual date is set, whatever the status label says", () => {
    expect(isCockpitMilestoneDone(milestone({ id: "1", actual_date: "2026-08-05", status: "按计划推进" }))).toBe(true);
    expect(isCockpitMilestoneDone(milestone({ id: "2", status: "前置准备" }))).toBe(false);
  });

  it("sorts by plan date with undated milestones last", () => {
    const sorted = sortCockpitMilestones([
      milestone({ id: "undated" }),
      milestone({ id: "late", plan_date: "2026-12-31" }),
      milestone({ id: "early", plan_date: "2026-08-05" }),
    ]);
    expect(sorted.map((m) => m.id)).toEqual(["early", "late", "undated"]);
  });
});

describe("computeCockpitAxis", () => {
  it("pads to whole months around the board's own span", () => {
    const axis = computeCockpitAxis(
      [node({ id: "a", code: "A", start_date: "2026-03-10", end_date: "2026-05-20" })],
      "2026-04-01",
    );
    expect(axis.start.toISOString().slice(0, 10)).toBe("2026-03-01");
    expect(axis.end.toISOString().slice(0, 10)).toBe("2026-05-31");
    expect(axisMonths(axis).map((m) => m.key)).toEqual(["2026-03", "2026-04", "2026-05"]);
  });

  it("always includes today so the marker is never off-canvas", () => {
    const axis = computeCockpitAxis(
      [node({ id: "a", code: "A", start_date: "2026-03-10", end_date: "2026-03-20" })],
      "2026-09-15",
    );
    expect(axis.end.toISOString().slice(0, 10)).toBe("2026-09-30");
  });

  it("falls back to the current year when nothing carries a date", () => {
    const axis = computeCockpitAxis([node({ id: "a", code: "A" })], "2026-06-15");
    expect(axis.start.toISOString().slice(0, 10)).toBe("2026-01-01");
    expect(axis.end.toISOString().slice(0, 10)).toBe("2026-12-31");
  });

  it("opens at June of the goal year and closes on the goal month", () => {
    const axis = computeCockpitAxis(
      [node({ id: "a", code: "A", start_date: "2026-01-05", end_date: "2026-04-15" })],
      "2026-02-01",
      { goalDate: "2026-12-31" },
    );
    expect(axis.start.toISOString().slice(0, 10)).toBe("2026-06-01");
    expect(axis.end.toISOString().slice(0, 10)).toBe("2026-12-31");
    expect(axisMonths(axis).map((m) => m.key)).toEqual([
      "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12",
    ]);
  });

  it("starts week density on the Monday of the earliest execution row", () => {
    const axis = computeCockpitAxis(
      [
        node({ id: "r", code: "R", kind: "work_item", start_date: "2026-03-02", end_date: "2026-05-20" }),
        node({ id: "a", code: "A", parent_id: "r", start_date: "2026-03-18", end_date: "2026-05-20" }),
      ],
      "2026-04-01",
      { zoom: "week" },
    );
    // 2026-03-02 is itself a Monday. A work item that carries sub-work is
    // still work — its own dates place the axis — while a project or module
    // row's dates never do.
    expect(axis.start.toISOString().slice(0, 10)).toBe("2026-03-02");
  });

  it("covers every day of the span exactly once across its months", () => {
    const axis = computeCockpitAxis(
      [node({ id: "a", code: "A", start_date: "2026-01-05", end_date: "2026-04-15" })],
      "2026-02-01",
    );
    const months = axisMonths(axis);
    expect(months.reduce((sum, m) => sum + m.days, 0)).toBe(axis.days);
    expect(months[0]!.offset).toBe(0);
  });
});

describe("computeCockpitDigest", () => {
  const nodes = [
    node({ id: "done", code: "D", kind: "work_item", status: "已完成", end_date: "2026-06-10" }),
    node({ id: "old-done", code: "OD", kind: "work_item", status: "已完成", end_date: "2026-01-10" }),
    node({ id: "soon", code: "S", kind: "work_item", end_date: "2026-06-20" }),
    node({ id: "far", code: "F", kind: "work_item", end_date: "2026-12-20" }),
    node({ id: "late", code: "L", kind: "work_item", status: "进行中", end_date: "2026-05-01" }),
    node({ id: "blocked", code: "B", kind: "work_item", status: "受阻", end_date: "2026-07-01" }),
    node({ id: "cancelled", code: "C", kind: "work_item", status: "已取消", end_date: "2026-05-01" }),
  ];
  const digest = computeCockpitDigest(board({ nodes }), "2026-06-15");

  it("reports only work finished inside the trailing window", () => {
    expect(digest.overall.items.map((item) => item.key)).toEqual(["done"]);
  });

  it("reports only work due inside the leading window", () => {
    expect(digest.next.items.map((item) => item.key)).toEqual(["soon"]);
  });

  it("puts overdue and blocked work under support, and drops cancelled work entirely", () => {
    expect(digest.support.items.map((item) => item.key)).toEqual(["blocked", "late"]);
  });
});

describe("cockpitStatusColor", () => {
  it("maps the board's own vocabulary onto theme tokens", () => {
    expect(cockpitStatusColor("进行中")).toBe("var(--brand)");
    expect(cockpitStatusColor("已完成")).toBe("var(--success)");
    expect(cockpitStatusColor("受阻")).toBe("var(--destructive)");
    expect(cockpitStatusColor("  blocked  ")).toBe("var(--destructive)");
    expect(cockpitStatusColor("In Progress")).toBe("var(--brand)");
  });

  it("keeps a status nobody here knows visible rather than colourless", () => {
    expect(cockpitStatusColor("挂起复核中")).toBe("var(--faint-foreground)");
    expect(cockpitStatusColor("")).toBe("var(--faint-foreground)");
  });
});

describe("isCockpitNodeDrifting", () => {
  const open = { start_date: "2026-01-01", end_date: "2026-12-31" };

  it("flags a row whose window has opened while it still reads as not started", () => {
    expect(isCockpitNodeDrifting(node({ id: "a", code: "A", ...open, status: "未开始" }), "2026-06-01")).toBe(true);
    expect(isCockpitNodeDrifting(node({ id: "b", code: "B", ...open, status: "待开始" }), "2026-06-01")).toBe(true);
  });

  it("stays quiet before the window opens and once work has started", () => {
    expect(isCockpitNodeDrifting(node({ id: "a", code: "A", ...open, status: "未开始" }), "2025-12-31")).toBe(false);
    expect(isCockpitNodeDrifting(node({ id: "b", code: "B", ...open, status: "进行中" }), "2026-06-01")).toBe(false);
  });

  it("defers to late, so one row never claims both", () => {
    const late = node({ id: "c", code: "C", start_date: "2026-01-01", end_date: "2026-02-01", status: "未开始" });
    expect(isCockpitNodeLate(late, "2026-06-01")).toBe(true);
    expect(isCockpitNodeDrifting(late, "2026-06-01")).toBe(false);
  });

  it("needs both dates: a row with only a deadline is not drifting", () => {
    expect(
      isCockpitNodeDrifting(node({ id: "d", code: "D", end_date: "2026-12-31", status: "未开始" }), "2026-06-01"),
    ).toBe(false);
  });
});

describe("groupSubtreePayments", () => {
  const nodes = [
    node({ id: "r", code: "L1-01" }),
    node({ id: "a", code: "01.01", parent_id: "r", exec_status: "未支付" }),
    node({ id: "b", code: "01.02", parent_id: "r", exec_status: "完全支付" }),
  ];
  const payments = [
    { id: "p1", node_id: "a", label: "首期", pay_date: "2026-03-01", amount: 10, position: 0 },
    { id: "p2", node_id: "b", label: "首期", pay_date: "2026-03-01", amount: 5, position: 0 },
    { id: "p3", node_id: "b", label: "尾款", pay_date: "2026-09-01", amount: 7, position: 1 },
  ];

  it("keeps paid days separate from scheduled months, even on the same day", () => {
    const tree = buildCockpitTree(nodes);
    const groups = groupSubtreePayments(
      tree[0]!,
      groupPaymentsByNode(payments),
      new Map(nodes.map((n) => [n.id, n])),
    );
    expect(groups.map((g) => [g.date, g.month, g.paid, g.tone, g.entries.length, g.total])).toEqual([
      ["2026-03-01", "2026-03", false, "pending", 1, 10],
      ["2026-03-01", null, true, "paid", 1, 5],
      ["2026-09-01", null, true, "paid", 1, 7],
    ]);
  });

  it("anchors scheduled months on their last instalment and uses the most advanced tone", () => {
    const mixed = [...nodes, node({ id: "c", code: "01.03", parent_id: "r", exec_status: "合同已定" })];
    const groups = groupSubtreePayments(buildCockpitTree(mixed)[0]!, groupPaymentsByNode([
      payments[0]!,
      { id: "p4", node_id: "c", label: "", pay_date: "2026-03-20", amount: 8, position: 0 },
    ]), new Map(mixed.map((n) => [n.id, n])));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ date: "2026-03-20", month: "2026-03", paid: false,
      tone: "contract", total: 18, execStatus: "合同已定" });
    expect(groups[0]!.entries.map((e) => e.payment.id)).toEqual(["p1", "p4"]);
  });

  it("drops an instalment with no date rather than stacking it at the axis start", () => {
    const undated = [{ id: "p9", node_id: "a", label: "待定", pay_date: null, amount: 3, position: 0 }];
    const tree = buildCockpitTree(nodes);
    expect(
      groupSubtreePayments(tree[0]!, groupPaymentsByNode(undated), new Map(nodes.map((n) => [n.id, n]))),
    ).toEqual([]);
  });
});

describe("computeCockpitFinanceRows", () => {
  const nodes = [
    node({ id: "r", code: "L1-01", color: "#2563eb" }),
    node({ id: "a", code: "01.01", parent_id: "r", budget_amount: 100, exec_status: "未支付" }),
    node({ id: "b", code: "01.02", parent_id: "r", budget_amount: 40, exec_status: "完全支付" }),
    node({ id: "c", code: "01.03", parent_id: "r" }),
  ];
  const payments = [
    { id: "p1", node_id: "a", label: "首期", pay_date: "2026-03-01", amount: 60, position: 0 },
    { id: "p2", node_id: "a", label: "尾款", pay_date: "2026-05-01", amount: 40, position: 1 },
    { id: "p3", node_id: "b", label: "全款", pay_date: "2026-02-01", amount: 40, position: 0 },
  ];

  it("lists each instalment, including every payment on one task", () => {
    const rows = computeCockpitFinanceRows(buildCockpitTree(nodes), payments);
    expect(rows.map((r) => [r.node.code, r.payment.id, r.amount])).toEqual([
      ["01.01", "p1", 60], ["01.01", "p2", 40], ["01.02", "p3", 40],
    ]);
    expect(rows.every((r) => r.rootCode === "L1-01" && r.rootColor === "#2563eb")).toBe(true);
  });

  it("uses status only to classify an instalment, not to filter or reprice it", () => {
    const rows = computeCockpitFinanceRows(buildCockpitTree(nodes), payments);
    expect(rows.map((r) => r.paid)).toEqual([false, false, true]);
    expect(rows[0]).toMatchObject({ amount: 60, budget: 100 });
    expect(rows[2]).toMatchObject({ amount: 40, budget: 40 });
  });

  it("keeps a payment with no budget, and no payment date, as its own row", () => {
    const withPaymentOnly = [...nodes, node({ id: "d", code: "01.04", parent_id: "r" })];
    const rows = computeCockpitFinanceRows(buildCockpitTree(withPaymentOnly), [
      ...payments,
      { id: "p4", node_id: "d", label: "待定", pay_date: null, amount: 8, position: 0 },
    ]);
    expect(rows.at(-1)).toMatchObject({ payment: { id: "p4", pay_date: null }, amount: 8, budget: 0, paid: false });
  });
});

describe("computeCockpitFinanceLedger", () => {
  const tree = buildCockpitTree([
    node({ id: "r", code: "L1-01", color: "#2563eb" }),
    node({ id: "m", code: "01.01", parent_id: "r", kind: "module", budget_amount: 100 }),
    node({ id: "w1", code: "01.01.01", parent_id: "m", budget_amount: 60 }),
    node({ id: "w2", code: "01.01.02", parent_id: "m", budget_amount: 40 }),
  ]);
  const payments = [{ id: "p1", node_id: "w1", label: "首期", pay_date: "2026-03-01", amount: 60, position: 0 }];

  it("lists a work item with no instalment, so its money fields stay editable", () => {
    const rows = computeCockpitFinanceLedger(tree, payments);
    expect(rows.map((row) => [row.node.code, row.payment?.id ?? null, row.amount])).toEqual([
      ["01.01.01", "p1", 60],
      ["01.01.02", null, 0],
    ]);
    expect(rows[1]).toMatchObject({ budget: 40, paid: false, rootCode: "L1-01", rootColor: "#2563eb" });
  });

  it("keeps an instalment filed on a structural row, and drops context rows", () => {
    const legacy = [{ id: "p9", node_id: "m", label: "旧", pay_date: "2026-01-01", amount: 5, position: 0 }];
    const rows = computeCockpitFinanceLedger(tree, legacy, new Set(["w2"]));
    expect(rows.map((row) => [row.node.code, row.payment?.id ?? null])).toEqual([
      ["01.01", "p9"],
      ["01.01.01", null],
    ]);
  });
});

describe("cockpitModuleHighlights", () => {
  it("picks the latest finished leaf and the nearest unfinished one", () => {
    const tree = buildCockpitTree([
      node({ id: "m", code: "L1-01" }),
      node({ id: "a", code: "A", parent_id: "m", status: "已完成", deliverable: "Result A", end_date: "2026-03-01" }),
      node({ id: "b", code: "B", parent_id: "m", status: "已完成", deliverable: "Result B", end_date: "2026-05-01" }),
      node({ id: "c", code: "C", parent_id: "m", status: "进行中", end_date: "2026-04-01" }),
      node({ id: "d", code: "D", parent_id: "m", status: "未开始", end_date: "2026-02-01" }),
    ]);
    const highlights = cockpitModuleHighlights(tree[0]!, "2026-03-15");
    expect(highlights.recent?.id).toBe("b");
    expect(highlights.next?.id).toBe("c");
  });

  it("excludes overdue work from the next node and reports nulls without dated leaves", () => {
    const past = buildCockpitTree([
      node({ id: "m", code: "L1-02" }),
      node({ id: "old", code: "OLD", parent_id: "m", status: "进行中", end_date: "2020-01-01" }),
    ]);
    expect(cockpitModuleHighlights(past[0]!, "2026-03-15").next).toBeNull();

    const bare = buildCockpitTree([
      node({ id: "m", code: "L1-03" }),
      node({ id: "x", code: "X", parent_id: "m" }),
    ]);
    const empty = cockpitModuleHighlights(bare[0]!, "2026-03-15");
    expect(empty.recent).toBeNull();
    expect(empty.next).toBeNull();
  });
});

describe("isCockpitWorkItem", () => {
  it("reads the level from kind and never from the code's shape", () => {
    // Reconciled codes: 00 is a project, 00.01 a module, 00.01.01 a work item.
    // The old code-shaped rule called every one of these a task.
    const rows = [
      node({ id: "p", code: "00", kind: "project" }),
      node({ id: "m", code: "00.01", kind: "module", parent_id: "p" }),
      node({ id: "w", code: "00.01.01", kind: "work_item", parent_id: "m" }),
    ];
    expect(rows.map((row, depth) => isCockpitWorkItem(row, depth))).toEqual([false, false, true]);
    // A legacy code keeps its level too, because kind is what is read.
    expect(isCockpitWorkItem(node({ id: "x", code: "L1-02", kind: "project" }), 0)).toBe(false);
  });

  it("uses the depth only when the row carries no kind", () => {
    // The fixture helper seeds a kind; strip it to model an old board row.
    const bare = [
      node({ id: "p", code: "legacy-root" }),
      node({ id: "m", code: "legacy-mid", parent_id: "p" }),
      node({ id: "w", code: "legacy-leaf", parent_id: "m" }),
    ].map(({ kind: _kind, ...row }) => row as CockpitNode);
    expect(bare.map((row, depth) => isCockpitWorkItem(row, depth))).toEqual([false, false, true]);
  });

  it("TestRolledCountsNeverCountAProject: a leafless reconciled project stays out of the goal and overall counts", () => {
    // After the reconcile a project reads "02" with no children: the rolled
    // counts and the goal figures must not treat it as one more task.
    const rows = [
      node({ id: "p2", code: "02", kind: "project", status: "进行中", progress: 40, start_date: "2026-06-01", end_date: "2026-09-30" }),
    ];
    const tree = buildCockpitTree(rows);
    expect(cockpitGoalProgress(tree[0]!, "2026-06-11", "2026-12-31")).toMatchObject({ taskCount: 0, actual: null, scheduled: null });
    expect(cockpitOverallProgress(rows, "2026-06-11", "2026-12-31").overall).toBeNull();
  });

  it("does not let a reconciled project's own progress into the overall mean", () => {
    const rows = [
      node({ id: "p", code: "00", kind: "project", progress: 100, status: "已完成" }),
      node({ id: "m", code: "00.01", kind: "module", parent_id: "p" }),
      node({ id: "w", code: "00.01.01", kind: "work_item", parent_id: "m", progress: 10, status: "进行中", start_date: "2026-06-01", end_date: "2026-06-20" }),
    ];
    expect(cockpitOverallProgress(rows, "2026-06-11", null).overall).toBe(10);
  });
});

describe("cockpitSubtreeAverage", () => {
  it("scores untyped rows by the source sheet's status map, review and waiting as zero", () => {
    const tree = buildCockpitTree([
      node({ id: "r", code: "L1-02" }),
      node({ id: "a", code: "A", parent_id: "r", status: "已完成" }),
      node({ id: "b", code: "B", parent_id: "r", status: "进行中" }),
      node({ id: "c", code: "C", parent_id: "r", status: "受阻" }),
      node({ id: "d", code: "D", parent_id: "r", status: "审查中" }),
      // Cancelled work no longer occupies the plan.
      node({ id: "e", code: "E", parent_id: "r", progress: 100, status: "已取消" }),
    ]);
    expect(cockpitSubtreeAverage(tree[0]!)).toBe(44);
  });
});

describe("cockpitEffectiveProgress", () => {
  it.each([
    ["已完成", 0, 100], [" Completed ", 0, 100], ["进行中", 0, 50],
    ["in_review", 0, 50], ["等待期", 0, 50], [" on hold ", 0, 50],
    ["受阻", 0, 25], ["BLOCKED", 0, 25], ["未开始", 0, 0], ["unknown", 0, 0],
    ["已取消", 0, 0], ["已完成", 20, 20], ["进行中", 140, 100],
  ])("derives %s at %s percent as %s", (status, progress, expected) => {
    expect(cockpitEffectiveProgress(node({ id: "x", code: "X", status, progress }))).toBe(expected);
  });
});

describe("cockpitAggStatusColor", () => {
  it.each([
    [["已完成", "受阻", "进行中"], "var(--destructive)"],
    [["已完成", "等待期"], "var(--brand)"],
    [["已完成", "已取消"], "var(--success)"],
    [["已完成", "未开始"], "var(--faint-foreground)"],
    [["已取消"], "var(--muted-foreground)"],
  ])("summarises live leaves %j", (statuses, expected) => {
    const tree = buildCockpitTree([
      node({ id: "r", code: "R", status: "受阻" }),
      node({ id: "branch", code: "B", parent_id: "r", status: "受阻" }),
      ...statuses.map((status, i) => node({ id: `${i}`, code: `${i}`, parent_id: "branch", status })),
    ]);
    expect(cockpitAggStatusColor(tree[0]!)).toBe(expected);
  });
});

describe("cockpitPaymentTone", () => {
  it.each([
    ["完全支付", "paid"], ["已支付", "paid"], [" PAID ", "paid"],
    ["合同已定", "contract"], ["已签合同", "contract"], ["Contracted", "contract"],
    ["规划中", "planning"], ["planning", "planning"], [" Planned ", "planning"],
    ["未支付", "pending"], ["", "pending"], ["unknown", "pending"],
  ])("classifies %s as %s", (status, expected) => {
    expect(cockpitPaymentTone(status)).toBe(expected);
  });
});

describe("cockpitCoreNodes", () => {
  it("groups leaves by day and kind, with inclusive horizon and progress thresholds", () => {
    const specs: Partial<CockpitNode>[] = [
      { status: "已完成", end_date: "2026-05-01" },
      { progress: 100, end_date: "2026-05-01" },
      { status: "受阻", end_date: "2026-05-01" },
      { status: "进行中", progress: 1, end_date: "2026-06-15" },
      { status: "进行中", progress: 1, end_date: "2026-07-15" },
      { status: "进行中", progress: 1, end_date: "2026-07-16" },
      { status: "进行中", progress: 40, end_date: "2026-08-01" },
      { status: "进行中", progress: 39, end_date: "2026-08-01" },
      { status: "进行中", progress: 0, end_date: "2026-08-01" },
      { status: "已取消", progress: 100, end_date: "2026-05-01" },
      { status: "等待期", end_date: "2026-06-20" },
      { status: "未开始", end_date: "2026-06-20" },
      { status: "已完成" },
    ];
    const tree = buildCockpitTree([
      node({ id: "r", code: "R", status: "已完成", end_date: "2026-01-01" }),
      ...specs.map((over, i) => node({ ...over, id: `${i}`, code: `${i}`.padStart(2, "0"), parent_id: "r" })),
    ]);
    expect(cockpitCoreNodes(tree[0]!, "2026-06-15").map((g) => [g.date, g.kind, g.nodes.map((n) => n.id)])).toEqual([
      ["2026-05-01", "blocked", ["2"]], ["2026-05-01", "done", ["0", "1"]],
      ["2026-06-15", "upcoming", ["3"]], ["2026-07-15", "upcoming", ["4"]],
      ["2026-08-01", "upcoming", ["6", "8"]],
    ]);
  });
});

// One schedule matrix owns the arithmetic for both module and toolbar figures.
describe("goal and overall progress", () => {
  const nodes = [
    node({ id: "r", code: "R", progress: 100, status: "已完成" }),
    node({ id: "a", code: "A", parent_id: "r", status: "进行中", start_date: "2026-06-01", end_date: "2026-06-21" }),
    node({ id: "b", code: "B", parent_id: "r", progress: 20, status: "未开始", start_date: "2026-06-01", end_date: "2026-06-21" }),
    node({ id: "undated", code: "U", parent_id: "r", status: "受阻" }),
    node({ id: "cross", code: "X", parent_id: "r", progress: 100, status: "已完成", end_date: "2027-01-01" }),
    node({ id: "cancelled", code: "C", parent_id: "r", status: "已取消", progress: 100 }),
  ];
  it("excludes cancelled leaves and cross-year work from the annual goal, but not undated work", () => {
    expect(cockpitGoalProgress(buildCockpitTree(nodes)[0]!, "2026-06-11", "2026-12-31")).toEqual({
      actual: 32, scheduled: 50, gapPts: 18, latestEnd: "2026-06-21", planVsGoalDays: -193,
      taskCount: 3, crossYearCount: 1, behind: true,
    });
    // The toolbar means run over work items only: the root row is a project,
    // and a project's own figure never enters the mean. The year figure only
    // covers rows with both dates ending by the goal.
    expect(cockpitOverallProgress(nodes, "2026-06-11", "2026-12-31")).toEqual({
      overall: 49, thisYear: 35, scheduled: 50, behind: true,
    });
  });
  it.each([["2026-05-01", 0, false], ["2026-07-01", 100, true]] as const)(
    "clamps scheduled progress at %s", (today, scheduled, behind) => {
      expect(cockpitGoalProgress(buildCockpitTree(nodes)[0]!, today, null)).toMatchObject({
        actual: 49, scheduled, gapPts: scheduled - 49, taskCount: 4, crossYearCount: 0, planVsGoalDays: null, behind,
      });
      expect(cockpitOverallProgress(nodes, today, null)).toEqual({ overall: 49, thisYear: 49, scheduled, behind });
    },
  );
  it("reports nulls rather than fabricated percentages when all work is cancelled or cross-year", () => {
    const cross = node({ id: "x", code: "X", kind: "work_item", end_date: "2027-01-01", progress: 20, status: "进行中" });
    expect(cockpitGoalProgress(buildCockpitTree([cross])[0]!, "2026-06-11", "2026-12-31")).toEqual({
      actual: null, scheduled: null, gapPts: null, latestEnd: null, planVsGoalDays: null,
      taskCount: 0, crossYearCount: 1, behind: false,
    });
    expect(cockpitOverallProgress([cross], "2026-06-11", "2026-12-31")).toEqual({ overall: 20, thisYear: null, scheduled: null, behind: false });
    expect(cockpitOverallProgress([], "2026-06-11", null)).toEqual({ overall: null, thisYear: null, scheduled: null, behind: false });
  });
  it("does not schedule undated, same-day, or reversed windows", () => {
    const invalid = [
      node({ id: "r", code: "R", status: "未开始" }),
      node({ id: "a", code: "A", parent_id: "r", status: "已完成" }),
      node({ id: "b", code: "B", parent_id: "r", status: "未开始", start_date: "2026-06-11", end_date: "2026-06-11" }),
      node({ id: "c", code: "C", parent_id: "r", status: "未开始", start_date: "2026-06-12", end_date: "2026-06-11" }),
    ];
    expect(cockpitGoalProgress(buildCockpitTree(invalid)[0]!, "2026-06-11", "2026-06-11")).toMatchObject({
      actual: 33, scheduled: null, gapPts: null, taskCount: 3, crossYearCount: 0, planVsGoalDays: 0, behind: false,
    });
    // The root is a project: only its three work items enter the mean.
    expect(cockpitOverallProgress(invalid, "2026-06-11", "2026-06-11")).toEqual({ overall: 33, thisYear: 0, scheduled: null, behind: false });
  });
});

// An unscheduled row — empty status, or the 未排期/待确认 wording — is shown
// as "未排期" in the gantt, and no progress tally counts it.
describe("unscheduled rows stay out of every progress tally", () => {
  const tree = buildCockpitTree([
    node({ id: "r", code: "L1-01" }),
    node({ id: "done", code: "D", parent_id: "r", status: "已完成", progress: 100 }),
    node({ id: "empty", code: "E", parent_id: "r", end_date: "2026-01-01" }),
    node({ id: "legacy", code: "L", parent_id: "r", status: "待确认", progress: 30 }),
    node({ id: "worded", code: "W", parent_id: "r", status: "未排期", progress: 60 }),
  ]);

  it("recognises an empty status and both wordings", () => {
    expect(isCockpitNodeUnscheduled(node({ id: "1", code: "A" }))).toBe(true);
    expect(isCockpitNodeUnscheduled(node({ id: "2", code: "B", status: " 待确认 " }))).toBe(true);
    expect(isCockpitNodeUnscheduled(node({ id: "3", code: "C", status: "未排期" }))).toBe(true);
    expect(isCockpitNodeUnscheduled(node({ id: "4", code: "D", status: "Unscheduled" }))).toBe(true);
    expect(isCockpitNodeUnscheduled(node({ id: "5", code: "E", status: "进行中" }))).toBe(false);
  });

  it("drops them from roll-up counts and averages, even when a progress figure was typed", () => {
    const rollups = computeCockpitRollups(tree, "2026-06-01");
    expect(rollups.get("r")!).toMatchObject({ leafCount: 1, doneCount: 1, progress: 100, lateCount: 0 });
    expect(rollups.get("r")!.live).toMatchObject({ leafCount: 1, doneCount: 1, doneRatio: 100 });
    expect(cockpitSubtreeAverage(tree[0]!)).toBe(100);
  });

  it("drops them from the annual goal and the toolbar means", () => {
    expect(cockpitGoalProgress(tree[0]!, "2026-06-11", "2026-12-31")).toMatchObject({
      actual: 100, taskCount: 1, crossYearCount: 0,
    });
    expect(cockpitOverallProgress(tree[0]!.children.map((c) => c.node), "2026-06-11", "2026-12-31")).toEqual({
      overall: 100, thisYear: null, scheduled: null, behind: false,
    });
  });

  it("does not count them as work a month is expected to land", () => {
    const cells = computeCockpitMonths(
      board({
        nodes: [
          node({ id: "a", code: "A", status: "未开始", end_date: "2026-03-10" }),
          node({ id: "u", code: "U", end_date: "2026-03-20" }),
        ],
      }),
    );
    expect(cells.find((c) => c.month === "2026-03")!).toMatchObject({ dueCount: 1, doneCount: 0 });
  });
});

describe("week axis boundaries", () => {
  it("clips the first month and accounts for every remaining day", () => {
    const axis = computeCockpitAxis([node({ id: "x", code: "X", kind: "work_item", start_date: "2026-03-22", end_date: "2026-04-10" })], "2026-03-25", { zoom: "week" });
    expect(axis.start.toISOString().slice(0, 10)).toBe("2026-03-16");
    expect(axis.end.toISOString().slice(0, 10)).toBe("2026-04-30");
    expect(axis.days).toBe(46);
    expect(axisMonths(axis)).toEqual([
      { key: "2026-03", offset: 0, days: 16 }, { key: "2026-04", offset: 16, days: 30 },
    ]);
  });
  it("converges to the earliest task's week even when that week is in the future", () => {
    const axis = computeCockpitAxis([node({ id: "x", code: "X", kind: "work_item", start_date: "2026-03-18", end_date: "2026-04-10" })], "2026-03-10", { zoom: "week" });
    expect(axis.start.toISOString().slice(0, 10)).toBe("2026-03-16");
  });
  it("keeps the annual fallback at week density when no execution dates exist", () => {
    const axis = computeCockpitAxis([], "2026-06-15", { zoom: "week" });
    expect(axis.start.toISOString().slice(0, 10)).toBe("2026-01-01");
    expect(axis.days).toBe(365);
  });
});

describe("finance ledger totals", () => {
  it("never invents a payment for a paid task without listed instalments", () => {
    const summary = computeCockpitFinance(board({
      nodes: [
        node({ id: "r", code: "R" }),
        node({ id: "paid", code: "P", parent_id: "r", budget_amount: 40, exec_status: " PAID " }),
        node({ id: "unitemised", code: "U", parent_id: "r", budget_amount: 20, exec_status: "完全支付" }),
        node({ id: "signed", code: "S", parent_id: "r", budget_amount: 30, exec_status: " Contracted " }),
        node({ id: "transfer-only", code: "T", parent_id: "r", exec_status: "已支付" }),
      ],
      payments: [
        { id: "1", node_id: "paid", label: "", pay_date: "2026-06-10", amount: 5, position: 0 },
        { id: "2", node_id: "paid", label: "", pay_date: "2026-07-10", amount: 5, position: 1 },
        { id: "3", node_id: "signed", label: "", pay_date: "2026-06-15", amount: 10, position: 0 },
        { id: "4", node_id: "transfer-only", label: "", pay_date: "2026-06-15", amount: 8, position: 0 },
      ],
    }));
    expect(summary).toMatchObject({ planned: 28, actual: 18, outstanding: 10,
      lineCount: 4, paidLineCount: 3, contracted: 10, paymentCount: 4 });
    expect(summary.byModule).toEqual([{ code: "R", name: "R", color: "", lineCount: 4,
      planned: 28, actual: 18, outstanding: 10 }]);
  });
});

describe("module highlight eligibility", () => {
  it("requires a deliverable for results, skips cancelled tasks, and breaks same-date ties by code", () => {
    const tree = buildCockpitTree([
      node({ id: "r", code: "R", status: "已完成", deliverable: "Heading", end_date: "2026-12-31" }),
      node({ id: "no-result", code: "N", parent_id: "r", status: "已完成", deliverable: " ", end_date: "2026-06-15" }),
      node({ id: "b", code: "B", parent_id: "r", status: "已完成", deliverable: "B", end_date: "2026-06-10" }),
      node({ id: "a", code: "A", parent_id: "r", status: "已完成", deliverable: "A", end_date: "2026-06-10" }),
      node({ id: "cancelled", code: "C", parent_id: "r", status: "已取消", end_date: "2026-06-15" }),
      node({ id: "today", code: "T", parent_id: "r", end_date: "2026-06-15" }),
    ]);
    const highlights = cockpitModuleHighlights(tree[0]!, "2026-06-15");
    expect(highlights.recent?.id).toBe("a");
    expect(highlights.next?.id).toBe("today");
  });
});
