import type {
  CockpitBoard,
  CockpitIssueLink,
  CockpitMilestone,
  CockpitNode,
  CockpitPayment,
} from "../types";

// Derivations over a cockpit board. Everything here is pure: the same board
// always yields the same tree, the same roll-ups and the same finance summary,
// so the numbers a person reads on the overview and the numbers on the gantt
// cannot disagree.
//
// The source board this feature replaces recomputed these inline in three
// render functions and drifted between them. One module, one answer.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A calendar day string ("YYYY-MM-DD") anchored at UTC midnight. */
export function parseDay(value: string | null | undefined): Date | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDay(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

/** "YYYY-MM" — the bucket key for the monthly finance and progress charts. */
export function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

export interface CockpitTreeNode {
  node: CockpitNode;
  /** 0 for a root. Derived by walking parent_id, never stored. */
  depth: number;
  children: CockpitTreeNode[];
  /** The colour this node paints with, inherited from the nearest ancestor that sets one. */
  color: string;
}

function sortSiblings(a: CockpitNode, b: CockpitNode): number {
  if (a.position !== b.position) return a.position - b.position;
  return a.code.localeCompare(b.code);
}

/**
 * Builds the forest. A node whose parent_id names a row that is not on the
 * board is treated as a root rather than dropped — losing work because one
 * parent reference went stale is worse than showing it at the top level.
 * A parent cycle is broken the same way, so the walk always terminates.
 */
export function buildCockpitTree(nodes: CockpitNode[]): CockpitTreeNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childrenOf = new Map<string | null, CockpitNode[]>();

  for (const node of nodes) {
    const parentId = node.parent_id && byId.has(node.parent_id) ? node.parent_id : null;
    const bucket = childrenOf.get(parentId);
    if (bucket) bucket.push(node);
    else childrenOf.set(parentId, [node]);
  }
  for (const bucket of childrenOf.values()) bucket.sort(sortSiblings);

  const visited = new Set<string>();
  const build = (node: CockpitNode, depth: number, inheritedColor: string): CockpitTreeNode => {
    visited.add(node.id);
    const color = node.color || inheritedColor;
    const children = (childrenOf.get(node.id) ?? [])
      .filter((child) => !visited.has(child.id))
      .map((child) => build(child, depth + 1, color));
    return { node, depth, children, color };
  };

  const roots = (childrenOf.get(null) ?? []).map((node) => build(node, 0, node.color));

  // Anything a cycle kept out of the forest still belongs on the board.
  const orphans = nodes.filter((n) => !visited.has(n.id)).sort(sortSiblings);
  for (const orphan of orphans) {
    if (visited.has(orphan.id)) continue;
    roots.push(build(orphan, 0, orphan.color));
  }
  return roots;
}

/** Depth-first order — the order the gantt and the table render rows in. */
export function flattenCockpitTree(tree: CockpitTreeNode[]): CockpitTreeNode[] {
  const out: CockpitTreeNode[] = [];
  const walk = (nodes: CockpitTreeNode[]) => {
    for (const entry of nodes) {
      out.push(entry);
      walk(entry.children);
    }
  };
  walk(tree);
  return out;
}

/** Every node id in this subtree, the node itself included. */
export function subtreeIds(entry: CockpitTreeNode): string[] {
  const ids: string[] = [];
  const walk = (e: CockpitTreeNode) => {
    ids.push(e.node.id);
    e.children.forEach(walk);
  };
  walk(entry);
  return ids;
}

// ---------------------------------------------------------------------------
// Roll-ups
// ---------------------------------------------------------------------------

export interface CockpitRollup {
  /** Leaf tasks in this subtree — a branch's own row is not counted as work. */
  leafCount: number;
  doneCount: number;
  lateCount: number;
  /** Mean leaf progress, 0-100. A branch with no leaves reports its own progress. */
  progress: number;
  /** Summed budget over the subtree, in the board's own unit. */
  budget: number;
  /** Earliest start and latest end across the subtree, for the branch's bar. */
  start: string | null;
  end: string | null;
}

/**
 * Which statuses read as finished. The board's vocabulary is the programme's
 * own free text, so this matches on the words a Chinese-language programme
 * board actually uses plus the English equivalents, and falls back to
 * progress >= 100 for anything else.
 */
const DONE_STATUSES = new Set(["已完成", "完成", "done", "completed", "closed"]);
const CANCELLED_STATUSES = new Set(["已取消", "取消", "cancelled", "canceled"]);

export function isCockpitNodeDone(node: CockpitNode): boolean {
  const status = node.status.trim().toLowerCase();
  if (DONE_STATUSES.has(node.status.trim()) || DONE_STATUSES.has(status)) return true;
  return node.progress >= 100;
}

export function isCockpitNodeCancelled(node: CockpitNode): boolean {
  const status = node.status.trim();
  return CANCELLED_STATUSES.has(status) || CANCELLED_STATUSES.has(status.toLowerCase());
}

/**
 * A node is late when its planned end has passed and it is neither done nor
 * cancelled. `today` is passed in rather than read from the clock so the
 * derivation stays pure and testable.
 */
export function isCockpitNodeLate(node: CockpitNode, today: string): boolean {
  if (!node.end_date) return false;
  if (isCockpitNodeDone(node) || isCockpitNodeCancelled(node)) return false;
  return node.end_date < today;
}

function minDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

function maxDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * Roll-ups for every node, keyed by id. Computed in one pass over the tree so a
 * board of a few hundred nodes costs one traversal, not one per rendered row.
 */
export function computeCockpitRollups(
  tree: CockpitTreeNode[],
  today: string,
): Map<string, CockpitRollup> {
  const rollups = new Map<string, CockpitRollup>();

  const visit = (entry: CockpitTreeNode): CockpitRollup => {
    const { node, children } = entry;
    const own: CockpitRollup = {
      leafCount: 0,
      doneCount: 0,
      lateCount: 0,
      progress: node.progress,
      budget: node.budget_amount ?? 0,
      start: node.start_date,
      end: node.end_date,
    };

    if (children.length === 0) {
      own.leafCount = 1;
      own.doneCount = isCockpitNodeDone(node) ? 1 : 0;
      own.lateCount = isCockpitNodeLate(node, today) ? 1 : 0;
      rollups.set(node.id, own);
      return own;
    }

    let progressSum = 0;
    for (const child of children) {
      const childRollup = visit(child);
      own.leafCount += childRollup.leafCount;
      own.doneCount += childRollup.doneCount;
      own.lateCount += childRollup.lateCount;
      own.budget += childRollup.budget;
      own.start = minDate(own.start, childRollup.start);
      own.end = maxDate(own.end, childRollup.end);
      progressSum += childRollup.progress * childRollup.leafCount;
    }
    // Weighted by leaf count, so a branch with 40 tasks does not weigh the same
    // as its sibling with 2.
    own.progress = own.leafCount > 0 ? progressSum / own.leafCount : node.progress;
    rollups.set(node.id, own);
    return own;
  };

  tree.forEach(visit);
  return rollups;
}

// ---------------------------------------------------------------------------
// Finance
// ---------------------------------------------------------------------------

/** Execution statuses that mean money actually left. */
const PAID_STATUSES = new Set(["完全支付", "已支付", "paid"]);
const CONTRACTED_STATUSES = new Set(["合同已定", "已签合同", "contracted"]);

export interface CockpitFinanceSummary {
  /** Total planned budget across the board. */
  budget: number;
  /** Sum of instalments on nodes whose execution status reads as paid. */
  paid: number;
  /** Sum of instalments on nodes with a signed contract but no payment yet. */
  contracted: number;
  /** Budget with no instalment plan behind it yet. */
  unplanned: number;
  /** Instalment count, for "N payments" chips. */
  paymentCount: number;
}

export function computeCockpitFinance(board: CockpitBoard): CockpitFinanceSummary {
  const nodeById = new Map(board.nodes.map((n) => [n.id, n]));
  let budget = 0;
  let planned = 0;
  let paid = 0;
  let contracted = 0;

  for (const node of board.nodes) {
    budget += node.budget_amount ?? 0;
  }
  for (const payment of board.payments) {
    planned += payment.amount;
    const node = nodeById.get(payment.node_id);
    if (!node) continue;
    const status = node.exec_status.trim();
    if (PAID_STATUSES.has(status) || PAID_STATUSES.has(status.toLowerCase())) {
      paid += payment.amount;
    } else if (CONTRACTED_STATUSES.has(status) || CONTRACTED_STATUSES.has(status.toLowerCase())) {
      contracted += payment.amount;
    }
  }

  return {
    budget,
    paid,
    contracted,
    unplanned: Math.max(budget - planned, 0),
    paymentCount: board.payments.length,
  };
}

export interface CockpitMonthCell {
  /** "YYYY-MM". */
  month: string;
  /** Instalments falling in this month, summed. */
  amount: number;
  /** Tasks whose planned end lands in this month. */
  dueCount: number;
  /** How many of those are done. */
  doneCount: number;
}

/**
 * The monthly bar strip: money out against work landing, month by month, over
 * the span the board actually covers. Months with neither are still emitted so
 * the strip reads as a continuous timeline rather than a gapped one.
 */
export function computeCockpitMonths(board: CockpitBoard): CockpitMonthCell[] {
  const cells = new Map<string, CockpitMonthCell>();
  const touch = (month: string): CockpitMonthCell => {
    let cell = cells.get(month);
    if (!cell) {
      cell = { month, amount: 0, dueCount: 0, doneCount: 0 };
      cells.set(month, cell);
    }
    return cell;
  };

  for (const payment of board.payments) {
    const date = parseDay(payment.pay_date);
    if (!date) continue;
    touch(monthKey(date)).amount += payment.amount;
  }
  for (const node of board.nodes) {
    const date = parseDay(node.end_date);
    if (!date) continue;
    const cell = touch(monthKey(date));
    cell.dueCount += 1;
    if (isCockpitNodeDone(node)) cell.doneCount += 1;
  }

  const months = [...cells.keys()].sort();
  if (months.length === 0) return [];

  // Fill the gaps so the strip is a timeline, not a scatter.
  const filled: CockpitMonthCell[] = [];
  const [firstYear, firstMonth] = months[0]!.split("-").map(Number);
  const [lastYear, lastMonth] = months[months.length - 1]!.split("-").map(Number);
  let cursor = new Date(Date.UTC(firstYear!, firstMonth! - 1, 1));
  const end = new Date(Date.UTC(lastYear!, lastMonth! - 1, 1));
  while (cursor <= end) {
    const key = monthKey(cursor);
    filled.push(cells.get(key) ?? { month: key, amount: 0, dueCount: 0, doneCount: 0 });
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return filled;
}

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

export function isCockpitMilestoneDone(milestone: CockpitMilestone): boolean {
  if (milestone.actual_date) return true;
  const status = milestone.status.trim();
  return DONE_STATUSES.has(status) || DONE_STATUSES.has(status.toLowerCase());
}

/** Plan order, undated milestones last so the timeline reads left to right. */
export function sortCockpitMilestones(milestones: CockpitMilestone[]): CockpitMilestone[] {
  return milestones.slice().sort((a, b) => {
    const aDate = a.plan_date ?? "9999-12-31";
    const bDate = b.plan_date ?? "9999-12-31";
    if (aDate !== bDate) return aDate.localeCompare(bDate);
    return a.position - b.position;
  });
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function groupPaymentsByNode(payments: CockpitPayment[]): Map<string, CockpitPayment[]> {
  const byNode = new Map<string, CockpitPayment[]>();
  for (const payment of payments) {
    const bucket = byNode.get(payment.node_id);
    if (bucket) bucket.push(payment);
    else byNode.set(payment.node_id, [payment]);
  }
  for (const bucket of byNode.values()) {
    bucket.sort((a, b) => a.position - b.position || (a.pay_date ?? "").localeCompare(b.pay_date ?? ""));
  }
  return byNode;
}

export function groupIssueLinksByNode(links: CockpitIssueLink[]): Map<string, CockpitIssueLink[]> {
  const byNode = new Map<string, CockpitIssueLink[]>();
  for (const link of links) {
    const bucket = byNode.get(link.node_id);
    if (bucket) bucket.push(link);
    else byNode.set(link.node_id, [link]);
  }
  for (const bucket of byNode.values()) {
    bucket.sort((a, b) => a.position - b.position || a.issue_number - b.issue_number);
  }
  return byNode;
}

// ---------------------------------------------------------------------------
// Timeline axis
// ---------------------------------------------------------------------------

export interface CockpitAxis {
  start: Date;
  end: Date;
  days: number;
}

/**
 * The span the gantt draws, padded so bars never touch the edge. Falls back to
 * a year around `today` when nothing on the board carries a date — an empty
 * board still needs an axis to draw the today line on.
 */
export function computeCockpitAxis(nodes: CockpitNode[], today: string): CockpitAxis {
  let min: string | null = null;
  let max: string | null = null;
  for (const node of nodes) {
    min = minDate(min, node.start_date);
    min = minDate(min, node.end_date);
    max = maxDate(max, node.end_date);
    max = maxDate(max, node.start_date);
  }

  const todayDate = parseDay(today) ?? new Date();
  let start = parseDay(min);
  let end = parseDay(max);
  if (!start || !end) {
    start = new Date(Date.UTC(todayDate.getUTCFullYear(), 0, 1));
    end = new Date(Date.UTC(todayDate.getUTCFullYear(), 11, 31));
  }

  // Always include today, so the marker is never off-canvas.
  if (todayDate < start) start = todayDate;
  if (todayDate > end) end = todayDate;

  // Pad to whole months on both sides.
  const paddedStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const paddedEnd = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0));
  return { start: paddedStart, end: paddedEnd, days: daysBetween(paddedStart, paddedEnd) + 1 };
}

/** The months the axis spans, each with its day offset and length. */
export function axisMonths(axis: CockpitAxis): { key: string; offset: number; days: number }[] {
  const months: { key: string; offset: number; days: number }[] = [];
  let cursor = new Date(Date.UTC(axis.start.getUTCFullYear(), axis.start.getUTCMonth(), 1));
  while (cursor <= axis.end) {
    const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    const from = cursor < axis.start ? axis.start : cursor;
    const to = next > axis.end ? addDays(axis.end, 1) : next;
    months.push({
      key: monthKey(cursor),
      offset: daysBetween(axis.start, from),
      days: Math.max(daysBetween(from, to), 0),
    });
    cursor = next;
  }
  return months;
}

// ---------------------------------------------------------------------------
// Derived narrative
// ---------------------------------------------------------------------------

export interface CockpitDigest {
  /** Tasks finished in the trailing window. */
  recentlyDone: CockpitNode[];
  /** Tasks due in the leading window and not yet done. */
  upcoming: CockpitNode[];
  /** Overdue and blocked tasks — what the programme needs help with. */
  needsSupport: CockpitNode[];
}

const BLOCKED_STATUSES = new Set(["受阻", "阻塞", "blocked"]);

/**
 * The three summary cards, derived. The board only shows an author's override
 * when they wrote one; otherwise this is the answer, and it stays right on its
 * own as the tasks move.
 */
export function computeCockpitDigest(
  nodes: CockpitNode[],
  today: string,
  options?: { trailingDays?: number; leadingDays?: number; limit?: number },
): CockpitDigest {
  const trailingDays = options?.trailingDays ?? 7;
  const leadingDays = options?.leadingDays ?? 30;
  const limit = options?.limit ?? 8;
  const todayDate = parseDay(today);
  if (!todayDate) return { recentlyDone: [], upcoming: [], needsSupport: [] };

  const from = formatDay(addDays(todayDate, -trailingDays));
  const until = formatDay(addDays(todayDate, leadingDays));

  const recentlyDone: CockpitNode[] = [];
  const upcoming: CockpitNode[] = [];
  const needsSupport: CockpitNode[] = [];

  for (const node of nodes) {
    if (isCockpitNodeCancelled(node)) continue;
    const status = node.status.trim();
    const blocked = BLOCKED_STATUSES.has(status) || BLOCKED_STATUSES.has(status.toLowerCase());
    if (blocked || isCockpitNodeLate(node, today)) {
      needsSupport.push(node);
      continue;
    }
    if (isCockpitNodeDone(node)) {
      if (node.end_date && node.end_date >= from && node.end_date <= today) recentlyDone.push(node);
      continue;
    }
    if (node.end_date && node.end_date >= today && node.end_date <= until) upcoming.push(node);
  }

  const byEnd = (a: CockpitNode, b: CockpitNode) =>
    (a.end_date ?? "").localeCompare(b.end_date ?? "");
  return {
    recentlyDone: recentlyDone.sort(byEnd).slice(0, limit),
    upcoming: upcoming.sort(byEnd).slice(0, limit),
    needsSupport: needsSupport.sort(byEnd).slice(0, limit),
  };
}
