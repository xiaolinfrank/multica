// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { CockpitBoard, CockpitMilestone, CockpitNode } from "../types";
import {
  axisMonths,
  buildCockpitDisplayCodes,
  buildCockpitSummaryTree,
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
  cockpitSummaryCollapseIds,
  computeCockpitAxis,
  computeCockpitDigest,
  computeCockpitFinance,
  computeCockpitFinanceRows,
  computeCockpitMonths,
  computeCockpitRollups,
  flattenCockpitTree,
  groupPaymentsByNode,
  groupSubtreePayments,
  isCockpitExecNode,
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
    expect(summary.planned).toBe(100);
    // Only the fully-paid line counts as spent, at its own budget.
    expect(summary.actual).toBe(20);
    expect(summary.outstanding).toBe(80);
    expect(summary.lineCount).toBe(3);
    expect(summary.paidLineCount).toBe(1);
    expect(summary.contracted).toBe(30);
    expect(summary.paymentCount).toBe(2);
  });

  it("rolls the ledger up per module in code order", () => {
    const summary = computeCockpitFinance(
      board({
        nodes: [
          node({ id: "m2", code: "L1-02", name: "Platform" }),
          node({ id: "m1", code: "L1-01", name: "Datasets" }),
          node({ id: "a", code: "L3-01-01", parent_id: "m1", budget_amount: 10 }),
          node({
            id: "b",
            code: "L3-02-01",
            parent_id: "m2",
            budget_amount: 40,
            exec_status: "完全支付",
          }),
        ],
      }),
    );
    expect(summary.byModule.map((m) => [m.code, m.lineCount, m.planned, m.actual])).toEqual([
      ["L1-01", 1, 10, 0],
      ["L1-02", 1, 40, 40],
    ]);
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
          node({ id: "c", code: "C", end_date: "2026-04-01" }),
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
        node({ id: "r", code: "R", start_date: "2026-03-02", end_date: "2026-05-20" }),
        node({ id: "a", code: "A", parent_id: "r", start_date: "2026-03-18", end_date: "2026-05-20" }),
      ],
      "2026-04-01",
      { zoom: "week" },
    );
    // 2026-03-02 is itself a Monday, and the parent row is execution work too:
    // the source sheet converges on the earliest task week, parents included.
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
    node({ id: "done", code: "D", status: "已完成", end_date: "2026-06-10" }),
    node({ id: "old-done", code: "OD", status: "已完成", end_date: "2026-01-10" }),
    node({ id: "soon", code: "S", end_date: "2026-06-20" }),
    node({ id: "far", code: "F", end_date: "2026-12-20" }),
    node({ id: "late", code: "L", status: "进行中", end_date: "2026-05-01" }),
    node({ id: "blocked", code: "B", status: "受阻", end_date: "2026-07-01" }),
    node({ id: "cancelled", code: "C", status: "已取消", end_date: "2026-05-01" }),
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

describe("buildCockpitDisplayCodes", () => {
  it("uses root ordinals and gap-free sibling positions without changing stored addresses", () => {
    const nodes = [
      node({ id: "r", code: "L1-3" }),
      node({ id: "b", code: "AI-99", parent_id: "r", position: 2 }),
      node({ id: "a", code: "L3-06-13", parent_id: "r", position: 1 }),
      node({ id: "g", code: "01.03", parent_id: "a" }),
      node({ id: "fallback", code: "MODULE", position: 1 }),
    ];
    expect([...buildCockpitDisplayCodes(buildCockpitTree(nodes))]).toEqual([
      ["r", "03"], ["a", "03.01"], ["g", "03.01.01"], ["b", "03.02"], ["fallback", "02"],
    ]);
    expect(nodes.map((n) => n.code)).toEqual(["L1-3", "AI-99", "L3-06-13", "01.03", "MODULE"]);
    expect(buildCockpitDisplayCodes([]).size).toBe(0);
  });

  it("keeps a stored zero-segment line code like 06.00 while other dotted codes stay positional", () => {
    const tree = buildCockpitTree([
      node({ id: "r", code: "L1-06" }),
      node({ id: "gov", code: "06.00", parent_id: "r", position: 1 }),
      node({ id: "t0", code: "06.00.01", parent_id: "gov", position: 1 }),
      node({ id: "d1", code: "06.01", parent_id: "r", position: 2 }),
      // Reordered dotted lines still number by position, not stored code.
      node({ id: "d9", code: "02.10", parent_id: "r", position: 3 }),
    ]);
    expect([...buildCockpitDisplayCodes(tree)]).toEqual([
      ["r", "06"], ["gov", "06.00"], ["t0", "06.00.01"],
      ["d1", "06.01"], ["d9", "06.02"],
    ]);
  });
});

describe("isCockpitExecNode", () => {
  it("reads structure rows by their stored codes, everything else as work", () => {
    expect(isCockpitExecNode("L1-02")).toBe(false);
    expect(isCockpitExecNode("02.03")).toBe(false);
    expect(isCockpitExecNode("AI-05-01")).toBe(false);
    // An empty direction is structure, not a task at 0%.
    expect(isCockpitExecNode("04.04")).toBe(false);
    expect(isCockpitExecNode("L3-02-03-01")).toBe(true);
    expect(isCockpitExecNode("（后续年度）")).toBe(true);
    expect(isCockpitExecNode("04.04-01")).toBe(true);
  });
});

describe("buildCockpitSummaryTree", () => {
  it("folds the merged directions into one row with their tasks flattened and renumbered", () => {
    const nodes = [
      node({ id: "l1", code: "L1-02", name: "Platform" }),
      node({ id: "d1", code: "02.01", parent_id: "l1", name: "Needs" }),
      node({ id: "t1", code: "L3-02-01-01", parent_id: "d1", name: "Spec" }),
      node({ id: "m1", code: "02.02", parent_id: "l1", name: "Old A" }),
      node({ id: "m2", code: "02.03", parent_id: "l1", name: "Old B" }),
      node({ id: "t2", code: "L3-02-02-01", parent_id: "m1", name: "Build" }),
      node({ id: "t3", code: "L3-02-03-01", parent_id: "m2", name: "Ship" }),
      node({ id: "d9", code: "02.10", parent_id: "l1", name: "Boxes" }),
    ];
    const tree = buildCockpitSummaryTree(buildCockpitTree(nodes));
    const rows = flattenCockpitTree(tree);
    // The group takes the first member's slot; members' tasks follow in
    // member order; the untouched directions keep their places.
    expect(rows.map((e) => [e.node.id, e.depth])).toEqual([
      ["l1", 0], ["d1", 1], ["t1", 2], ["02.02-09", 1], ["t2", 2], ["t3", 2], ["d9", 1],
    ]);
    // The rename is a display alias: the stored row keeps its own name.
    expect(rows.find((e) => e.node.id === "d9")!.node.name).toBe("院端一体机与部署");
    expect(nodes.find((n) => n.id === "d9")!.name).toBe("Boxes");
    // Positional codes over the summary shape: the group is one direction.
    expect([...buildCockpitDisplayCodes(tree)]).toEqual([
      ["l1", "02"], ["d1", "02.01"], ["t1", "02.01.01"],
      ["02.02-09", "02.02"], ["t2", "02.02.01"], ["t3", "02.02.02"], ["d9", "02.03"],
    ]);
    // First paint folds at the direction rows, tasks one click away.
    expect(new Set(cockpitSummaryCollapseIds(tree))).toEqual(new Set(["d1", "02.02-09"]));
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
    node({ id: "r", code: "R", progress: 100 }),
    node({ id: "a", code: "A", parent_id: "r", status: "进行中", start_date: "2026-06-01", end_date: "2026-06-21" }),
    node({ id: "b", code: "B", parent_id: "r", progress: 20, start_date: "2026-06-01", end_date: "2026-06-21" }),
    node({ id: "undated", code: "U", parent_id: "r", status: "受阻" }),
    node({ id: "cross", code: "X", parent_id: "r", progress: 100, end_date: "2027-01-01" }),
    node({ id: "cancelled", code: "C", parent_id: "r", status: "已取消", progress: 100 }),
  ];
  it("excludes cancelled leaves and cross-year work from the annual goal, but not undated work", () => {
    expect(cockpitGoalProgress(buildCockpitTree(nodes)[0]!, "2026-06-11", "2026-12-31")).toEqual({
      actual: 32, scheduled: 50, gapPts: 18, latestEnd: "2026-06-21", planVsGoalDays: -193,
      taskCount: 3, crossYearCount: 1, behind: true,
    });
    // The toolbar means run over every execution row — the parent included —
    // and the year figure only over rows with both dates ending by the goal.
    expect(cockpitOverallProgress(nodes, "2026-06-11", "2026-12-31")).toEqual({
      overall: 59, thisYear: 35, scheduled: 50, behind: true,
    });
  });
  it.each([["2026-05-01", 0, false], ["2026-07-01", 100, true]] as const)(
    "clamps scheduled progress at %s", (today, scheduled, behind) => {
      expect(cockpitGoalProgress(buildCockpitTree(nodes)[0]!, today, null)).toMatchObject({
        actual: 49, scheduled, gapPts: scheduled - 49, taskCount: 4, crossYearCount: 0, planVsGoalDays: null, behind,
      });
      expect(cockpitOverallProgress(nodes, today, null)).toEqual({ overall: 59, thisYear: 59, scheduled, behind });
    },
  );
  it("reports nulls rather than fabricated percentages when all work is cancelled or cross-year", () => {
    const cross = node({ id: "x", code: "X", end_date: "2027-01-01", progress: 20 });
    expect(cockpitGoalProgress(buildCockpitTree([cross])[0]!, "2026-06-11", "2026-12-31")).toEqual({
      actual: null, scheduled: null, gapPts: null, latestEnd: null, planVsGoalDays: null,
      taskCount: 0, crossYearCount: 1, behind: false,
    });
    expect(cockpitOverallProgress([cross], "2026-06-11", "2026-12-31")).toEqual({ overall: 20, thisYear: null, scheduled: null, behind: false });
    expect(cockpitOverallProgress([], "2026-06-11", null)).toEqual({ overall: null, thisYear: null, scheduled: null, behind: false });
  });
  it("does not schedule undated, same-day, or reversed windows", () => {
    const invalid = [
      node({ id: "r", code: "R" }),
      node({ id: "a", code: "A", parent_id: "r", status: "已完成" }),
      node({ id: "b", code: "B", parent_id: "r", start_date: "2026-06-11", end_date: "2026-06-11" }),
      node({ id: "c", code: "C", parent_id: "r", start_date: "2026-06-12", end_date: "2026-06-11" }),
    ];
    expect(cockpitGoalProgress(buildCockpitTree(invalid)[0]!, "2026-06-11", "2026-06-11")).toMatchObject({
      actual: 33, scheduled: null, gapPts: null, taskCount: 3, crossYearCount: 0, planVsGoalDays: 0, behind: false,
    });
    expect(cockpitOverallProgress(invalid, "2026-06-11", "2026-06-11")).toEqual({ overall: 25, thisYear: 0, scheduled: null, behind: false });
  });
});

describe("week axis boundaries", () => {
  it("clips the first month and accounts for every remaining day", () => {
    const axis = computeCockpitAxis([node({ id: "x", code: "X", start_date: "2026-03-22", end_date: "2026-04-10" })], "2026-03-25", { zoom: "week" });
    expect(axis.start.toISOString().slice(0, 10)).toBe("2026-03-16");
    expect(axis.end.toISOString().slice(0, 10)).toBe("2026-04-30");
    expect(axis.days).toBe(46);
    expect(axisMonths(axis)).toEqual([
      { key: "2026-03", offset: 0, days: 16 }, { key: "2026-04", offset: 16, days: 30 },
    ]);
  });
  it("converges to the earliest task's week even when that week is in the future", () => {
    const axis = computeCockpitAxis([node({ id: "x", code: "X", start_date: "2026-03-18", end_date: "2026-04-10" })], "2026-03-10", { zoom: "week" });
    expect(axis.start.toISOString().slice(0, 10)).toBe("2026-03-16");
  });
  it("keeps the annual fallback at week density when no execution dates exist", () => {
    const axis = computeCockpitAxis([], "2026-06-15", { zoom: "week" });
    expect(axis.start.toISOString().slice(0, 10)).toBe("2026-01-01");
    expect(axis.days).toBe(365);
  });
});

describe("finance ledger totals", () => {
  it("counts paid budgets once regardless of instalment totals, including lines without transfers", () => {
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
    expect(summary).toMatchObject({ budget: 90, planned: 90, actual: 60, outstanding: 30,
      lineCount: 4, paidLineCount: 2, contracted: 10, paymentCount: 4 });
    expect(summary.byModule).toEqual([{ code: "R", name: "R", color: "", lineCount: 4, planned: 90, actual: 60 }]);
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
