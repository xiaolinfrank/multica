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
  ],
};

function model(
  overrides?: Partial<{ projects: Set<string> | null; statuses: Set<string> | null; edgeKinds: Set<string> }>,
) {
  return buildGraphModel(graph, {
    projects: overrides?.projects ?? null,
    statuses: overrides?.statuses ?? null,
    edgeKinds: (overrides?.edgeKinds ?? defaultEdgeKinds()) as Set<GraphEdgeKind>,
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
    ]);
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
    expect(onlyP1.edges.map((e) => `${e.source}>${e.target}`)).toEqual(["n1>n2"]);

    const p1PlusNoProject = model({ projects: new Set(["p1", ""]) });
    expect(p1PlusNoProject.nodes.map((n) => n.id)).toEqual(["n1", "n2", "n5"]);
  });

  it("filters nodes by status category and recomputes degrees", () => {
    const todoOnly = model({ statuses: new Set(["todo"]) });
    expect(todoOnly.nodes.map((n) => n.id)).toEqual(["n1", "n3", "n4"]);
    expect(todoOnly.degree.get("n1")).toBe(1); // n1-n3 mention survives
    expect(todoOnly.neighbors.get("n1")).toEqual(new Set(["n3"]));
  });

  it("honors edge-kind toggles", () => {
    const kinds = defaultEdgeKinds();
    kinds.delete("mention");
    const m = model({ edgeKinds: kinds });
    expect(m.edges.some((e) => e.kind === "mention")).toBe(false);
    expect(m.edges).toHaveLength(3);
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
    expect(m.degree.get("n5")).toBe(0);
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
    expect(focusNodeIds(m, "n4", 1)).toEqual(new Set(["n4", "n2"]));
    expect(focusNodeIds(m, "n4", 2)).toEqual(new Set(["n4", "n2", "n1", "n3"]));
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
