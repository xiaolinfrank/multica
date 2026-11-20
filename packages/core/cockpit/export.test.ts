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

describe("complete scoped CSV export", () => {
  it("quotes the stored row code, preserves reference identifiers and excludes context-only ancestor amounts", () => {
    const source = {
      nodes: [node({ id: "ancestor", code: "09", name: "Outside scope", budget_amount: 900 }),
        node({ id: "module", code: "09.03", parent_id: "ancestor", name: "Scoped module", budget_amount: 40 })],
      // The ledger lists instalments: the scoped module needs one to appear.
      payments: [{ id: "pay-1", node_id: "module", label: "首款", pay_date: "2026-01-10", amount: 40, position: 0 }],
      issue_links: [{ node_id: "module", issue_identifier: "BIO-42" }],
    };
    const options = { contextNodeIds: new Set(["ancestor"]) };
    const tasks = cockpitTasksCsv(source, options);
    expect(tasks).toContain('="09.03"'); expect(tasks).toContain("BIO-42"); expect(tasks).toContain("Scoped module");
    expect(tasks).not.toContain("Outside scope"); expect(tasks).not.toContain("900");
    const finance = cockpitFinanceCsv(source, options);
    expect(finance).toContain('="09.03"'); expect(finance).toContain("BIO-42"); expect(finance).not.toContain("900");
  });

  it("keeps whitespace-prefixed formula text inert in an explicitly requested export", () => {
    const csv = cockpitTasksCsv({ nodes: [node({ id: "row", code: "row", name: "\t=SUM(1,2)" })], payments: [], issue_links: [] });
    expect(csv).toContain('"\'\t=SUM(1,2)"');
  });
});

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
    // The row's own code is the address both the gantt and the CSV quote.
    expect(lines[1]).toContain("L1,L1-01,,数据底座");
    // Codes with a leading zero are forced to text or Excel reads them as dates.
    expect(lines[2]).toContain('L2,="01.01",L1-01,甲');
    expect(lines[3]).toContain('L2,="01.02",L1-01,乙');
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
    expect(lines[1]).toContain("L1-02");
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
    expect(csv.split("\r\n")[1]).toContain("2026-02-01,,45,45,");
  });
});

describe("instalment CSV rows", () => {
  it("keeps separate dates and amounts for two instalments on one task", () => {
    const csv = cockpitFinanceCsv(board({
      nodes: [node({ id: "a", code: "01.01", budget_amount: 100, exec_status: "未支付" })],
      payments: [
        { id: "p1", node_id: "a", label: "首期", pay_date: "2026-01-10", amount: 30, position: 0 },
        { id: "p2", node_id: "a", label: "尾款", pay_date: "2026-02-10", amount: 20, position: 1 },
      ],
    }));
    const lines = csv.split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("首期,");
    expect(lines[1]).toContain("2026-01-10,,100,30,");
    expect(lines[2]).toContain("尾款,");
    expect(lines[2]).toContain("2026-02-10,,100,20,");
  });
});
