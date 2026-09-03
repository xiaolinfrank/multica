// CSV export for the cockpit board.
//
// The board a programme reviews in a meeting is not always the board it files:
// finance wants the spend lines in a spreadsheet, and a steering pack wants the
// task list flat. Both fall out of the same tree, so both are derived here
// rather than re-typed somewhere else.

import type { CockpitBoard, CockpitIssueLink, CockpitNode } from "../types";
import {
  buildCockpitTree,
  computeCockpitFinanceRows,
  flattenCockpitTree,
  groupIssueLinksByNode,
  groupPaymentsByNode,
  type CockpitTreeNode,
} from "./model";

/**
 * Excel reads a bare `01.02` as a date and `=cmd` as a formula. Leading-zero
 * codes are forced to text; a leading `=`, `+`, `-` or `@` is quoted with an
 * apostrophe so the cell is inert. Decimal amounts stay numeric so a column can
 * still be summed.
 */
function csvCell(value: unknown): string {
  const s = value == null ? "" : String(value);
  if (/^0\d/.test(s) && /^[\d.]+$/.test(s)) return `="${s}"`;
  if (/^[=+\-@]/.test(s)) return `"'${s.replace(/"/g, '""')}"`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(",") + "\r\n";
}

/** Depth as a layer label, the way the board's own numbering reads. */
function layerLabel(depth: number): string {
  return `L${depth + 1}`;
}

function linkedIssues(links: Map<string, CockpitIssueLink[]>, node: CockpitNode): string {
  return (links.get(node.id) ?? []).map((l) => l.issue_identifier).join(" ");
}

/**
 * The task ledger: every row of the tree, in board order, with every field the
 * node panel can edit. A BOM is prefixed so Excel on Windows opens it as UTF-8.
 */
export function cockpitTasksCsv(board: CockpitBoard): string {
  const tree = buildCockpitTree(board.nodes);
  const rows = flattenCockpitTree(tree);
  const paymentsByNode = groupPaymentsByNode(board.payments);
  const linksByNode = groupIssueLinksByNode(board.issue_links);
  const codeById = new Map(board.nodes.map((n) => [n.id, n.code]));

  const out = [
    csvRow([
      "层级",
      "编号",
      "父级",
      "名称",
      "负责人",
      "协作人",
      "开始",
      "结束",
      "状态",
      "进度%",
      "交付物/成果",
      "当前进展",
      "依赖",
      "关联任务",
      "承担方/供应商",
      "预算",
      "预算归口",
      "预算执行状态",
      "分期付款",
      "对应合同",
      "数据来源",
      "备注",
    ]),
  ];

  for (const entry of rows) {
    const n = entry.node;
    out.push(
      csvRow([
        layerLabel(entry.depth),
        n.code,
        n.parent_id ? (codeById.get(n.parent_id) ?? "") : "",
        n.name,
        n.owner,
        n.collaborators,
        n.start_date ?? "",
        n.end_date ?? "",
        n.status,
        n.progress,
        n.deliverable,
        n.current_progress,
        n.dependencies,
        linkedIssues(linksByNode, n),
        n.vendor,
        n.budget_amount ?? "",
        n.budget_category,
        n.exec_status,
        (paymentsByNode.get(n.id) ?? [])
          .map((p) => `${p.label} ${p.pay_date ?? "待定"}：${p.amount}`)
          .join("；"),
        n.contract,
        n.source,
        n.note,
      ]),
    );
  }
  return "﻿" + out.join("");
}

/** The spend ledger — one line per node that carries money. */
export function cockpitFinanceCsv(board: CockpitBoard): string {
  const tree: CockpitTreeNode[] = buildCockpitTree(board.nodes);
  const linksByNode = groupIssueLinksByNode(board.issue_links);
  const out = [
    csvRow([
      "板块",
      "编号",
      "关联任务",
      "项目",
      "对应合同",
      "预计支出时间",
      "实际支出时间",
      "预计支出费用",
      "实际支出费用",
      "承担方/供应商",
      "预算归口",
      "预算执行状态",
      "分期付款",
    ]),
  ];
  for (const row of computeCockpitFinanceRows(tree, board.payments)) {
    out.push(
      csvRow([
        row.rootCode,
        row.node.code,
        linkedIssues(linksByNode, row.node),
        row.node.name,
        row.node.contract,
        row.plannedDate ?? "",
        row.actualDate ?? "",
        row.budget || "",
        row.actualAmount ?? "",
        row.node.vendor || row.node.owner,
        row.node.budget_category,
        row.node.exec_status,
        row.payments.map((p) => `${p.label} ${p.pay_date ?? "待定"}：${p.amount}`).join("；"),
      ]),
    );
  }
  return "﻿" + out.join("");
}
