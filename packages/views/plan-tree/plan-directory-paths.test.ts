// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { CockpitNode } from "@multica/core/types";
import { planDirectoryPaths } from "./plan-directory-paths";

const node = (over: Partial<CockpitNode> & { id: string; code: string }): CockpitNode => ({
  cockpit_id: "cp", parent_id: null, name: over.code, position: 0, color: "", owner: "",
  collaborators: "", start_date: null, end_date: null, status: "", progress: 0, deliverable: "",
  dependencies: "", note: "", current_progress: "", vendor: "", budget_category: "", budget_amount: null,
  exec_status: "", contract: "", source: "", updated_by_type: "", updated_by_id: null,
  created_at: "", updated_at: "",
  ...over,
});

describe("planDirectoryPaths", () => {
  const project = node({ id: "p", code: "01", project_id: "proj-1", directory_name: null });
  const module = node({ id: "m", code: "01.01", parent_id: "p", module_id: "mod-1", directory_name: "01.01确权线" });
  const item = node({ id: "w", code: "01.01.01", parent_id: "m", directory_name: "01.01.01接口设计" });
  const collab = new Map([["proj-1", "/Volumes/Space/交付项目/"]]);

  it("composes a module's folder and a work item's folder", () => {
    const paths = planDirectoryPaths([project, module, item], collab);
    expect(paths.get("m")).toBe("/Volumes/Space/交付项目/01.01确权线");
    expect(paths.get("w")).toBe("/Volumes/Space/交付项目/01.01确权线/01.01.01接口设计");
    expect(paths.has("p")).toBe(false);
  });

  it("omits rows with no collaboration root, no module folder or no own folder", () => {
    expect(planDirectoryPaths([project, module, item], new Map()).size).toBe(0);
    const noModuleDir = node({ ...module, directory_name: null });
    expect(planDirectoryPaths([project, noModuleDir, item], collab).has("m")).toBe(false);
    const noItemDir = node({ ...item, directory_name: null });
    expect(planDirectoryPaths([project, module, noItemDir], collab).has("w")).toBe(false);
  });

  it("stops on a malformed parent cycle instead of looping", () => {
    const a = node({ id: "a", code: "01", parent_id: "b", directory_name: "A" });
    const b = node({ id: "b", code: "02", parent_id: "a", directory_name: "B" });
    expect(planDirectoryPaths([a, b], collab).size).toBe(0);
  });
});
