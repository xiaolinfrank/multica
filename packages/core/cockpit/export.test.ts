// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { CockpitBoard, CockpitNode } from "../types";
import { cockpitFinanceCsv, cockpitTasksCsv } from "./export";

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

describe("cockpitTasksCsv", () => {
  it("emits one line per node in board order, with the parent by code", () => {
    const csv = cockpitTasksCsv(
      board({
        nodes: [
          node({ id: "r", code: "L1-01", name: "数据底座" }),
          node({ id: "b", code: "01.02", parent_id: "r", position: 2, name: "乙" }),
          node({ id: "a", code: "01.01", parent_id: "r", position: 1, name: "甲" }),
        ],
      }),
    );
    const lines = csv.split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(4);
    // The shipped numbering quotes a mainline as "01" the way the gantt does.
    expect(lines[1]).toContain('L1,="01",,数据底座');
    // Codes with a leading zero are forced to text or Excel reads them as dates.
    expect(lines[2]).toContain('L2,="01.01",="01",甲');
    expect(lines[3]).toContain('L2,="01.02",="01",乙');
  });

  it("neutralises a cell that would otherwise run as a spreadsheet formula", () => {
    const csv = cockpitTasksCsv(
      board({ nodes: [node({ id: "r", code: "L1-01", name: "=HYPERLINK(\"x\")" })] }),
    );
    expect(csv).toContain("\"'=HYPERLINK(\"\"x\"\")\"");
  });

  it("quotes a value carrying a comma or a newline rather than splitting the row", () => {
    const csv = cockpitTasksCsv(
      board({ nodes: [node({ id: "r", code: "L1-01", note: "先 A，再 B\n然后 C" })] }),
    );
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(2);
    expect(csv).toContain('"先 A，再 B\n然后 C"');
  });

  it("starts with a BOM so Excel opens it as UTF-8", () => {
    expect(cockpitTasksCsv(board({}))).toMatch(/^\uFEFF/);
  });
});

describe("shipped row codes", () => {
  // The v1.2 summary merge folds 02.02-09 into one "02.02" row and shows the
  // stored 02.10 as "02.03"; the CSVs quote those shipped numbers, not the
  // stored history, so a code copied from the gantt finds the same row here.
  const mergedNodes = [
    node({ id: "l2", code: "L1-02", name: "Platform" }),
    node({ id: "dir1", code: "02.01", parent_id: "l2", name: "Infra" }),
    node({ id: "dir2", code: "02.02", parent_id: "l2", name: "Arch" }),
    node({ id: "dir3", code: "02.03", parent_id: "l2", name: "Data" }),
    node({ id: "dir10", code: "02.10", parent_id: "l2", name: "院端节点与部署" }),
    node({ id: "t2", code: "L3-02-02", parent_id: "dir2", name: "Design" }),
    node({ id: "t3", code: "L3-02-08", parent_id: "dir3", name: "Ship", budget_amount: 100 }),
    node({ id: "t16", code: "L3-02-16", parent_id: "dir10", name: "Box" }),
  ];

  it("tasks CSV numbers merged rows by the shipped outline, parents included", () => {
    const csv = cockpitTasksCsv(board({ nodes: mergedNodes }));
    expect(csv).toContain('="02.01"');
    expect(csv).toContain('="02.02.01"');
    expect(csv).toContain('="02.02.02"');
    expect(csv).toContain('="02.03.01"');
    expect(csv).not.toContain("L3-02-08");
    // The task's parent cell names the group row it ships under, not the
    // folded direction its stored parent_id points at.
    expect(csv).toMatch(/="02\.02\.02",="02\.02"/);
    // The renamed direction reads its shipped name, not the stored one.
    expect(csv).toContain("院端一体机与部署");
    expect(csv).not.toContain("院端节点与部署");
  });

  it("finance CSV numbers spend lines the same way", () => {
    const csv = cockpitFinanceCsv(board({
      nodes: mergedNodes,
      payments: [{ id: "p1", node_id: "t3", label: "首期", pay_date: "2026-10-15", amount: 40, position: 0 }],
    }));
    expect(csv).toContain('="02",="02.02.02"');
    expect(csv).not.toContain("L3-02-08");
  });
});

describe("cockpitFinanceCsv", () => {
  it("writes the spend lines with the derived dates and actuals", () => {
    const csv = cockpitFinanceCsv(
      board({
        nodes: [
          node({ id: "r", code: "L1-02", name: "算力" }),
          node({
            id: "a",
            code: "02.01",
            parent_id: "r",
            name: "联通算力服务费",
            budget_amount: 45,
            exec_status: "完全支付",
            vendor: "联通",
          }),
          node({ id: "z", code: "02.02", parent_id: "r", name: "无预算项" }),
        ],
        payments: [
          { id: "p1", node_id: "a", label: "首期", pay_date: "2026-02-01", amount: 45, position: 0 },
        ],
      }),
    );
    const lines = csv.split("\r\n").filter(Boolean);
    // The row with neither budget nor instalments is not a spend line.
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('="02"');
    expect(lines[1]).toContain("2026-02-01,2026-02-01,45,45,联通");
  });

  it("leaves the actual columns empty while the row has not been paid", () => {
    const csv = cockpitFinanceCsv(
      board({
        nodes: [
          node({ id: "r", code: "L1-02" }),
          node({ id: "a", code: "02.01", parent_id: "r", budget_amount: 45, exec_status: "合同已定" }),
        ],
        payments: [
          { id: "p1", node_id: "a", label: "首期", pay_date: "2026-02-01", amount: 45, position: 0 },
        ],
      }),
    );
    expect(csv.split("\r\n")[1]).toContain("2026-02-01,,45,,");
  });
});
