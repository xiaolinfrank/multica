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

// ---------------------------------------------------------------------------
// Display codes
// ---------------------------------------------------------------------------

/** The module ordinal a root contributes to its subtree's codes: "L1-03" → "03". */
function rootOrdinal(code: string, index: number): string {
  const trailing = /(\d+)\s*$/.exec(code.trim());
  return trailing ? trailing[1]!.padStart(2, "0") : String(index + 1).padStart(2, "0");
}

/**
 * The row code a node is *displayed* under, which is not the code it is stored
 * under.
 *
 * Stored codes are the programme's own addresses and they carry history:
 * "AI-05-01" and "01.03" name branches of the same board, and a renumbering
 * leaves "L3-06-13" pointing at what used to be task 18. What a reader needs
 * from the leftmost column is position — which module, which branch of it,
 * which task in that branch — so the board derives a positional code from the
 * tree instead: `03` for a module, `03.01` for its first branch, `03.01.02`
 * for that branch's second task. The stored code stays reachable on hover.
 *
 * Numbering is per parent and gap-free, so it is stable for a given tree
 * regardless of how the stored codes were assigned.
 */
export function buildCockpitDisplayCodes(tree: CockpitTreeNode[]): Map<string, string> {
  const codes = new Map<string, string>();
  const walk = (entry: CockpitTreeNode, prefix: string): void => {
    entry.children.forEach((child, index) => {
      const code = `${prefix}.${String(index + 1).padStart(2, "0")}`;
      codes.set(child.node.id, code);
      walk(child, code);
    });
  };
  tree.forEach((root, index) => {
    const code = rootOrdinal(root.node.code, index);
    codes.set(root.node.id, code);
    walk(root, code);
  });
  return codes;
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

/**
 * Counts over the leaves of a subtree, with cancelled work left out.
 *
 * The gantt's branch row counts everything the branch ever held, because a
 * cancelled task still occupied the plan and its row is still on screen. The
 * overview's module card answers a different question — how much of the work
 * that is still live has landed — so cancelling a task there has to shrink the
 * denominator, otherwise a module can never reach 100%.
 */
export interface CockpitLiveCounts {
  leafCount: number;
  doneCount: number;
  activeCount: number;
  lateCount: number;
  blockedCount: number;
  /** doneCount / leafCount as a whole percent. 0 when there is nothing live. */
  doneRatio: number;
}

export interface CockpitRollup {
  /** Leaf tasks in this subtree — a branch's own row is not counted as work. */
  leafCount: number;
  doneCount: number;
  /** Leaves with work underway (in progress or under review). */
  activeCount: number;
  lateCount: number;
  /** Mean leaf progress, 0-100. A branch with no leaves reports its own progress. */
  progress: number;
  /** Summed budget over the subtree, in the board's own unit. */
  budget: number;
  /** Earliest start and latest end across the subtree, for the branch's bar. */
  start: string | null;
  end: string | null;
  /** The same counts with cancelled leaves excluded. */
  live: CockpitLiveCounts;
}

/**
 * Which statuses read as finished. The board's vocabulary is the programme's
 * own free text, so this matches on the words a Chinese-language programme
 * board actually uses plus the English equivalents, and falls back to
 * progress >= 100 for anything else.
 */
const DONE_STATUSES = new Set(["已完成", "完成", "done", "completed", "closed"]);

/** Statuses that mean work is underway — counted as "active" in rollups. */
const ACTIVE_STATUSES = new Set([
  "进行中",
  "执行中",
  "审查中",
  "评审中",
  "in progress",
  "in_progress",
  "in review",
  "in_review",
  "active",
]);

export function isCockpitNodeActive(node: CockpitNode): boolean {
  const status = node.status.trim();
  return ACTIVE_STATUSES.has(status) || ACTIVE_STATUSES.has(status.toLowerCase());
}
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

const BLOCKED_STATUSES = new Set(["受阻", "阻塞", "blocked"]);

/** Work someone has to unblock — the "needs support" card leads with these. */
export function isCockpitNodeBlocked(node: CockpitNode): boolean {
  const status = node.status.trim();
  return BLOCKED_STATUSES.has(status) || BLOCKED_STATUSES.has(status.toLowerCase());
}

/** Parked on purpose: the row is neither late nor drifting while it waits. */
const WAITING_STATUSES = new Set(["等待期", "等待中", "waiting", "on hold", "on_hold"]);

export function isCockpitNodeWaiting(node: CockpitNode): boolean {
  const status = node.status.trim();
  return WAITING_STATUSES.has(status) || WAITING_STATUSES.has(status.toLowerCase());
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

/**
 * The prototype's field-integrity check: which of the core fields a task
 * should carry but doesn't. `progress` is not among them — the column is
 * never empty, and 0% is a real value ("not started"), not a missing one.
 * The UI maps these keys to its own labels.
 */
export const COCKPIT_CORE_CHECK_FIELDS = [
  "name",
  "owner",
  "start_date",
  "end_date",
  "status",
] as const;

export type CockpitCheckField = (typeof COCKPIT_CORE_CHECK_FIELDS)[number];

export function cockpitMissingFields(node: CockpitNode): CockpitCheckField[] {
  return COCKPIT_CORE_CHECK_FIELDS.filter((field) => {
    const value = node[field];
    return value == null || String(value).trim() === "";
  });
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
      activeCount: 0,
      lateCount: 0,
      progress: node.progress,
      // Budget lives on the tasks that spend it. A branch that also carries a
      // figure would otherwise be counted twice — once as its own line and
      // once through the children it summarises.
      budget: children.length === 0 ? (node.budget_amount ?? 0) : 0,
      start: node.start_date,
      end: node.end_date,
      live: {
        leafCount: 0,
        doneCount: 0,
        activeCount: 0,
        lateCount: 0,
        blockedCount: 0,
        doneRatio: 0,
      },
    };

    if (children.length === 0) {
      own.leafCount = 1;
      own.doneCount = isCockpitNodeDone(node) ? 1 : 0;
      own.activeCount = isCockpitNodeActive(node) ? 1 : 0;
      own.lateCount = isCockpitNodeLate(node, today) ? 1 : 0;
      if (!isCockpitNodeCancelled(node)) {
        own.live.leafCount = 1;
        own.live.doneCount = own.doneCount;
        own.live.activeCount = own.activeCount;
        own.live.lateCount = own.lateCount;
        own.live.blockedCount = isCockpitNodeBlocked(node) ? 1 : 0;
        own.live.doneRatio = own.live.doneCount * 100;
      }
      rollups.set(node.id, own);
      return own;
    }

    let progressSum = 0;
    for (const child of children) {
      const childRollup = visit(child);
      own.leafCount += childRollup.leafCount;
      own.doneCount += childRollup.doneCount;
      own.activeCount += childRollup.activeCount;
      own.lateCount += childRollup.lateCount;
      own.budget += childRollup.budget;
      own.start = minDate(own.start, childRollup.start);
      own.end = maxDate(own.end, childRollup.end);
      progressSum += childRollup.progress * childRollup.leafCount;
      own.live.leafCount += childRollup.live.leafCount;
      own.live.doneCount += childRollup.live.doneCount;
      own.live.activeCount += childRollup.live.activeCount;
      own.live.lateCount += childRollup.live.lateCount;
      own.live.blockedCount += childRollup.live.blockedCount;
    }
    // Weighted by leaf count, so a branch with 40 tasks does not weigh the same
    // as its sibling with 2.
    own.progress = own.leafCount > 0 ? progressSum / own.leafCount : node.progress;
    own.live.doneRatio =
      own.live.leafCount > 0 ? Math.round((own.live.doneCount * 100) / own.live.leafCount) : 0;
    rollups.set(node.id, own);
    return own;
  };

  tree.forEach(visit);
  return rollups;
}

/**
 * The two rows a module's big card quotes next to its numbers: the most
 * recently finished leaf that produced a deliverable ("latest result") and the
 * nearest leaf still ahead of the module ("next key node"). A module with no
 * dated leaves reports nulls, not guesses.
 */
export interface CockpitModuleHighlights {
  recent: CockpitNode | null;
  next: CockpitNode | null;
}

export function cockpitModuleHighlights(
  entry: CockpitTreeNode,
  today: string,
): CockpitModuleHighlights {
  let recent: CockpitNode | null = null;
  let next: CockpitNode | null = null;

  const endKey = (node: CockpitNode): string => node.end_date ?? "";

  const visit = (current: CockpitTreeNode): void => {
    if (current.children.length === 0) {
      const { node } = current;
      if (!node.end_date || isCockpitNodeCancelled(node)) return;
      if (isCockpitNodeDone(node)) {
        // A result is something the module can point at, so a finished task
        // with nothing to show for it is not the module's latest result.
        if (!node.deliverable.trim()) return;
        if (
          !recent ||
          endKey(node) > endKey(recent) ||
          (endKey(node) === endKey(recent) && node.code < recent.code)
        ) {
          recent = node;
        }
        return;
      }
      // Overdue work is already called out by the module's own late count;
      // "next" is the next thing the module has to hit, not the last thing
      // it missed.
      if (node.end_date < today) return;
      if (
        !next ||
        endKey(node) < endKey(next) ||
        (endKey(node) === endKey(next) && node.code < next.code)
      ) {
        next = node;
      }
      return;
    }
    current.children.forEach(visit);
  };
  visit(entry);

  return { recent, next };
}

// ---------------------------------------------------------------------------
// Finance
// ---------------------------------------------------------------------------

/** Execution statuses that mean money actually left. */
const PAID_STATUSES = new Set(["完全支付", "已支付", "paid"]);
const CONTRACTED_STATUSES = new Set(["合同已定", "已签合同", "contracted"]);
const PLANNING_STATUSES = new Set(["规划中", "planning", "planned"]);

/**
 * How far along a spend line is. The marker on the timeline reads by this, so
 * "money already out the door" and "money we still have to find" are not the
 * same dot.
 */
export type CockpitPaymentTone = "paid" | "contract" | "planning" | "pending";

export function cockpitPaymentTone(execStatus: string): CockpitPaymentTone {
  const key = execStatus.trim();
  const lower = key.toLowerCase();
  if (PAID_STATUSES.has(key) || PAID_STATUSES.has(lower)) return "paid";
  if (CONTRACTED_STATUSES.has(key) || CONTRACTED_STATUSES.has(lower)) return "contract";
  if (PLANNING_STATUSES.has(key) || PLANNING_STATUSES.has(lower)) return "planning";
  return "pending";
}

const PAYMENT_TONE_COLORS: Record<CockpitPaymentTone, string> = {
  paid: "var(--success)",
  contract: "var(--info)",
  planning: "var(--warning)",
  pending: "var(--brand)",
};

export function cockpitPaymentToneColor(tone: CockpitPaymentTone): string {
  return PAYMENT_TONE_COLORS[tone];
}

const PAYMENT_TONE_RANK: Record<CockpitPaymentTone, number> = {
  paid: 3,
  contract: 2,
  planning: 1,
  pending: 0,
};

/** One module's line in the spend roll-up table. */
export interface CockpitFinanceModule {
  code: string;
  name: string;
  color: string;
  /** Spend lines rolling up to this module. */
  lineCount: number;
  planned: number;
  actual: number;
}

export interface CockpitFinanceSummary {
  /** Approved budget: what the tasks that spend money are allowed to spend. */
  budget: number;
  /** Planned spend — the ledger's expected cost, summed. */
  planned: number;
  /** Actual spend: the budget of every line that reads as fully paid. */
  actual: number;
  /** planned − actual, floored at zero: what is still expected to go out. */
  outstanding: number;
  /** Spend lines, and how many of them have actually paid out. */
  lineCount: number;
  paidLineCount: number;
  /** Sum of instalments on nodes with a signed contract but no payment yet. */
  contracted: number;
  /** Instalment count, for "N payments" chips. */
  paymentCount: number;
  /** The roll-up table under the four figures, in module order. */
  byModule: CockpitFinanceModule[];
}

/**
 * The four figures at the head of the finance section, and the table under it.
 *
 * `budget` and `actual` are deliberately not derived from the instalments:
 * a task that is fully paid has spent its budget whether or not someone
 * itemised the transfers, and a task with instalments booked has not spent
 * anything until its execution status says so. Instalments answer *when* the
 * money moves, which is what the month strip and the timeline markers read.
 */
export function computeCockpitFinance(board: CockpitBoard): CockpitFinanceSummary {
  const nodeById = new Map(board.nodes.map((n) => [n.id, n]));
  const tree = buildCockpitTree(board.nodes);
  const rows = computeCockpitFinanceRows(tree, board.payments);
  const rootByCode = new Map(tree.map((root) => [root.node.code, root]));

  let budget = 0;
  let planned = 0;
  let actual = 0;
  let paidLineCount = 0;
  const byModule = new Map<string, CockpitFinanceModule>();

  for (const row of rows) {
    budget += row.budget;
    planned += row.budget;
    if (row.actualAmount != null && row.actualAmount > 0) {
      actual += row.actualAmount;
      paidLineCount += 1;
    }
    let module = byModule.get(row.rootCode);
    if (!module) {
      const root = rootByCode.get(row.rootCode);
      module = {
        code: row.rootCode,
        name: root?.node.name ?? row.rootCode,
        color: row.rootColor,
        lineCount: 0,
        planned: 0,
        actual: 0,
      };
      byModule.set(row.rootCode, module);
    }
    module.lineCount += 1;
    module.planned += row.budget;
    module.actual += row.actualAmount ?? 0;
  }

  let contracted = 0;
  for (const payment of board.payments) {
    const node = nodeById.get(payment.node_id);
    if (!node) continue;
    const status = node.exec_status.trim();
    if (CONTRACTED_STATUSES.has(status) || CONTRACTED_STATUSES.has(status.toLowerCase())) {
      contracted += payment.amount;
    }
  }

  return {
    budget,
    planned,
    actual,
    outstanding: Math.max(planned - actual, 0),
    lineCount: rows.length,
    paidLineCount,
    contracted,
    paymentCount: board.payments.length,
    byModule: [...byModule.values()].sort((a, b) => a.code.localeCompare(b.code)),
  };
}

export interface CockpitMonthModuleShare {
  /** Root module code, e.g. "L1-03". */
  code: string;
  /** The colour the root module paints with. */
  color: string;
  amount: number;
}

export interface CockpitMonthCell {
  /** "YYYY-MM". */
  month: string;
  /** Instalments falling in this month, summed. */
  amount: number;
  /** The same instalments split by root module, for the stacked column. */
  byModule: CockpitMonthModuleShare[];
  /** Instalments in this month on nodes whose execution status reads as paid. */
  paidAmount: number;
  /**
   * The spend ledger's own view of this month, which is a different question
   * from the instalments above: instalments say when money moves, these say
   * what the month's spend lines are worth.
   *
   * `plannedSpend` is every line expected to land here. `actualSpend` is the
   * part of it that has actually paid out, and `projectedSpend` the part that
   * has not — together they make the second bar, drawn paid-then-projected.
   */
  plannedSpend: number;
  actualSpend: number;
  projectedSpend: number;
  /** Lines behind `actualSpend`, for the marker's tooltip. */
  actualCount: number;
  /** Leaves with work underway whose plan window covers this month. */
  activeCount: number;
  /** Leaf tasks whose planned end lands in this month. */
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
      cell = {
        month,
        amount: 0,
        byModule: [],
        paidAmount: 0,
        plannedSpend: 0,
        actualSpend: 0,
        projectedSpend: 0,
        actualCount: 0,
        activeCount: 0,
        dueCount: 0,
        doneCount: 0,
      };
      cells.set(month, cell);
    }
    return cell;
  };

  // Instalments stack by root module colour, so map each node to its root
  // and the colour that subtree paints with.
  const nodeById = new Map(board.nodes.map((n) => [n.id, n]));
  const rootOf = (id: string): CockpitNode | undefined => {
    let current = nodeById.get(id);
    while (current?.parent_id) current = nodeById.get(current.parent_id);
    return current;
  };
  const colorOf = new Map<string, string>();
  const leaves: CockpitNode[] = [];
  const walk = (entry: CockpitTreeNode): void => {
    colorOf.set(entry.node.id, entry.color);
    if (entry.children.length === 0) leaves.push(entry.node);
    entry.children.forEach(walk);
  };
  const tree = buildCockpitTree(board.nodes);
  tree.forEach(walk);

  for (const row of computeCockpitFinanceRows(tree, board.payments)) {
    const plannedMonth = row.plannedDate?.slice(0, 7);
    const actualMonth = row.actualDate?.slice(0, 7);
    if (row.actualAmount != null && row.actualAmount > 0 && actualMonth) {
      const cell = touch(actualMonth);
      cell.actualSpend += row.actualAmount;
      cell.actualCount += 1;
    } else if (plannedMonth) {
      touch(plannedMonth).projectedSpend += row.budget;
    }
    if (plannedMonth && row.budget > 0) touch(plannedMonth).plannedSpend += row.budget;
  }

  for (const payment of board.payments) {
    const date = parseDay(payment.pay_date);
    if (!date) continue;
    const cell = touch(monthKey(date));
    cell.amount += payment.amount;
    const payer = nodeById.get(payment.node_id);
    if (payer && PAID_STATUSES.has(payer.exec_status.trim())) cell.paidAmount += payment.amount;
    const root = payment.node_id ? rootOf(payment.node_id) : undefined;
    if (root) {
      const code = root.code;
      const share = cell.byModule.find((s) => s.code === code);
      if (share) share.amount += payment.amount;
      else cell.byModule.push({ code, color: colorOf.get(root.id) || "", amount: payment.amount });
    }
  }
  // Only real work counts as "due": a branch row is a heading, and a cancelled
  // or parked task is not something the month is expected to land.
  for (const leaf of leaves) {
    if (isCockpitNodeCancelled(leaf) || isCockpitNodeWaiting(leaf)) continue;
    const date = parseDay(leaf.end_date);
    if (!date) continue;
    const cell = touch(monthKey(date));
    cell.dueCount += 1;
    if (isCockpitNodeDone(leaf)) cell.doneCount += 1;
  }
  for (const cell of cells.values()) {
    cell.byModule.sort((a, b) => b.amount - a.amount || a.code.localeCompare(b.code));
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
    filled.push(
      cells.get(key) ?? {
        month: key,
        amount: 0,
        byModule: [],
        paidAmount: 0,
        plannedSpend: 0,
        actualSpend: 0,
        projectedSpend: 0,
        actualCount: 0,
        activeCount: 0,
        dueCount: 0,
        doneCount: 0,
      },
    );
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }

  // "Work underway this month": an active leaf whose plan window covers the
  // month, like the prototype's doing count. Counted over the filled strip so a
  // month with no money and no deadline still reports what is running through
  // it. Month keys compare lexicographically.
  for (const leaf of leaves) {
    if (!isCockpitNodeActive(leaf)) continue;
    const start = leaf.start_date?.slice(0, 7);
    const end = leaf.end_date?.slice(0, 7);
    if (!start || !end) continue;
    for (const cell of filled) {
      if (cell.month >= start && cell.month <= end) cell.activeCount += 1;
    }
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

export interface CockpitAxisOptions {
  /**
   * At week density the axis starts on the Monday of the earliest execution
   * task instead of the month boundary. A month of empty ruler is cheap at
   * 3.5px a day and expensive at 9.
   */
  zoom?: "month" | "week";
}

/** Monday of the week the earliest leaf task starts in, or null. */
function execWeekStart(nodes: CockpitNode[]): Date | null {
  const parents = new Set<string>();
  for (const node of nodes) if (node.parent_id) parents.add(node.parent_id);
  let earliest: string | null = null;
  for (const node of nodes) {
    if (parents.has(node.id)) continue;
    earliest = minDate(earliest, node.start_date);
    earliest = minDate(earliest, node.end_date);
  }
  const date = parseDay(earliest);
  if (!date) return null;
  // getUTCDay() is 0 on Sunday; shift so Monday is the week start.
  return addDays(date, -((date.getUTCDay() + 6) % 7));
}

/**
 * The span the gantt draws, padded so bars never touch the edge. Falls back to
 * a year around `today` when nothing on the board carries a date — an empty
 * board still needs an axis to draw the today line on.
 */
export function computeCockpitAxis(
  nodes: CockpitNode[],
  today: string,
  options: CockpitAxisOptions = {},
): CockpitAxis {
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
  let paddedStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const paddedEnd = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0));

  if (options.zoom === "week") {
    const monday = execWeekStart(nodes);
    // Never past today: the marker has to stay on the canvas.
    if (monday && monday > paddedStart && monday <= todayDate) paddedStart = monday;
  }

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

export type CockpitDigestKind = "task" | "milestone" | "payment";

/** One line of a narrative card. */
export interface CockpitDigestItem {
  kind: CockpitDigestKind;
  /** Stable key, unique inside its section. */
  key: string;
  /** The task behind the line, when there is one — the line links to it. */
  node: CockpitNode | null;
  /** The date badge, ISO. null when the line does not carry one. */
  date: string | null;
  title: string;
  /** Root module, for the trailing module tag. Empty when the line has none. */
  rootCode: string;
  /** Trailing percent badge. null when the line does not carry one. */
  progress: number | null;
  /** Trailing money badge, in the board's own unit. null when it has none. */
  amount: number | null;
}

/** What the trailing window actually moved. */
export interface CockpitDigestOverall {
  /** Window bounds, inclusive, ISO. */
  from: string;
  to: string;
  doneCount: number;
  activeCount: number;
  /** Milestones that landed in the window. */
  milestoneCount: number;
  paidAmount: number;
  paidCount: number;
  items: CockpitDigestItem[];
  /** Tasks in the window before the top-N cut, so the card can say "…and N more". */
  totalCount: number;
}

/** What the leading window is about to ask for. */
export interface CockpitDigestNext {
  from: string;
  to: string;
  dueCount: number;
  milestoneCount: number;
  plannedAmount: number;
  plannedCount: number;
  items: CockpitDigestItem[];
  totalCount: number;
}

/** What is stuck. */
export interface CockpitDigestSupport {
  blockedCount: number;
  overdueCount: number;
  items: CockpitDigestItem[];
  totalCount: number;
}

export interface CockpitDigest {
  overall: CockpitDigestOverall;
  next: CockpitDigestNext;
  support: CockpitDigestSupport;
}

const DIGEST_LIMIT = 5;

/**
 * The three narrative cards, derived.
 *
 * Each card answers a different question over a different window, so they use
 * deliberately different rules rather than one shared filter: "current
 * progress" leads with what is running and pads with what just finished, the
 * fortnight ahead interleaves deadlines, milestones and money into one dated
 * list, and "needs support" is blocked work first, then in-flight work that is
 * already past its date. Only leaves take part — a branch row is a heading,
 * not a thing anyone does.
 *
 * The board shows an author's override when they wrote one; otherwise this is
 * the answer, and it stays right on its own as the tasks move.
 */
export function computeCockpitDigest(
  board: CockpitBoard,
  today: string,
  options?: { trailingDays?: number; leadingDays?: number; limit?: number },
): CockpitDigest {
  const trailingDays = options?.trailingDays ?? 7;
  const leadingDays = options?.leadingDays ?? 14;
  const limit = options?.limit ?? DIGEST_LIMIT;

  const todayDate = parseDay(today);
  const empty: CockpitDigest = {
    overall: {
      from: today,
      to: today,
      doneCount: 0,
      activeCount: 0,
      milestoneCount: 0,
      paidAmount: 0,
      paidCount: 0,
      items: [],
      totalCount: 0,
    },
    next: {
      from: today,
      to: today,
      dueCount: 0,
      milestoneCount: 0,
      plannedAmount: 0,
      plannedCount: 0,
      items: [],
      totalCount: 0,
    },
    support: { blockedCount: 0, overdueCount: 0, items: [], totalCount: 0 },
  };
  if (!todayDate) return empty;

  // Windows are inclusive and include today at both ends: the trailing one is
  // the last seven days *counting today*, the leading one the next fortnight
  // *starting today*.
  const pastFrom = formatDay(addDays(todayDate, -(trailingDays - 1)));
  const aheadTo = formatDay(addDays(todayDate, leadingDays - 1));
  const inPast = (date: string | null | undefined): boolean =>
    !!date && date >= pastFrom && date <= today;
  const inAhead = (date: string | null | undefined): boolean =>
    !!date && date >= today && date <= aheadTo;

  const tree = buildCockpitTree(board.nodes);
  const rootCodeOf = new Map<string, string>();
  const leaves: CockpitNode[] = [];
  const walk = (entry: CockpitTreeNode, rootCode: string): void => {
    rootCodeOf.set(entry.node.id, rootCode);
    if (entry.children.length === 0) leaves.push(entry.node);
    entry.children.forEach((child) => walk(child, rootCode));
  };
  tree.forEach((root) => walk(root, root.node.code));
  const rootOf = (node: CockpitNode): string => rootCodeOf.get(node.id) ?? "";

  const taskItem = (
    node: CockpitNode,
    opts: { date?: string | null; progress?: number | null; rootCode?: boolean },
  ): CockpitDigestItem => ({
    kind: "task",
    key: node.id,
    node,
    date: opts.date ?? null,
    title: node.name,
    rootCode: opts.rootCode === false ? "" : rootOf(node),
    progress: opts.progress ?? null,
    amount: null,
  });

  // --- current progress ----------------------------------------------------
  const done: CockpitNode[] = [];
  const active: CockpitNode[] = [];
  for (const leaf of leaves) {
    if (isCockpitNodeDone(leaf)) {
      if (inPast(leaf.end_date)) done.push(leaf);
      continue;
    }
    if (!isCockpitNodeActive(leaf)) continue;
    if (leaf.start_date && leaf.end_date && leaf.start_date <= today && leaf.end_date >= pastFrom) {
      active.push(leaf);
    }
  }
  active.sort((a, b) => b.progress - a.progress || a.name.localeCompare(b.name));
  done.sort((a, b) => (b.end_date ?? "").localeCompare(a.end_date ?? ""));

  const financeRows = computeCockpitFinanceRows(tree, board.payments);
  let paidAmount = 0;
  let paidCount = 0;
  for (const row of financeRows) {
    if (row.actualAmount != null && row.actualAmount > 0 && inPast(row.actualDate)) {
      paidAmount += row.actualAmount;
      paidCount += 1;
    }
  }

  // Running work first — that is what "where are we" means — and only pad with
  // finished work when there is not enough of it to fill the card.
  const core = active.slice(0, limit);
  if (core.length < limit) core.push(...done.slice(0, limit - core.length));

  const overall: CockpitDigestOverall = {
    from: pastFrom,
    to: today,
    doneCount: done.length,
    activeCount: active.length,
    milestoneCount: board.milestones.filter((m) => inPast(m.actual_date)).length,
    paidAmount,
    paidCount,
    items: core.map((node) => taskItem(node, { progress: node.progress, rootCode: false })),
    totalCount: active.length + done.length,
  };

  // --- the fortnight ahead -------------------------------------------------
  const ahead: CockpitDigestItem[] = [];
  let dueCount = 0;
  for (const leaf of leaves) {
    if (isCockpitNodeDone(leaf) || isCockpitNodeCancelled(leaf)) continue;
    if (!inAhead(leaf.end_date)) continue;
    dueCount += 1;
    ahead.push(taskItem(leaf, { date: leaf.end_date }));
  }
  const aheadMilestones = board.milestones.filter((m) => !m.actual_date && inAhead(m.plan_date));
  for (const milestone of aheadMilestones) {
    ahead.push({
      kind: "milestone",
      key: `ms:${milestone.id}`,
      node: null,
      date: milestone.plan_date,
      title: milestone.name,
      rootCode: "",
      progress: null,
      amount: null,
    });
  }
  let plannedAmount = 0;
  let plannedCount = 0;
  for (const row of financeRows) {
    if (row.budget <= 0 || !inAhead(row.plannedDate)) continue;
    plannedAmount += row.budget;
    plannedCount += 1;
    ahead.push({
      kind: "payment",
      key: `pay:${row.node.id}`,
      node: row.node,
      date: row.plannedDate,
      title: row.node.name,
      rootCode: "",
      progress: null,
      amount: row.budget,
    });
  }
  ahead.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.title.localeCompare(b.title));

  const next: CockpitDigestNext = {
    from: today,
    to: aheadTo,
    dueCount,
    milestoneCount: aheadMilestones.length,
    plannedAmount,
    plannedCount,
    items: ahead.slice(0, limit),
    totalCount: ahead.length,
  };

  // --- needs support -------------------------------------------------------
  const blocked: CockpitNode[] = [];
  const overdue: CockpitNode[] = [];
  for (const leaf of leaves) {
    if (isCockpitNodeCancelled(leaf) || isCockpitNodeDone(leaf) || isCockpitNodeWaiting(leaf)) {
      continue;
    }
    if (isCockpitNodeBlocked(leaf)) {
      blocked.push(leaf);
      continue;
    }
    if (isCockpitNodeActive(leaf) && isCockpitNodeLate(leaf, today)) overdue.push(leaf);
  }
  const support: CockpitDigestSupport = {
    blockedCount: blocked.length,
    overdueCount: overdue.length,
    items: [...blocked, ...overdue].slice(0, limit).map((node) => taskItem(node, {})),
    totalCount: blocked.length + overdue.length,
  };

  return { overall, next, support };
}

// ---------------------------------------------------------------------------
// Status colour
// ---------------------------------------------------------------------------

/**
 * The colour a bar paints in, by status.
 *
 * A gantt is read status-first: the question at a glance is "what is on fire",
 * not "which module is this". The module is already carried by the coloured
 * code in the tree pane, so the bar itself is free to carry the status.
 *
 * Values are token references rather than hex, so the chart follows the theme.
 * A status nobody here knows keeps the neutral colour instead of vanishing.
 */
const STATUS_COLOR_VARS = new Map<string, string>([
  ["进行中", "var(--brand)"],
  ["执行中", "var(--brand)"],
  ["in progress", "var(--brand)"],
  ["in_progress", "var(--brand)"],
  ["已完成", "var(--success)"],
  ["完成", "var(--success)"],
  ["done", "var(--success)"],
  ["completed", "var(--success)"],
  // Review and waiting do not get hues of their own: on a 187-row chart a
  // fourth and fifth blue-adjacent colour is noise, and both answer the same
  // question as "in progress" — the work is open. The table keeps the
  // distinction, where there is room to read it.
  ["审查中", "var(--brand)"],
  ["评审中", "var(--brand)"],
  ["review", "var(--brand)"],
  ["受阻", "var(--destructive)"],
  ["阻塞", "var(--destructive)"],
  ["blocked", "var(--destructive)"],
  ["等待期", "var(--brand)"],
  ["等待中", "var(--brand)"],
  ["waiting", "var(--brand)"],
  ["待开始", "var(--faint-foreground)"],
  ["未开始", "var(--faint-foreground)"],
  ["not started", "var(--faint-foreground)"],
  ["已取消", "var(--muted-foreground)"],
  ["取消", "var(--muted-foreground)"],
  ["cancelled", "var(--muted-foreground)"],
]);

export const COCKPIT_STATUS_NEUTRAL = "var(--faint-foreground)";

export function cockpitStatusColor(status: string): string {
  const key = status.trim();
  return (
    STATUS_COLOR_VARS.get(key) ??
    STATUS_COLOR_VARS.get(key.toLowerCase()) ??
    COCKPIT_STATUS_NEUTRAL
  );
}

/**
 * The legend the gantt prints, in the order a reader scans it.
 *
 * Keys, not status words: the board's own vocabulary is Chinese free text, but
 * the legend is chrome and has to speak the reader's language. Review and
 * waiting are folded into "in progress" because the bars fold them too.
 */
export type CockpitStatusLegendKey =
  | "progress"
  | "done"
  | "blocked"
  | "todo"
  | "cancelled";

export const COCKPIT_STATUS_LEGEND: { key: CockpitStatusLegendKey; color: string }[] = [
  { key: "progress", color: "var(--brand)" },
  { key: "done", color: "var(--success)" },
  { key: "blocked", color: "var(--destructive)" },
  { key: "todo", color: "var(--faint-foreground)" },
  { key: "cancelled", color: "var(--muted-foreground)" },
];

/**
 * The progress a row reads as when nobody typed one.
 *
 * A task at 0% is ambiguous: it can mean "not started" or "nobody filled the
 * field in". Rolling a goal forecast off the raw number therefore understates
 * every module whose owners track status but not percentages, so an untyped
 * row falls back to what its status already says.
 */
export function cockpitEffectiveProgress(node: CockpitNode): number {
  if (node.progress > 0) return Math.min(node.progress, 100);
  if (isCockpitNodeDone(node)) return 100;
  if (isCockpitNodeActive(node) || isCockpitNodeWaiting(node)) return 50;
  if (isCockpitNodeBlocked(node)) return 25;
  return 0;
}

/**
 * The colour a branch's summary bar takes: the worst thing under it.
 *
 * A roll-up has no status of its own, but it does have an answer to "is
 * anything here on fire" — and on a collapsed board that bar is the only thing
 * on screen for a whole module. Cancelled leaves are excluded: they no longer
 * occupy the plan.
 */
export function cockpitAggStatusColor(entry: CockpitTreeNode): string {
  let leaves = 0;
  let done = 0;
  let blocked = false;
  let active = false;
  const walk = (node: CockpitTreeNode) => {
    if (node.children.length > 0) {
      node.children.forEach(walk);
      return;
    }
    if (isCockpitNodeCancelled(node.node)) return;
    leaves += 1;
    if (isCockpitNodeBlocked(node.node)) blocked = true;
    else if (isCockpitNodeActive(node.node) || isCockpitNodeWaiting(node.node)) active = true;
    if (isCockpitNodeDone(node.node)) done += 1;
  };
  walk(entry);
  if (leaves === 0) return "var(--muted-foreground)";
  if (blocked) return "var(--destructive)";
  if (active) return "var(--brand)";
  if (done === leaves) return "var(--success)";
  return "var(--faint-foreground)";
}

// ---------------------------------------------------------------------------
// Core nodes: the handful of dates on a branch worth a marker
// ---------------------------------------------------------------------------

/**
 * What a marker on a roll-up row says happened, or is about to.
 *
 * The annual objective is not among these: the chart already draws it as a
 * full-height line, so repeating it per row would be the same fact twice.
 */
export type CockpitCoreNodeKind = "done" | "blocked" | "upcoming";

export interface CockpitCoreNodeGroup {
  date: string;
  kind: CockpitCoreNodeKind;
  nodes: CockpitNode[];
}

/** How far ahead an in-flight task counts as "coming up". */
const CORE_HORIZON_DAYS = 30;
/** Below this, an in-flight task is not yet far enough along to headline. */
const CORE_PROGRESS_FLOOR = 40;

/**
 * The dates under a branch a reader should notice, bucketed by day and kind.
 *
 * A collapsed module is one bar and no detail. These markers put the shape of
 * what is inside it back on the timeline — what landed, what is stuck, and
 * what is about to need attention — without expanding a hundred rows.
 */
export function cockpitCoreNodes(
  entry: CockpitTreeNode,
  today: string,
): CockpitCoreNodeGroup[] {
  const todayDate = parseDay(today);
  const horizon = todayDate ? formatDay(addDays(todayDate, CORE_HORIZON_DAYS)) : null;
  const buckets = new Map<string, CockpitCoreNodeGroup>();
  const push = (kind: CockpitCoreNodeKind, date: string, node: CockpitNode) => {
    const key = `${kind}:${date}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.nodes.push(node);
    else buckets.set(key, { date, kind, nodes: [node] });
  };

  const walk = (branch: CockpitTreeNode) => {
    if (branch.children.length > 0) {
      branch.children.forEach(walk);
      return;
    }
    const node = branch.node;
    if (isCockpitNodeCancelled(node)) return;
    const date = node.end_date;
    if (!date) return;
    if (isCockpitNodeDone(node)) {
      push("done", date, node);
      return;
    }
    if (isCockpitNodeBlocked(node)) {
      push("blocked", date, node);
      return;
    }
    if (!isCockpitNodeActive(node)) return;
    const soon = horizon != null && date >= today && date <= horizon;
    if (cockpitEffectiveProgress(node) >= CORE_PROGRESS_FLOOR || soon) {
      push("upcoming", date, node);
    }
  };
  walk(entry);

  return [...buckets.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind),
  );
}

// ---------------------------------------------------------------------------
// Progress against the annual objective
// ---------------------------------------------------------------------------

/** Where a leaf should be today if it were running exactly to plan, 0-100. */
function scheduledProgress(node: CockpitNode, today: string): number | null {
  const start = parseDay(node.start_date);
  const end = parseDay(node.end_date);
  const now = parseDay(today);
  if (!start || !end || !now || end <= start) return null;
  const span = end.getTime() - start.getTime();
  const elapsed = now.getTime() - start.getTime();
  return Math.max(0, Math.min(1, elapsed / span)) * 100;
}

export interface CockpitGoalProgress {
  /** Mean effective progress of the in-year leaves, 0-100. */
  actual: number | null;
  /** Where those leaves should be today on their own dates, 0-100. */
  scheduled: number | null;
  /** scheduled − actual: positive means behind plan. */
  gapPts: number | null;
  /** Latest planned end among the in-year leaves. */
  latestEnd: string | null;
  /** latestEnd − goalDate in days: positive means the plan overruns the goal. */
  planVsGoalDays: number | null;
  /** In-year leaves the figures are built from. */
  taskCount: number;
  /** Leaves ending after the goal date — excluded from every figure above. */
  crossYearCount: number;
  behind: boolean;
}

/**
 * How a module is tracking against the board's annual objective.
 *
 * Only work that is supposed to land this year counts: a task ending in 2028
 * would otherwise drag every module's number down for no reason anyone can
 * act on, so it is reported separately instead.
 */
export function cockpitGoalProgress(
  entry: CockpitTreeNode,
  today: string,
  goalDate: string | null,
): CockpitGoalProgress {
  const inYear: CockpitNode[] = [];
  let crossYearCount = 0;
  const walk = (branch: CockpitTreeNode) => {
    if (branch.children.length > 0) {
      branch.children.forEach(walk);
      return;
    }
    const node = branch.node;
    if (isCockpitNodeCancelled(node)) return;
    if (goalDate && node.end_date && node.end_date > goalDate) {
      crossYearCount += 1;
      return;
    }
    inYear.push(node);
  };
  walk(entry);

  const empty: CockpitGoalProgress = {
    actual: null,
    scheduled: null,
    gapPts: null,
    latestEnd: null,
    planVsGoalDays: null,
    taskCount: 0,
    crossYearCount,
    behind: false,
  };
  if (inYear.length === 0) return empty;

  const actual = Math.round(
    inYear.reduce((sum, node) => sum + cockpitEffectiveProgress(node), 0) / inYear.length,
  );

  let schedSum = 0;
  let schedCount = 0;
  for (const node of inYear) {
    const value = scheduledProgress(node, today);
    if (value == null) continue;
    schedSum += value;
    schedCount += 1;
  }
  const scheduled = schedCount > 0 ? Math.round(schedSum / schedCount) : null;

  let latestEnd: string | null = null;
  for (const node of inYear) latestEnd = maxDate(latestEnd, node.end_date);

  const goal = parseDay(goalDate);
  const latest = parseDay(latestEnd);
  const planVsGoalDays = goal && latest ? daysBetween(goal, latest) : null;

  return {
    actual,
    scheduled,
    gapPts: scheduled == null ? null : scheduled - actual,
    latestEnd,
    planVsGoalDays,
    taskCount: inYear.length,
    crossYearCount,
    behind: scheduled != null && actual < scheduled,
  };
}

export interface CockpitOverallProgress {
  /** Every live leaf, cross-year work included. */
  overall: number | null;
  /** Leaves due on or before the goal date. */
  thisYear: number | null;
  /** Where those in-year leaves should be today. */
  scheduled: number | null;
  behind: boolean;
}

/**
 * The two figures the toolbar carries: how far the whole programme has come,
 * and how far the part of it that is due this year has come.
 *
 * Both are means over leaves, because a branch is not work — counting it would
 * weight a module by how finely it happens to be broken down.
 */
export function cockpitOverallProgress(
  nodes: CockpitNode[],
  today: string,
  goalDate: string | null,
): CockpitOverallProgress {
  const parents = new Set<string>();
  for (const node of nodes) if (node.parent_id) parents.add(node.parent_id);

  let allSum = 0;
  let allCount = 0;
  let yearSum = 0;
  let yearCount = 0;
  let schedSum = 0;
  let schedCount = 0;

  for (const node of nodes) {
    if (parents.has(node.id)) continue;
    if (isCockpitNodeCancelled(node)) continue;
    const progress = cockpitEffectiveProgress(node);
    allSum += progress;
    allCount += 1;
    if (goalDate && node.end_date && node.end_date > goalDate) continue;
    yearSum += progress;
    yearCount += 1;
    const value = scheduledProgress(node, today);
    if (value == null) continue;
    schedSum += value;
    schedCount += 1;
  }

  const thisYear = yearCount > 0 ? Math.round(yearSum / yearCount) : null;
  const scheduled = schedCount > 0 ? Math.round(schedSum / schedCount) : null;
  return {
    overall: allCount > 0 ? Math.round(allSum / allCount) : null,
    thisYear,
    scheduled,
    behind: thisYear != null && scheduled != null && thisYear < scheduled,
  };
}

// ---------------------------------------------------------------------------
// Milestone colour
// ---------------------------------------------------------------------------

/**
 * Milestone statuses answer a different question from task statuses — not "how
 * is it going" but "how much attention does this one need" — so they get their
 * own scale. Token references, like the task scale, so both follow the theme.
 */
const MILESTONE_STATUS_COLOR_VARS = new Map<string, string>([
  ["已完成", "var(--success)"],
  ["完成", "var(--success)"],
  ["done", "var(--success)"],
  ["重点保障", "var(--destructive)"],
  ["按计划推进", "var(--warning)"],
  ["前置准备", "var(--muted-foreground)"],
  ["按计划后置", "var(--faint-foreground)"],
  ["待确认", "var(--faint-foreground)"],
]);

export function cockpitMilestoneStatusColor(status: string): string {
  const key = status.trim();
  return (
    MILESTONE_STATUS_COLOR_VARS.get(key) ??
    MILESTONE_STATUS_COLOR_VARS.get(key.toLowerCase()) ??
    COCKPIT_STATUS_NEUTRAL
  );
}

// ---------------------------------------------------------------------------
// Narrative card text
// ---------------------------------------------------------------------------

/**
 * A hand-written narrative card, parsed.
 *
 * An author who overrides a card types plain lines, and those lines have to
 * come out looking like the derived ones — otherwise switching a card to
 * manual visibly downgrades it. So both go through the same line model: this
 * parses the text into it, and the derived cards build it directly.
 *
 * The line syntax, in the order it is tested:
 *   - the first line is the lead
 *   - an indented line, or one starting `↳`, is a note under the line above
 *   - `🗓️ …` is an empty-state line
 *   - a line opening with a section emoji is a section heading
 *   - `…` / `...` is a grey footnote
 *   - a line with `|` splits into date ｜ code ｜ title ｜ percent-or-amount ｜ [tag]
 *   - anything else is a bullet
 */
export type CockpitCardLine =
  | { kind: "lead"; text: string }
  | { kind: "note"; text: string }
  | { kind: "empty"; text: string }
  | { kind: "section"; text: string }
  | { kind: "more"; text: string }
  | { kind: "bullet"; text: string }
  | {
      kind: "item";
      /** Leading date badge, as written. */
      date: string;
      /** Code badge, as written — a task code, an issue identifier, "MS-3". */
      code: string;
      title: string;
      /** `[…]` tag, unwrapped. */
      tag: string;
      /** Trailing percent or amount badge, as written. */
      badge: string;
    };

const CARD_DATE_RE =
  /^(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}(?:[-–~]\d{1,2}(?:\/\d{1,2})?)?|\d{1,2}月\d{1,2}日)$/;
// Positional row codes ("01", "05.01", "01.01.03"), the legacy "L3-01-08"
// shape, and issue identifiers from any workspace prefix.
const CARD_CODE_RE = /^(?:\d{2}(?:\.\d{2}){0,2}|L\d{1,2}-\d{2}-\d{2,3}|[A-Za-z][A-Za-z0-9]*-\d{1,5})$/;
const CARD_BADGE_RE = /^\d+(?:[\d,]*\.\d+)?\s*(?:万|万元|元|%)$/;
const CARD_TAG_RE = /^[[［](.+?)[\]］]$/;
const CARD_SECTION_RE = /^[✅🔄🎯💰📅📌⚠⏳🧾🤝🚀💡📦📋🗂📝⭐🔧]/u;
const CARD_EMPTY_RE = /^🗓/u;
const CARD_MORE_RE = /^(?:…|\.\.\.)/;

export function parseCockpitCardText(text: string): CockpitCardLine[] {
  const raw = String(text ?? "").replace(/\r/g, "");
  const lines: CockpitCardLine[] = [];
  let lead = false;

  for (const source of raw.split("\n")) {
    const indented = /^[ \t]/.test(source);
    const value = source.trim();
    if (!value) continue;

    if (indented || value.startsWith("↳")) {
      lines.push({ kind: "note", text: value.replace(/^↳\s*/, "") });
      continue;
    }
    if (!lead) {
      lines.push({ kind: "lead", text: value });
      lead = true;
      continue;
    }
    if (CARD_EMPTY_RE.test(value)) {
      lines.push({ kind: "empty", text: value });
      continue;
    }
    if (CARD_SECTION_RE.test(value)) {
      lines.push({ kind: "section", text: value });
      continue;
    }
    if (CARD_MORE_RE.test(value)) {
      lines.push({ kind: "more", text: value });
      continue;
    }
    if (value.includes("|")) {
      let date = "";
      let code = "";
      let badge = "";
      let tag = "";
      const title: string[] = [];
      for (const part of value.split("|").map((p) => p.trim())) {
        if (!part) continue;
        if (!date && CARD_DATE_RE.test(part)) {
          date = part;
          continue;
        }
        if (!code && title.length === 0 && CARD_CODE_RE.test(part)) {
          code = part;
          continue;
        }
        if (!badge && title.length > 0 && CARD_BADGE_RE.test(part)) {
          badge = part;
          continue;
        }
        if (!tag && title.length > 0 && CARD_TAG_RE.test(part)) {
          tag = part.replace(CARD_TAG_RE, "$1");
          continue;
        }
        title.push(part);
      }
      if (date || code || badge || tag) {
        lines.push({ kind: "item", date, code, title: title.join(" · "), tag, badge });
        continue;
      }
    }
    lines.push({ kind: "bullet", text: value });
  }

  return lines;
}

/** A counted quantity inside card prose — the card sets these in bolder type. */
const CARD_NUMBER_RE = /\d[\d,.]*\s*(?:万元|万|项|个|%|人|次|笔)/g;

/**
 * Card prose split into plain and emphasised runs. "天" is deliberately not a
 * unit here: a span of days is context, not a figure worth pulling out.
 */
export function splitCockpitCardNumbers(text: string): { text: string; emphasis: boolean }[] {
  const runs: { text: string; emphasis: boolean }[] = [];
  let cursor = 0;
  for (const match of text.matchAll(CARD_NUMBER_RE)) {
    const at = match.index ?? 0;
    if (at > cursor) runs.push({ text: text.slice(cursor, at), emphasis: false });
    runs.push({ text: match[0], emphasis: true });
    cursor = at + match[0].length;
  }
  if (cursor < text.length) runs.push({ text: text.slice(cursor), emphasis: false });
  return runs;
}

// ---------------------------------------------------------------------------
// Schedule warnings
// ---------------------------------------------------------------------------

/** Statuses that mean the row has not been picked up yet. */
const NOT_STARTED_STATUSES = new Set(["待开始", "未开始", "not started", "not_started", ""]);

/**
 * "Should have started": the plan window is open and the status still says the
 * work has not begun. Distinct from late — nothing is overdue yet, but the row
 * is drifting, and drift is cheaper to fix than a miss.
 */
export function isCockpitNodeDrifting(node: CockpitNode, today: string): boolean {
  if (!node.start_date || !node.end_date) return false;
  if (isCockpitNodeLate(node, today)) return false;
  const status = node.status.trim();
  if (!NOT_STARTED_STATUSES.has(status) && !NOT_STARTED_STATUSES.has(status.toLowerCase())) {
    return false;
  }
  return today >= node.start_date && today <= node.end_date;
}

// ---------------------------------------------------------------------------
// Payment grouping
// ---------------------------------------------------------------------------

/** Execution-status precedence when several instalments land on one day. */
const EXEC_STATUS_RANK = new Map<string, number>([
  ["完全支付", 4],
  ["已支付", 4],
  ["paid", 4],
  ["合同已定", 3],
  ["已签合同", 3],
  ["contracted", 3],
  ["未支付", 2],
  ["unpaid", 2],
  ["规划中", 1],
  ["planning", 1],
]);

function execRank(status: string): number {
  const key = status.trim();
  return EXEC_STATUS_RANK.get(key) ?? EXEC_STATUS_RANK.get(key.toLowerCase()) ?? 0;
}

export interface CockpitPaymentEntry {
  payment: CockpitPayment;
  node: CockpitNode;
}

/** Instalments collapsed into a single marker on the timeline. */
export interface CockpitPaymentGroup {
  /** The day the marker sits on. */
  date: string;
  /** The YYYY-MM a scheduled bucket covers; null for a settled one. */
  month: string | null;
  paid: boolean;
  /** The most advanced tone in the group — what the marker colours by. */
  tone: CockpitPaymentTone;
  total: number;
  /** The most advanced execution status in the group. */
  execStatus: string;
  entries: CockpitPaymentEntry[];
}

/**
 * Instalments across a subtree, bucketed for the timeline.
 *
 * A branch row carries the money of everything under it: on a collapsed board
 * that is the only place the payment schedule is visible at all, and reading
 * "when does this module pay out" should not require expanding it.
 *
 * Money already paid is bucketed by the day it moved, because that day is a
 * fact. Money still scheduled is bucketed by month and anchored on the month's
 * last instalment, because a plan is only ever accurate to the month — drawing
 * eight separate dots across one month implies a precision the dates do not
 * carry, and at month density they would overlap into one blob anyway.
 */
export function groupSubtreePayments(
  entry: CockpitTreeNode,
  paymentsByNode: Map<string, CockpitPayment[]>,
  nodeById: Map<string, CockpitNode>,
): CockpitPaymentGroup[] {
  const buckets = new Map<string, { date: string; month: string | null; paid: boolean; entries: CockpitPaymentEntry[] }>();
  for (const id of subtreeIds(entry)) {
    for (const payment of paymentsByNode.get(id) ?? []) {
      if (!payment.pay_date) continue;
      const node = nodeById.get(payment.node_id);
      if (!node) continue;
      const paid = cockpitPaymentTone(node.exec_status) === "paid";
      const month = paid ? null : payment.pay_date.slice(0, 7);
      const key = paid ? `paid:${payment.pay_date}` : `plan:${month}`;
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.entries.push({ payment, node });
        // A scheduled bucket rides on the month's last instalment.
        if (payment.pay_date > bucket.date) bucket.date = payment.pay_date;
      } else {
        buckets.set(key, { date: payment.pay_date, month, paid, entries: [{ payment, node }] });
      }
    }
  }
  return [...buckets.values()]
    .map((bucket) => ({
      date: bucket.date,
      month: bucket.month,
      paid: bucket.paid,
      tone: bucket.paid
        ? ("paid" as CockpitPaymentTone)
        : bucket.entries
            .map((e) => cockpitPaymentTone(e.node.exec_status))
            .sort((a, b) => PAYMENT_TONE_RANK[b] - PAYMENT_TONE_RANK[a])[0] ?? "pending",
      total: bucket.entries.reduce((sum, e) => sum + e.payment.amount, 0),
      execStatus: bucket.entries
        .map((e) => e.node.exec_status)
        .sort((a, b) => execRank(b) - execRank(a))[0] ?? "",
      entries: bucket.entries,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------------------------------------------------------------------
// Finance detail rows
// ---------------------------------------------------------------------------

/**
 * One line of the spend ledger.
 *
 * Every field is derived from the node and its instalments — the board this
 * replaces kept a parallel hand-maintained table for exactly this, and it drifted
 * from the tasks it was supposed to describe. Here there is one source.
 */
export interface CockpitFinanceRow {
  node: CockpitNode;
  /** Root branch this line rolls up to, for the module column. */
  rootCode: string;
  rootColor: string;
  budget: number;
  /** First instalment date — when the money is expected to move. */
  plannedDate: string | null;
  /** First instalment date once the node reads as paid; null while it has not. */
  actualDate: string | null;
  /** Budget once paid; null while it has not been. */
  actualAmount: number | null;
  payments: CockpitPayment[];
}

/** The spend ledger, in board order, for every node that carries money. */
export function computeCockpitFinanceRows(
  tree: CockpitTreeNode[],
  payments: CockpitPayment[],
): CockpitFinanceRow[] {
  const paymentsByNode = groupPaymentsByNode(payments);
  const rows: CockpitFinanceRow[] = [];

  const walk = (entry: CockpitTreeNode, rootCode: string, rootColor: string) => {
    const own = paymentsByNode.get(entry.node.id) ?? [];
    const budget = entry.node.budget_amount ?? 0;
    if (budget > 0 || own.length > 0) {
      const status = entry.node.exec_status.trim();
      const paid = PAID_STATUSES.has(status) || PAID_STATUSES.has(status.toLowerCase());
      const firstDate = own.find((p) => p.pay_date)?.pay_date ?? null;
      rows.push({
        node: entry.node,
        rootCode,
        rootColor,
        budget,
        plannedDate: firstDate,
        actualDate: paid ? firstDate : null,
        actualAmount: paid ? budget : null,
        payments: own,
      });
    }
    entry.children.forEach((child) => walk(child, rootCode, rootColor));
  };

  tree.forEach((root) => walk(root, root.node.code, root.color));
  return rows;
}
