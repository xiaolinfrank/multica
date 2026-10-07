// Pure graph-model math for the issue graph view. Everything here is
// deterministic and DOM-free: filtering, degrees, adjacency, subtree
// collection (collapse/expand), focus BFS, and search matching. The canvas
// component in packages/views consumes the produced model; these helpers are
// the canonical, node-environment-tested layer for the graph behavior matrix.
//
// Canonical test file: build-graph-model.test.ts (// @vitest-environment node).

import { GRAPH_EDGE_KINDS, graphExecutionAddress, graphMeetingAddress } from "../types/graph";
import type {
  GraphEdge,
  GraphNode,
  GraphMeetingNode,
  GraphExecutionNode,
  GraphEdgeKind,
  GraphEntity,
  IssueGraphResponse,
} from "../types/graph";

export type {
  GraphEdge,
  GraphNode,
  GraphMeetingNode,
  GraphExecutionNode,
  GraphEdgeKind,
  GraphEntity,
};
export { graphExecutionAddress, graphMeetingAddress, graphAddressEntity } from "../types/graph";

export interface GraphFilters {
  /** Project ids to keep; null keeps every project (workspace scope). */
  projects: Set<string> | null;
  /** Status categories to keep; null keeps every status. */
  statuses: Set<string> | null;
  /** Edge kinds to draw. Unknown kinds from newer backends never appear. */
  edgeKinds: Set<GraphEdgeKind>;
  /** Entity layers. Off means the nodes AND their edges leave the canvas;
   *  the toolbar's relation toggles drive these. */
  meetings: boolean;
  executions: boolean;
}

export function defaultEdgeKinds(): Set<GraphEdgeKind> {
  return new Set<GraphEdgeKind>(GRAPH_EDGE_KINDS);
}

export interface GraphModelEdge {
  source: string;
  target: string;
  kind: GraphEdgeKind;
}

export interface GraphModel {
  /** Visible issues, keyed by raw UUID. */
  nodes: GraphNode[];
  /** Visible meetings. Graph address (edge endpoints, neighbors/degree keys)
   *  is `mtg:<id>` — see types/graph.ts. */
  meetings: GraphMeetingNode[];
  /** Visible executions; graph address is `run:<id>`. */
  executions: GraphExecutionNode[];
  edges: GraphModelEdge[];
  /** Undirected neighbor map over the filtered edges (for hover highlight
   *  and focus expansion). Keys are graph addresses across all three entity
   *  types. */
  neighbors: Map<string, Set<string>>;
  /** Filtered degree per graph address (for node radius and hub emphasis). */
  degree: Map<string, number>;
  /** parent -> direct children over `child` edges (for collapse/expand).
   *  Only issues participate: meeting/execution edges are never `child`. */
  children: Map<string, string[]>;
}

const KNOWN = new Set<string>(GRAPH_EDGE_KINDS);

export function buildGraphModel(
  graph: IssueGraphResponse,
  filters: GraphFilters,
): GraphModel {
  const nodes = graph.nodes.filter((n) => {
    if (filters.projects && n.project_id && !filters.projects.has(n.project_id)) {
      return false;
    }
    // Issues without a project always survive a project filter: "no project"
    // is a selectable bucket, not a lack of data, and the project filter
    // panel toggles it explicitly through the projects set.
    if (filters.projects && !n.project_id) {
      return filters.projects.has("");
    }
    if (filters.statuses && !filters.statuses.has(n.status_category)) {
      return false;
    }
    return true;
  });

  const visible = new Set(nodes.map((n) => n.id));

  // Meeting visibility: the entity toggle, plus — for a meeting linked to
  // issues — at least one linked issue still visible (a project/status filter
  // that hides every linked issue hides the meeting with them). A meeting
  // with no links at all is a workspace-level record and stays.
  const meetingLinkedIssues = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.kind !== "meeting") continue;
    const list = meetingLinkedIssues.get(e.source);
    if (list) list.push(e.target);
    else meetingLinkedIssues.set(e.source, [e.target]);
  }
  const meetings = (graph.meetings ?? []).filter((m) => {
    if (!filters.meetings) return false;
    const linked = meetingLinkedIssues.get(graphMeetingAddress(m.id)) ?? [];
    return linked.length === 0 || linked.some((id) => visible.has(id));
  });
  const visibleMeetings = new Set(meetings.map((m) => graphMeetingAddress(m.id)));

  // An execution is meaningful only next to its issue: filter the issue away
  // and the run goes with it.
  const executions = (graph.executions ?? []).filter(
    (r) => filters.executions && visible.has(r.issue_id),
  );
  const visibleExecutions = new Set(executions.map((r) => graphExecutionAddress(r.id)));

  const isVisibleEndpoint = (addr: string) =>
    visible.has(addr) || visibleMeetings.has(addr) || visibleExecutions.has(addr);

  const edges: GraphModelEdge[] = [];
  for (const e of graph.edges) {
    if (!KNOWN.has(e.kind)) continue;
    if (!filters.edgeKinds.has(e.kind as GraphEdgeKind)) continue;
    if (!isVisibleEndpoint(e.source) || !isVisibleEndpoint(e.target)) continue;
    edges.push({ source: e.source, target: e.target, kind: e.kind as GraphEdgeKind });
  }

  const neighbors = new Map<string, Set<string>>();
  const degree = new Map<string, number>();
  const children = new Map<string, string[]>();
  const ensure = (id: string) => {
    let set = neighbors.get(id);
    if (!set) {
      set = new Set<string>();
      neighbors.set(id, set);
    }
    return set;
  };
  for (const n of nodes) {
    ensure(n.id);
    degree.set(n.id, 0);
  }
  for (const m of meetings) {
    ensure(graphMeetingAddress(m.id));
    degree.set(graphMeetingAddress(m.id), 0);
  }
  for (const r of executions) {
    ensure(graphExecutionAddress(r.id));
    degree.set(graphExecutionAddress(r.id), 0);
  }
  for (const e of edges) {
    ensure(e.source).add(e.target);
    ensure(e.target).add(e.source);
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    if (e.kind === "child") {
      const list = children.get(e.source);
      if (list) list.push(e.target);
      else children.set(e.source, [e.target]);
    }
  }

  return { nodes, meetings, executions, edges, neighbors, degree, children };
}

/** Every descendant of root over child edges (root excluded). Used to fold a
 *  whole sub-issue branch into its parent on collapse. */
export function collectSubtree(rootId: string, children: Map<string, string[]>): Set<string> {
  const out = new Set<string>();
  const stack = [...(children.get(rootId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (out.has(id)) continue; // defensive: a cycle cannot exist server-side (UpdateIssue guards), be robust anyway
    out.add(id);
    for (const child of children.get(id) ?? []) stack.push(child);
  }
  return out;
}

/** Node ids within `depth` hops of focusId (focusId included). Depth 0 is the
 *  node alone — the Obsidian "local graph" at minimum reach. */
export function focusNodeIds(
  model: GraphModel,
  focusId: string,
  depth: number,
): Set<string> {
  const out = new Set<string>([focusId]);
  let frontier = [focusId];
  for (let d = 0; d < depth; d += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of model.neighbors.get(id) ?? []) {
        if (!out.has(neighbor)) {
          out.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
  }
  return out;
}

/** Case-insensitive prefix/substring match over identifier and title. An
 *  empty query matches nothing (callers treat empty as "no search"). The
 *  structural signature lets meetings (identifier=code) and executions
 *  (identifier=owning issue, title=agent name) share the one matcher. */
export function matchesQuery(node: Pick<GraphNode, "identifier" | "title">, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return (
    node.identifier.toLowerCase().includes(q) ||
    node.title.toLowerCase().includes(q)
  );
}

/** Stable color bucket per project id: alphabetically ordered index cycling
 *  through the chart palette. Issues without a project get the last bucket
 *  (muted) — see the legend. Sorting (not hashing) keeps the mapping stable
 *  across reloads while staying deterministic. */
export function projectColorIndex(projectId: string | null, allProjectIds: string[]): number {
  if (!projectId) return allProjectIds.length;
  const sorted = [...allProjectIds].sort();
  const idx = sorted.indexOf(projectId);
  return idx === -1 ? allProjectIds.length : idx;
}

/** Node radius from filtered degree: hubs grow with sqrt so star nodes do not
 *  swallow the canvas, isolated nodes keep the base radius. */
export function nodeRadius(degree: number): number {
  return 4 + Math.sqrt(Math.max(degree, 0)) * 2;
}
