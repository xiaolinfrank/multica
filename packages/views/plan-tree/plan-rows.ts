import type { CockpitNode } from "@multica/core/types";
import type { CockpitPlanTaskCount } from "@multica/core/types/cockpit-read";

// The plan tree's row model. Level is read from `kind` (S2 writes it on every
// read row); the parent chain is the fallback for a board API row that carries
// no kind. Numbering is NOT a level signal any more — a merged or reflowed
// code would lie about depth.

export type PlanKind = "project" | "module" | "work_item";

export interface PlanRow {
  node: CockpitNode;
  kind: PlanKind;
  depth: number;
  /** The node's own address — `node.code`, never re-derived. */
  code: string;
  /** Display name: the row's own title (project/module titles arrive as
   *  node.name from the plan projection). */
  name: string;
  counts: CockpitPlanTaskCount | null;
  hasChildren: boolean;
}

/** Percentage of a work item's copies of its own work that are done, or null
 *  when nothing is countable. `closed` (cancelled) is not work: it leaves the
 *  denominator so cancelling a task never reads as progress. */
export function planIssueProgress(counts: CockpitPlanTaskCount | null): number | null {
  if (!counts) return null;
  const denominator = counts.primary_total - counts.closed;
  if (denominator <= 0) return null;
  return Math.round((counts.done / denominator) * 100);
}

function kindOf(node: CockpitNode, depth: number): PlanKind {
  if (node.kind === "project" || node.kind === "module" || node.kind === "work_item") return node.kind;
  return depth === 0 ? "project" : depth === 1 ? "module" : "work_item";
}

/** Depth by the parent chain, independent of any code format. */
function depthOf(node: CockpitNode, byId: ReadonlyMap<string, CockpitNode>): number {
  let depth = 0;
  let current = node.parent_id ? byId.get(node.parent_id) : undefined;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    depth += 1;
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return depth;
}

export interface BuildPlanRowsInput {
  nodes: readonly CockpitNode[];
  counts: readonly CockpitPlanTaskCount[];
  /** Ids whose children are shown. A collapsed row's subtree is skipped. */
  expanded: ReadonlySet<string>;
  /** Search text. A match expands its ancestor path (the caller seeds
   *  `expanded`); matching rows stay visible even when a parent collapsed. */
  query?: string;
}

/** Flatten the plan into visible rows, parents before children, siblings in
 *  (position, code) order — the order the tree itself reads in. */
export function buildPlanRows({ nodes, counts, expanded, query }: BuildPlanRowsInput): PlanRow[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childrenOf = new Map<string | null, CockpitNode[]>();
  for (const node of nodes) {
    const key = node.parent_id && byId.has(node.parent_id) ? node.parent_id : null;
    const list = childrenOf.get(key);
    if (list) list.push(node);
    else childrenOf.set(key, [node]);
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => a.position - b.position || a.code.localeCompare(b.code));
  }
  const countsById = new Map(counts.map((c) => [c.node_id, c]));
  const needle = query?.trim().toLowerCase() ?? "";
  const matches = (node: CockpitNode) =>
    needle.length === 0 || node.name.toLowerCase().includes(needle) || node.code.toLowerCase().includes(needle);
  // A match deep in a collapsed subtree still shows itself: keep every row on a
  // match's ancestor path so the hit is never hidden behind a closed parent.
  const pathToMatch = new Set<string>();
  if (needle.length > 0) {
    for (const node of nodes) {
      if (!matches(node)) continue;
      let current: CockpitNode | undefined = node;
      while (current) {
        pathToMatch.add(current.id);
        current = current.parent_id ? byId.get(current.parent_id) : undefined;
      }
    }
  }

  const rows: PlanRow[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const node of childrenOf.get(parentId) ?? []) {
      const kind = kindOf(node, depth);
      const children = childrenOf.get(node.id) ?? [];
      rows.push({
        node,
        kind,
        depth,
        code: node.code,
        name: node.name,
        counts: countsById.get(node.id) ?? null,
        hasChildren: children.length > 0,
      });
      const open = expanded.has(node.id) || pathToMatch.has(node.id);
      if (open) walk(node.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

/** Sibling work items under one module, in order — the move menu's choices. */
export function planModules(nodes: readonly CockpitNode[]): CockpitNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return nodes
    .filter((n) => kindOf(n, depthOf(n, byId)) === "module")
    .sort((a, b) => a.code.localeCompare(b.code));
}

/** Ids to expand by default: everything down to the work items, which is what
 *  "expanded to work item" means on a three-level plan. */
export function planDefaultExpanded(nodes: readonly CockpitNode[]): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return new Set(nodes.filter((n) => kindOf(n, depthOf(n, byId)) !== "work_item").map((n) => n.id));
}
