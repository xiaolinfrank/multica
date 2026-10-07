// @vitest-environment node
// Canonical matrix for the graph model helpers — the canvas component suite
// keeps only the happy path and wiring.

import { describe, expect, it } from "vitest";
import type { GraphEdgeKind, IssueGraphResponse } from "../types/graph";
import {
  buildGraphModel,
  collectSubtree,
  defaultEdgeKinds,
  focusNodeIds,
  matchesQuery,
  nodeRadius,
  projectColorIndex,
} from "./build-graph-model";

// n1 --child--> n2 --child--> n3 ; n1 --mention--> n3 ; n2 --blocks--> n4
// n5 isolated with status in_review and no project.
const graph: IssueGraphResponse = {
  nodes: [
    { id: "n1", identifier: "TES-1", number: 1, title: "Alpha", status: "todo", status_category: "todo", priority: "none", project_id: "p1", updated_at: "", assignee_name: "" },
    { id: "n2", identifier: "TES-2", number: 2, title: "Beta", status: "in_progress", status_category: "in_progress", priority: "none", project_id: "p1", updated_at: "", assignee_name: "" },
    { id: "n3", identifier: "TES-3", number: 3, title: "Gamma", status: "todo", status_category: "todo", priority: "none", project_id: "p2", updated_at: "", assignee_name: "" },
    { id: "n4", identifier: "TES-4", number: 4, title: "Delta", status: "todo", status_category: "todo", priority: "none", project_id: "p2", updated_at: "", assignee_name: "" },
    { id: "n5", identifier: "TES-5", number: 5, title: "Orphan", status: "in_review", status_category: "in_review", priority: "none", project_id: null, updated_at: "", assignee_name: "" },
  ],
  edges: [
    { source: "n1", target: "n2", kind: "child" },
    { source: "n2", target: "n3", kind: "child" },
    { source: "n1", target: "n3", kind: "mention" },
    { source: "n2", target: "n4", kind: "blocks" },
    { source: "n3", target: "n9", kind: "child" }, // dangling endpoint dropped
    { source: "n1", target: "n2", kind: "hologram" }, // unknown kind dropped
    // Three-entity layers: m1 links n1+n3 across projects, m2 is linked to
    // nothing, m3 links n5 (the orphan). r1 is n1's latest run, r2 belongs to
    // n4 (leaves with the p2/status filters).
    { source: "mtg:m1", target: "n1", kind: "meeting" },
    { source: "mtg:m1", target: "n3", kind: "meeting" },
    { source: "mtg:m3", target: "n5", kind: "meeting" },
    { source: "n1", target: "run:r1", kind: "execution" },
    { source: "n4", target: "run:r2", kind: "execution" },
  ],
  meetings: [
    { id: "m1", code: "20260901-01", title: "Kickoff", meet_date: "2026-09-01", status: "已召开", track: "项目管理", nas_dir: "/nas/m1" },
    { id: "m2", code: "20260902-01", title: "Hallway sync", meet_date: "2026-09-02", status: "已召开", track: "", nas_dir: "" },
    { id: "m3", code: "20260903-01", title: "Orphan review", meet_date: "2026-09-03", status: "待召开", track: "项目管理", nas_dir: "" },
  ],
  executions: [
    { id: "r1", issue_id: "n1", agent_name: "runner", status: "completed", started_at: "", completed_at: "", trigger_comment_id: "c1" },
    { id: "r2", issue_id: "n4", agent_name: "runner", status: "running", started_at: "", completed_at: "", trigger_comment_id: null },
  ],
};

function model(
  overrides?: Partial<{
    projects: Set<string> | null;
    statuses: Set<string> | null;
    edgeKinds: Set<string>;
    meetings: boolean;
    executions: boolean;
  }>,
) {
  return buildGraphModel(graph, {
    projects: overrides?.projects ?? null,
    statuses: overrides?.statuses ?? null,
    edgeKinds: (overrides?.edgeKinds ?? defaultEdgeKinds()) as Set<GraphEdgeKind>,
    meetings: overrides?.meetings ?? true,
    executions: overrides?.executions ?? true,
  });
}

describe("buildGraphModel", () => {
  it("keeps everything with the default filters", () => {
    const m = model();
    expect(m.nodes.map((n) => n.id)).toEqual(["n1", "n2", "n3", "n4", "n5"]);
    expect(m.edges.map((e) => `${e.source}>${e.target}:${e.kind}`)).toEqual([
      "n1>n2:child",
      "n2>n3:child",
      "n1>n3:mention",
      "n2>n4:blocks",
      "mtg:m1>n1:meeting",
      "mtg:m1>n3:meeting",
      "mtg:m3>n5:meeting",
      "n1>run:r1:execution",
      "n4>run:r2:execution",
      // Derived: m1 --meeting--> n1 --execution--> r1 => m1 --meeting_run--> r1.
      "mtg:m1>run:r1:meeting_run",
    ]);
    expect(m.meetings.map((n) => n.id)).toEqual(["m1", "m2", "m3"]);
    expect(m.executions.map((n) => n.id)).toEqual(["r1", "r2"]);
  });

  it("drops edges with an endpoint outside the filtered node set and unknown kinds", () => {
    const m = model();
    expect(m.edges.some((e) => e.target === "n9")).toBe(false);
    // "hologram" (unknown kind) is absent from the equal assertion above; the
    // model types the surviving kinds, so an unknown kind cannot appear.
  });

  it("filters nodes by project, treating no-project as the empty-string bucket", () => {
    const onlyP1 = model({ projects: new Set(["p1"]) });
    expect(onlyP1.nodes.map((n) => n.id)).toEqual(["n1", "n2"]);
    // The n1-n2 child edge survives (both endpoints in p1); everything else
    // left the set with n3/n4.
    expect(onlyP1.edges.map((e) => `${e.source}>${e.target}`)).toEqual(["n1>n2", "mtg:m1>n1", "n1>run:r1", "mtg:m1>run:r1"]);

    const p1PlusNoProject = model({ projects: new Set(["p1", ""]) });
    expect(p1PlusNoProject.nodes.map((n) => n.id)).toEqual(["n1", "n2", "n5"]);
  });

  it("keeps a meeting only while a linked issue survives; unlinked meetings always stay", () => {
    const onlyP1 = model({ projects: new Set(["p1"]) });
    // m1 keeps n1 (n3 left with p2), m2 never had links, m3's only issue is n5.
    expect(onlyP1.meetings.map((n) => n.id)).toEqual(["m1", "m2"]);

    const todoOnly = model({ statuses: new Set(["todo"]) });
    // n5 (in_review) is gone, so m3 goes with it; m1 still has n1 and n3.
    expect(todoOnly.meetings.map((n) => n.id)).toEqual(["m1", "m2"]);
  });

  it("drops executions with their issue and honors the entity toggles", () => {
    const onlyP1 = model({ projects: new Set(["p1"]) });
    expect(onlyP1.executions.map((n) => n.id)).toEqual(["r1"]); // r2's issue n4 is in p2

    const noMeetings = model({ meetings: false });
    expect(noMeetings.meetings).toEqual([]);
    expect(noMeetings.edges.some((e) => e.kind === "meeting")).toBe(false);

    const noExecutions = model({ executions: false });
    expect(noExecutions.executions).toEqual([]);
    expect(noExecutions.edges.some((e) => e.kind === "execution")).toBe(false);
  });

  it("counts meeting and execution edges into degree and neighbors under their addresses", () => {
    const m = model();
    expect(m.degree.get("n1")).toBe(4); // n2 child, n3 mention, m1, r1
    expect(m.degree.get("mtg:m1")).toBe(3); // n1, n3, and the derived run r1
    expect(m.neighbors.get("mtg:m1")).toEqual(new Set(["n1", "n3", "run:r1"]));
    expect(m.neighbors.get("run:r1")).toEqual(new Set(["n1", "mtg:m1"]));
    // The child map only covers issue-to-issue edges.
    expect(m.children.has("mtg:m1")).toBe(false);
  });

  it("filters nodes by status category and recomputes degrees", () => {
    const todoOnly = model({ statuses: new Set(["todo"]) });
    expect(todoOnly.nodes.map((n) => n.id)).toEqual(["n1", "n3", "n4"]);
    // n1 keeps the n1-n3 mention plus its meeting and its run.
    expect(todoOnly.degree.get("n1")).toBe(3);
    expect(todoOnly.neighbors.get("n1")).toEqual(new Set(["n3", "mtg:m1", "run:r1"]));
  });

  it("honors edge-kind toggles", () => {
    const kinds = defaultEdgeKinds();
    kinds.delete("mention");
    const m = model({ edgeKinds: kinds });
    expect(m.edges.some((e) => e.kind === "mention")).toBe(false);
    expect(m.edges).toHaveLength(9); // 8 direct + the derived meeting_run
  });

  it("derives meeting-to-run edges over shared visible issues", () => {
    const m = model();
    const derived = m.edges.filter((e) => e.kind === "meeting_run");
    // m1->n1->r1 is the only complete chain: n3 (also m1's) has no runs, and
    // r2's issue n4 has no meeting.
    expect(derived).toEqual([{ source: "mtg:m1", target: "run:r1", kind: "meeting_run" }]);
  });

  it("never derives through hidden issues, meetings, or runs", () => {
    // n1 leaves with the p2-only filter, so m1 and r1 never meet.
    const onlyP2 = model({ projects: new Set(["p2"]) });
    expect(onlyP2.edges.some((e) => e.kind === "meeting_run")).toBe(false);

    // Entity toggles remove one side of the join entirely.
    expect(model({ meetings: false }).edges.some((e) => e.kind === "meeting_run")).toBe(false);
    expect(model({ executions: false }).edges.some((e) => e.kind === "meeting_run")).toBe(false);
  });

  it("stops deriving when the meeting_run kind is toggled off", () => {
    const kinds = defaultEdgeKinds();
    kinds.delete("meeting_run");
    const m = model({ edgeKinds: kinds });
    expect(m.edges.some((e) => e.kind === "meeting_run")).toBe(false);
    // Direct meeting/execution edges are untouched by the derived-kind toggle.
    expect(m.edges.some((e) => e.kind === "meeting")).toBe(true);
    expect(m.edges.some((e) => e.kind === "execution")).toBe(true);
  });

  it("builds the child map from surviving child edges only", () => {
    const m = model();
    expect(m.children.get("n1")).toEqual(["n2"]);
    expect(m.children.get("n2")).toEqual(["n3"]);
    // n3's child edge to n9 was dropped (dangling), so n3 never becomes a
    // key; collectSubtree treats a missing key as "no children".
    expect(m.children.has("n3")).toBe(false);
    expect(m.children.get("n3")).toBeUndefined();
  });

  it("counts degrees undirected", () => {
    const m = model();
    expect(m.degree.get("n2")).toBe(3); // child to n1, child to n3, blocks n4
    expect(m.degree.get("n5")).toBe(1); // its review meeting m3
  });
});

describe("collectSubtree", () => {
  it("collects every descendant, excluding the root", () => {
    const m = model();
    expect(collectSubtree("n1", m.children)).toEqual(new Set(["n2", "n3"]));
    expect(collectSubtree("n5", m.children)).toEqual(new Set());
  });

  it("survives a malformed cycle in the child map", () => {
    const children = new Map([
      ["a", ["b"]],
      ["b", ["a"]],
    ]);
    expect(collectSubtree("a", children)).toEqual(new Set(["b", "a"]));
  });
});

describe("focusNodeIds", () => {
  it("returns only the node at depth 0", () => {
    const m = model();
    expect(focusNodeIds(m, "n4", 0)).toEqual(new Set(["n4"]));
  });

  it("expands one hop at depth 1 and two at depth 2", () => {
    const m = model();
    // n4's own run is one hop out, exactly like its blocking issue.
    expect(focusNodeIds(m, "n4", 1)).toEqual(new Set(["n4", "n2", "run:r2"]));
    expect(focusNodeIds(m, "n4", 2)).toEqual(new Set(["n4", "n2", "run:r2", "n1", "n3"]));
  });

  it("expands across entity types from a meeting", () => {
    const m = model();
    expect(focusNodeIds(m, "mtg:m1", 1)).toEqual(new Set(["mtg:m1", "n1", "n3", "run:r1"]));
  });
});

describe("matchesQuery", () => {
  const node = graph.nodes[0]!;
  it("matches identifier and title case-insensitively", () => {
    expect(matchesQuery(node, "tes-1")).toBe(true);
    expect(matchesQuery(node, "alpha")).toBe(true);
    expect(matchesQuery(node, "ALPHA")).toBe(true);
  });
  it("does not match an empty query", () => {
    expect(matchesQuery(node, "")).toBe(false);
    expect(matchesQuery(node, "   ")).toBe(false);
  });
  it("rejects non-matching text", () => {
    expect(matchesQuery(node, "omega")).toBe(false);
  });
});

describe("projectColorIndex", () => {
  it("maps sorted project ids to palette buckets and null to the muted bucket", () => {
    const ids = ["pB", "pA"];
    expect(projectColorIndex("pA", ids)).toBe(0);
    expect(projectColorIndex("pB", ids)).toBe(1);
    expect(projectColorIndex(null, ids)).toBe(2);
    expect(projectColorIndex("missing", ids)).toBe(2);
  });
});

describe("nodeRadius", () => {
  it("grows with sqrt of degree from a base radius", () => {
    expect(nodeRadius(0)).toBe(4);
    expect(nodeRadius(4)).toBe(8);
    expect(nodeRadius(1)).toBe(6);
  });
});
