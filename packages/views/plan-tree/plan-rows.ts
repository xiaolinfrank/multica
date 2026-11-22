import type { CockpitNode } from "@multica/core/types";
import type { CockpitPlanTaskCount } from "@multica/core/types/cockpit-read";
import { cockpitIssueProgress } from "@multica/core/cockpit";

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

/** The plan's name for the shared issue ratio: one implementation in core, so
 *  the tree and the gantt can never disagree about what 75% means. */
export function planIssueProgress(counts: CockpitPlanTaskCount | null): number | null {
  return cockpitIssueProgress(counts);
}

function kindOf(node: CockpitNode, depth: number): PlanKind {
  if (node.kind === "project" || node.kind === "module" || node.kind === "work_item") return node.kind;
  return depth === 0 ? "project" : depth === 1 ? "module" : "work_item";
}

/** A row's level anywhere a flat read is in hand: `kind` when the read row
 *  carries it, else the parent chain's depth. A code is an address, not a
 *  level — after the reconcile a root reads "00"…"19" like any other row. */
export function planNodeKind(node: CockpitNode, byId: ReadonlyMap<string, CockpitNode>): PlanKind {
  return kindOf(node, planDepthOf(node, byId));
}

/** One row, for a caller that has already resolved the visible shape (a
 *  filtered or presentation tree): kind still comes from `node.kind` first,
 *  so a presentation row can never relabel a work item as a module. */
export function planRowFor(
  node: CockpitNode,
  depth: number,
  counts: CockpitPlanTaskCount | null,
  hasChildren: boolean,
): PlanRow {
  return { node, kind: kindOf(node, depth), depth, code: node.code, name: node.name, counts, hasChildren };
}

/** Depth by the parent chain, independent of any code format. */
export function planDepthOf(node: CockpitNode, byId: ReadonlyMap<string, CockpitNode>): number {
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
  /** Ids whose children are shown. A collapsed row's subtree is skipped —
   *  except while searching, when the query alone decides what is visible. */
  expanded: ReadonlySet<string>;
  /** Search text. Filters to the hits and the parents that place them; a hit
   *  inside a closed branch still shows, and a hit does not pull in children
   *  that do not match. */
  query?: string;
  /** Restrict to these root branches; empty shows the whole plan. A branch
   *  keeps its own depth, so a scoped view still reads at the right level. */
  rootIds?: ReadonlySet<string>;
}

/** Flatten the plan into visible rows, parents before children, siblings in
 *  (position, code) order — the order the tree itself reads in. */
export function buildPlanRows({ nodes, counts, expanded, query, rootIds }: BuildPlanRowsInput): PlanRow[] {
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
  const searching = needle.length > 0;
  const matches = (node: CockpitNode) =>
    node.name.toLowerCase().includes(needle) || node.code.toLowerCase().includes(needle);
  // The rows a search leaves visible: the hits themselves plus the parents
  // that place them, so no hit is hidden behind a closed branch and no
  // non-matching sibling stays on screen. This is a filter like the finance
  // grid's, not an expander.
  const visible = new Set<string>();
  if (searching) {
    for (const node of nodes) {
      if (!matches(node)) continue;
      let current: CockpitNode | undefined = node;
      const seen = new Set<string>();
      while (current && !seen.has(current.id)) {
        seen.add(current.id);
        visible.add(current.id);
        current = current.parent_id ? byId.get(current.parent_id) : undefined;
      }
    }
  }
  const keeps = (node: CockpitNode) => !searching || visible.has(node.id);

  const rows: PlanRow[] = [];
  const roots = rootIds && rootIds.size > 0 ? nodes.filter((node) => rootIds.has(node.id)) : null;
  const walk = (parentId: string | null, depth: number) => {
    for (const node of childrenOf.get(parentId) ?? []) {
      if (!keeps(node)) continue;
      const children = childrenOf.get(node.id) ?? [];
      rows.push(planRowFor(node, depth, countsById.get(node.id) ?? null, children.length > 0));
      if (searching || expanded.has(node.id)) walk(node.id, depth + 1);
    }
  };
  if (roots && roots.length > 0) {
    for (const root of [...roots].sort((a, b) => a.position - b.position || a.code.localeCompare(b.code))) {
      if (!keeps(root)) continue;
      const depth = planDepthOf(root, byId);
      rows.push(planRowFor(root, depth, countsById.get(root.id) ?? null, (childrenOf.get(root.id) ?? []).length > 0));
      if (searching || expanded.has(root.id)) walk(root.id, depth + 1);
    }
  } else {
    walk(null, 0);
  }
  return rows;
}

/** The plan's modules in code order — the move menu's choices. */
export function planModules(nodes: readonly CockpitNode[]): CockpitNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return nodes
    .filter((n) => kindOf(n, planDepthOf(n, byId)) === "module")
    .sort((a, b) => a.code.localeCompare(b.code));
}
