import { describe, expect, it } from "vitest";
import { scopePatch } from "./issue-scope-property";

const filed = { project_id: "proj-a", module_id: "mod-a", work_item_id: "node-a" };

describe("scopePatch", () => {
  it("returns nothing when the filing did not move", () => {
    expect(scopePatch(filed, { ...filed })).toBeNull();
  });

  it("names only the work item — it supplies its module and project", () => {
    expect(scopePatch(filed, { project_id: "proj-b", module_id: "mod-b", work_item_id: "node-b" }))
      .toEqual({ work_item_id: "node-b" });
  });

  it("keeps the module when the work item is dropped in its favour", () => {
    expect(scopePatch(filed, { project_id: "proj-a", module_id: "mod-a", work_item_id: null }))
      .toEqual({ work_item_id: null });
  });

  it("moves project and module together, and unfiles the work item", () => {
    expect(scopePatch(filed, { project_id: "proj-b", module_id: "mod-b", work_item_id: null }))
      .toEqual({ work_item_id: null, module_id: "mod-b", project_id: "proj-b" });
  });

  it("clears all three when the filing is cleared", () => {
    expect(scopePatch(filed, { project_id: null, module_id: null, work_item_id: null }))
      .toEqual({ work_item_id: null, module_id: null, project_id: null });
  });

  it("takes an issue with no filing to a project without inventing a module", () => {
    const unfiled = { project_id: null, module_id: null, work_item_id: null };
    expect(scopePatch(unfiled, { project_id: "proj-a", module_id: null, work_item_id: null }))
      .toEqual({ project_id: "proj-a" });
  });
});
