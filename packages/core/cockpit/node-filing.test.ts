// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cockpitNodeIssueFiling, resolveCockpitNodeBinding, type CockpitFilingModule } from "./node-filing";
import type { CockpitNode } from "../types";

type Node = Pick<CockpitNode, "id" | "parent_id" | "project_id" | "module_id" | "code">;
const modules: CockpitFilingModule[] = [
  { id: "module-1", project_id: "project-1", title: "Renamed module with no outline number" },
  { id: "wrong-module", project_id: "project-2", title: "01.01 Looks like a match" },
];
function tree(overrides: Partial<Record<string, Partial<Node>>> = {}) {
  const rows: Node[] = [
    { id: "root", parent_id: null, code: "L1-01", project_id: "project-1", module_id: null },
    { id: "group", parent_id: "root", code: "historical grouping", project_id: null, module_id: null },
    { id: "module", parent_id: "group", code: "old module code", project_id: "project-1", module_id: "module-1" },
    { id: "task", parent_id: "module", code: "L3-01-01", project_id: null, module_id: null },
  ];
  return new Map(rows.map((row) => [row.id, { ...row, ...overrides[row.id] }]));
}

describe("explicit cockpit node filing", () => {
  it("inherits stable UUIDs across a nonstandard grouping despite renamed or misleading codes", () => {
    const nodes = tree();
    expect(cockpitNodeIssueFiling(nodes.get("task")!, nodes, modules, "99.02.07")).toEqual({
      project_id: "project-1", module_id: "module-1", title: "99.02.07",
    });
    nodes.get("module")!.code = "renamed-again";
    expect(cockpitNodeIssueFiling(nodes.get("task")!, nodes, modules)?.module_id).toBe("module-1");
  });

  it("does not guess a binding from an exactly matching module title", () => {
    const nodes = tree({ root: { project_id: null }, module: { project_id: null, module_id: null, code: "01.01" }, task: { code: "01.01.01" } });
    expect(resolveCockpitNodeBinding(nodes.get("task")!, nodes, modules)).toEqual({ status: "unbound" });
    expect(cockpitNodeIssueFiling(nodes.get("task")!, nodes, modules)).toBeNull();
  });

  it("withholds issue creation on mapped structural rows and on project-only descendants", () => {
    const nodes = tree();
    expect(cockpitNodeIssueFiling(nodes.get("root")!, nodes, modules)).toBeNull();
    expect(cockpitNodeIssueFiling(nodes.get("module")!, nodes, modules)).toBeNull();
    expect(cockpitNodeIssueFiling(nodes.get("group")!, nodes, modules)).toBeNull();
  });

  it.each([
    { module: { module_id: "deleted-module" } },
    { module: { project_id: "project-2" } },
    { root: { project_id: "project-2" } },
    { module: { parent_id: "missing" } },
    { root: { parent_id: "task" } },
    { task: { project_id: "project-1" } },
  ])("refuses invalid ancestry or stale relationships: %o", (changes) => {
    const nodes = tree(changes);
    expect(resolveCockpitNodeBinding(nodes.get("task")!, nodes, modules).status).toBe("invalid");
    expect(cockpitNodeIssueFiling(nodes.get("task")!, nodes, modules)).toBeNull();
  });
});
