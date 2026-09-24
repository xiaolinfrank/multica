// CSV export for the cockpit board.
//
// The board a programme reviews in a meeting is not always the board it files:
// finance wants the spend lines in a spreadsheet, and a steering pack wants the
// task list flat. Both fall out of the same tree, so both are derived here
// rather than re-typed somewhere else.

import type { CockpitBoard, CockpitIssueLink, CockpitNode } from "../types";
import {
  buildCockpitDisplayCodes,
  buildCockpitSummaryTree,
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
  // The numbers a reader copies from the gantt must find the same rows here:
  // quote the shipped summary codes, not the stored history. A folded member
  // direction is not a gantt row and keeps its stored code.
  const summaryTree = buildCockpitSummaryTree(tree);
  const displayCodes = buildCockpitDisplayCodes(summaryTree);
  const nodeById = new Map(board.nodes.map((n) => [n.id, n]));
  const codeOf = (n: CockpitNode): string => displayCodes.get(n.id) ?? n.code;
  // Names too: a renamed direction ("院端一体机与部署") reads its shipped name
  // here, folded members keep their stored one.
  const shippedName = new Map<string, string>();
  const walkNames = (entry: CockpitTreeNode) => {
    shippedName.set(entry.node.id, entry.node.name);
    entry.children.forEach(walkNames);
  };
  summaryTree.forEach(walkNames);
  const nameOf = (n: CockpitNode): string => shippedName.get(n.id) ?? n.name;
  // The parent a row ships under: a merged task's shipped parent is the group
  // row, not the folded direction its stored parent_id names.
  const shippedParentCode = new Map<string, string>();
  const walkParents = (entry: CockpitTreeNode) => {
    for (const child of entry.children) {
      shippedParentCode.set(child.node.id, displayCodes.get(entry.node.id) ?? entry.node.code);
      walkParents(child);
    }
  };
  summaryTree.forEach(walkParents);
  const parentOf = (n: CockpitNode): string =>
    shippedParentCode.get(n.id) ??
    (n.parent_id && nodeById.has(n.parent_id) ? codeOf(nodeById.get(n.parent_id)!) : "");

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
        codeOf(n),
        parentOf(n),
        nameOf(n),
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
  const displayCodes = buildCockpitDisplayCodes(buildCockpitSummaryTree(tree));
  const codeOf = (n: CockpitNode): string => displayCodes.get(n.id) ?? n.code;
  const rootNumberOf = new Map(
    tree.map((root) => [root.node.code, displayCodes.get(root.node.id) ?? root.node.code]),
  );
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
        rootNumberOf.get(row.rootCode) ?? row.rootCode,
        codeOf(row.node),
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
