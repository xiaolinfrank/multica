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
  // a hand attachment). Source is the meeting's graph address ("mtg:<uuid>").
  "meeting",
  // execution — the issue's latest finished run / in-flight runs. Target is
  // the run's graph address ("run:<uuid>").
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

// An agent run as a graph node: the issue's latest finished run, plus every
// run still in flight (see the server query for the exact window).
export interface GraphExecutionNode {
  /** Raw agent_task_queue UUID. Its graph address is `run:<id>`. */
  id: string;
  issue_id: string;
  agent_name: string;
  status: string;
  started_at: string;
  completed_at: string;
  /** Anchors the run to its trigger comment for the #comment-<id> deep link. */
  trigger_comment_id: string | null;
}

export interface IssueGraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  meetings: GraphMeetingNode[];
  executions: GraphExecutionNode[];
}

// Graph address space: issue nodes keep their raw UUID; meetings and runs are
// prefixed so an endpoint's entity type reads straight off the id and a UUID
// shared across tables could never collide silently.
export const graphMeetingAddress = (id: string) => `mtg:${id}`;
export const graphExecutionAddress = (id: string) => `run:${id}`;
export type GraphEntity = "issue" | "meeting" | "execution";
export function graphAddressEntity(id: string): GraphEntity {
  if (id.startsWith("mtg:")) return "meeting";
  if (id.startsWith("run:")) return "execution";
  return "issue";
}
