// Read model for GET /api/issues/graph — the Obsidian-style issue graph.
// Nodes are issues (with the properties the graph colors and filters on),
// edges are the three issue-to-issue relations the product tracks. The server
// assembles this snapshot at read time; there is no persisted graph.

export interface GraphNode {
  id: string;
  // Human identifier (PREFIX-N), assembled server-side from the workspace
  // issue prefix and the issue number.
  identifier: string;
  number: number;
  title: string;
  status: string;
  // Canonical status category (one of the 7 built-in keys) the status maps
  // to; a custom status resolves through the workspace catalog. Same value
  // the issue list uses for coloring.
  status_category: string;
  priority: string;
  project_id: string | null;
  updated_at: string;
  // Display name of the member or agent the issue is assigned to. Empty when
  // unassigned; resolved server-side so the graph never needs per-assignee
  // lookups.
  assignee_name: string;
}

// Edge kinds the server emits today. `kind` is typed as string (not a union)
// so an unknown kind from a newer backend degrades in the renderer instead of
// failing the whole schema; unknown kinds are dropped when the graph model is
// built.
export const GRAPH_EDGE_KINDS = [
  "child",
  "blocks",
  "blocked_by",
  "related",
  "mention",
  // meeting — a cockpit meeting linked to the issue (its own minutes task or
  // a hand attachment) or to an L3 execution row. Source is the meeting's
  // graph address ("mtg:<uuid>").
  "meeting",
  // execution — a level-3 cockpit node (the execution gantt's leaf row)
  // linked to its work items. Source is the row's graph address ("exc:<uuid>").
  "execution",
] as const;

export type GraphEdgeKind = (typeof GRAPH_EDGE_KINDS)[number];

export interface GraphEdge {
  source: string;
  target: string;
  kind: string;
}

// A cockpit meeting as a graph node. The meeting register lives outside the
// issue tracker, so these arrive in their own array — an older client reads
// only `nodes`/`edges` and never mistakes one for an issue.
export interface GraphMeetingNode {
  /** Raw meeting UUID. Its graph address (edge endpoints) is `mtg:<id>`. */
  id: string;
  code: string;
  title: string;
  meet_date: string;
  status: string;
  track: string;
  /** The meeting's folder on the shared storage; empty when never provisioned. */
  nas_dir: string;
}

// A level-3 cockpit node as a graph node — the execution gantt's leaf row,
// so the graph and the gantt show the same "executions". Links to issues and
// meetings arrive as edges (execution / meeting kinds), not fields here.
export interface GraphExecutionNode {
  /** Raw cockpit_node UUID. Its graph address is `exc:<id>`. */
  id: string;
  code: string;
  name: string;
  status: string;
  /** 0..100 progress as shown on the gantt bar (same scale as cockpit). */
  progress: number;
  /** Gantt window; empty when the row has no dates. */
  start_date: string;
  end_date: string;
  owner: string;
  /** The row code the gantt DISPLAYS ("06.02.01"), derived client-side from
   *  the cockpit_nodes index — stored codes are the programme's own addresses
   *  and drift out of sync with position ("L3-06-03" sits under 06.02). Set
   *  by buildGraphModel; renderers fall back to `code` when absent. */
  display_code?: string;
}

// One slim cockpit_node row of the whole-board index shipped with the graph
// snapshot; the client rebuilds the tree from it to derive display codes.
export interface GraphCockpitIndexNode {
  id: string;
  code: string;
  parent_id: string | null;
  position: number;
}

export interface IssueGraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  meetings: GraphMeetingNode[];
  executions: GraphExecutionNode[];
  cockpit_nodes: GraphCockpitIndexNode[];
}

// Graph address space: issue nodes keep their raw UUID; meetings and L3
// execution rows are prefixed so an endpoint's entity type reads straight off
// the id and a UUID shared across tables could never collide silently.
export const graphMeetingAddress = (id: string) => `mtg:${id}`;
export const graphExecutionAddress = (id: string) => `exc:${id}`;
export type GraphEntity = "issue" | "meeting" | "execution";
export function graphAddressEntity(id: string): GraphEntity {
  if (id.startsWith("mtg:")) return "meeting";
  if (id.startsWith("exc:")) return "execution";
  return "issue";
}
