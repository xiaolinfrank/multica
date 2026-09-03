// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { CockpitBoard, CockpitMilestone, CockpitNode } from "../types";
import {
  axisMonths,
  buildCockpitTree,
  cockpitStatusColor,
  computeCockpitAxis,
  computeCockpitDigest,
  computeCockpitFinance,
  computeCockpitFinanceRows,
  computeCockpitMonths,
  computeCockpitRollups,
  flattenCockpitTree,
  groupPaymentsByNode,
  groupSubtreePayments,
  isCockpitMilestoneDone,
  isCockpitNodeDrifting,
  isCockpitNodeLate,
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
      created_at: "",
      updated_at: "",
    },
    nodes: [],
    payments: [],
    issue_links: [],
    milestones: [],
    meetings: [],
    ...over,
  };
}

describe("buildCockpitTree", () => {
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
      node({ id: "c", code: "01.01", parent_id: "r" }),
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

  // A branch with 40 tasks must not weigh the same as its sibling with 2.
  it("weights a deep branch by how much work it holds", () => {
    const nodes: CockpitNode[] = [node({ id: "root", code: "ROOT" })];
    nodes.push(node({ id: "big", code: "BIG", parent_id: "root" }));
    nodes.push(node({ id: "small", code: "SMALL", parent_id: "root" }));
    for (let i = 0; i < 9; i++) {
      nodes.push(node({ id: `big-${i}`, code: `BIG-${i}`, parent_id: "big", progress: 0 }));
    }
    nodes.push(node({ id: "small-0", code: "SMALL-0", parent_id: "small", progress: 100 }));

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
  it("splits instalments by their node's execution status", () => {
    const summary = computeCockpitFinance(
      board({
        nodes: [
          node({ id: "paid", code: "P", budget_amount: 20, exec_status: "完全支付" }),
          node({ id: "signed", code: "S", budget_amount: 30, exec_status: "合同已定" }),
          node({ id: "planned", code: "N", budget_amount: 50, exec_status: "规划中" }),
        ],
        payments: [
          { id: "1", node_id: "paid", label: "", pay_date: "2026-01-05", amount: 20, position: 0 },
          { id: "2", node_id: "signed", label: "", pay_date: "2026-02-05", amount: 30, position: 0 },
        ],
      }),
    );

    expect(summary.budget).toBe(100);
    expect(summary.paid).toBe(20);
    expect(summary.contracted).toBe(30);
    // 100 budgeted, 50 with an instalment plan behind it.
    expect(summary.unplanned).toBe(50);
    expect(summary.paymentCount).toBe(2);
  });

  it("never reports negative unplanned budget when instalments exceed the plan", () => {
    const summary = computeCockpitFinance(
      board({
        nodes: [node({ id: "n", code: "N", budget_amount: 10 })],
        payments: [{ id: "1", node_id: "n", label: "", pay_date: null, amount: 40, position: 0 }],
      }),
    );
    expect(summary.unplanned).toBe(0);
  });
});

describe("computeCockpitMonths", () => {
  it("buckets money and work by month and fills the gaps between them", () => {
    const cells = computeCockpitMonths(
      board({
        nodes: [
          node({ id: "a", code: "A", end_date: "2026-01-20", status: "已完成" }),
          node({ id: "b", code: "B", end_date: "2026-04-10" }),
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
    node({ id: "done", code: "D", status: "已完成", end_date: "2026-06-10" }),
    node({ id: "old-done", code: "OD", status: "已完成", end_date: "2026-01-10" }),
    node({ id: "soon", code: "S", end_date: "2026-06-20" }),
    node({ id: "far", code: "F", end_date: "2026-12-20" }),
    node({ id: "late", code: "L", end_date: "2026-05-01" }),
    node({ id: "blocked", code: "B", status: "受阻", end_date: "2026-07-01" }),
    node({ id: "cancelled", code: "C", status: "已取消", end_date: "2026-05-01" }),
  ];
  const digest = computeCockpitDigest(nodes, "2026-06-15");

  it("reports only work finished inside the trailing window", () => {
    expect(digest.recentlyDone.map((n) => n.id)).toEqual(["done"]);
  });

  it("reports only work due inside the leading window", () => {
    expect(digest.upcoming.map((n) => n.id)).toEqual(["soon"]);
  });

  it("puts overdue and blocked work under support, and drops cancelled work entirely", () => {
    expect(digest.needsSupport.map((n) => n.id)).toEqual(["late", "blocked"]);
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

  it("collapses a branch's instalments onto one marker per calendar day", () => {
    const tree = buildCockpitTree(nodes);
    const groups = groupSubtreePayments(
      tree[0]!,
      groupPaymentsByNode(payments),
      new Map(nodes.map((n) => [n.id, n])),
    );
    expect(groups.map((g) => [g.date, g.entries.length, g.total])).toEqual([
      ["2026-03-01", 2, 15],
      ["2026-09-01", 1, 7],
    ]);
  });

  it("colours a mixed day by the most advanced execution status in it", () => {
    const tree = buildCockpitTree(nodes);
    const groups = groupSubtreePayments(
      tree[0]!,
      groupPaymentsByNode(payments),
      new Map(nodes.map((n) => [n.id, n])),
    );
    expect(groups[0]!.execStatus).toBe("完全支付");
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
    { id: "p2", node_id: "b", label: "全款", pay_date: "2026-02-01", amount: 40, position: 0 },
  ];

  it("lists only the rows that carry money, in board order", () => {
    const rows = computeCockpitFinanceRows(buildCockpitTree(nodes), payments);
    expect(rows.map((r) => r.node.code)).toEqual(["01.01", "01.02"]);
    expect(rows.every((r) => r.rootCode === "L1-01" && r.rootColor === "#2563eb")).toBe(true);
  });

  it("reports an actual date and amount only once the row reads as paid", () => {
    const rows = computeCockpitFinanceRows(buildCockpitTree(nodes), payments);
    expect(rows[0]).toMatchObject({ plannedDate: "2026-03-01", actualDate: null, actualAmount: null });
    expect(rows[1]).toMatchObject({ plannedDate: "2026-02-01", actualDate: "2026-02-01", actualAmount: 40 });
  });

  it("keeps a row that has instalments but no budget figure", () => {
    const withPaymentOnly = [...nodes, node({ id: "d", code: "01.04", parent_id: "r" })];
    const rows = computeCockpitFinanceRows(buildCockpitTree(withPaymentOnly), [
      ...payments,
      { id: "p3", node_id: "d", label: "首期", pay_date: "2026-05-01", amount: 8, position: 0 },
    ]);
    expect(rows.map((r) => r.node.code)).toContain("01.04");
    expect(rows.find((r) => r.node.code === "01.04")!.budget).toBe(0);
  });
});
