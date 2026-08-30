// Deterministic synthetic graph for ?demo=1 — the same escape hatch the Agent
// Office uses (office-demo.ts). Lets an empty workspace (or a fresh checkout)
// show what the graph looks like without seeding data: three projects, a
// sub-issue chain, cross-references, and one dependency, sized like a real
// small workspace.

import type { IssueGraphResponse } from "@multica/core/types";

const PROJECTS = ["p-alpha", "p-beta", "p-gamma"] as const;
const STATUSES = ["todo", "in_progress", "in_review", "done", "blocked"] as const;
const TITLES = [
  "Screen candidates", "Prepare library", "QC pass", "Draft summary",
  "Ship release", "Follow up", "Reproduce report", "Review protocol",
  "Fix pipeline", "Archive dataset", "Schedule sync", "Close milestone",
  "Write test matrix", "Backfill metadata", "Index notes", "Tag samples",
  "Send digest", "Plan sprint", "Audit access", "Refine prompt",
] as const;

export function demoGraph(): IssueGraphResponse {
  const nodes: IssueGraphResponse["nodes"] = [];
  for (let i = 0; i < 24; i += 1) {
    const status = STATUSES[i % STATUSES.length] ?? "todo";
    nodes.push({
      id: `demo-${i + 1}`,
      identifier: `TES-${i + 1}`,
      number: i + 1,
      title: TITLES[i % TITLES.length] ?? "Task",
      status,
      status_category: status,
      priority: i % 5 === 0 ? "high" : "none",
      project_id: i === 23 ? null : PROJECTS[i % PROJECTS.length] ?? null,
      updated_at: "",
    });
  }

  const edges: IssueGraphResponse["edges"] = [];
  const add = (source: number, target: number, kind: string) =>
    edges.push({ source: `demo-${source}`, target: `demo-${target}`, kind });

  // A sub-issue chain per project: 1→2→3, 4→5→6, ...
  for (let base = 1; base <= 19; base += 6) {
    add(base, base + 1, "child");
    add(base, base + 2, "child");
    add(base + 1, base + 3, "child");
  }
  // Dependencies inside a project.
  add(4, 6, "blocks");
  add(10, 12, "blocks");
  add(16, 18, "related");
  // Cross-project mention references (the dashed edges).
  for (const [from, to] of [
    [1, 8], [2, 9], [5, 14], [7, 20], [11, 3], [13, 22], [17, 24],
    [19, 6], [21, 12], [23, 4],
  ] as const) {
    add(from, to, "mention");
  }

  return { nodes, edges };
}
