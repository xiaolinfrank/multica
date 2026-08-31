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
] as const;

export type GraphEdgeKind = (typeof GRAPH_EDGE_KINDS)[number];

export interface GraphEdge {
  source: string;
  target: string;
  kind: string;
}

export interface IssueGraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
