// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Issue } from "@multica/core/types";
import { moduleDetachIntent } from "./module-detach-gate";

const child = {
  id: "issue-1",
  title: "Collect samples",
  parent_issue_id: "parent-1",
  project_id: "project-1",
  module_id: "module-1",
} satisfies Pick<
  Issue,
  "id" | "title" | "parent_issue_id" | "project_id" | "module_id"
>;

const root = { ...child, parent_issue_id: null };

describe("moduleDetachIntent", () => {
  it("confirms re-filing a sub-issue into another module", () => {
    expect(moduleDetachIntent(child, { module_id: "module-2" })).toEqual({
      issueId: "issue-1",
      issueTitle: "Collect samples",
      updates: { module_id: "module-2" },
    });
  });

  it("confirms clearing a sub-issue's module", () => {
    expect(moduleDetachIntent(child, { module_id: null })).not.toBeNull();
  });

  it("confirms a project move, which takes the module with it", () => {
    expect(
      moduleDetachIntent(child, { project_id: "project-2" }),
    ).not.toBeNull();
  });

  it("stays out of the way when the filing does not change", () => {
    expect(moduleDetachIntent(child, { module_id: "module-1" })).toBeNull();
    expect(moduleDetachIntent(child, { project_id: "project-1" })).toBeNull();
    expect(moduleDetachIntent(child, { title: "Renamed" })).toBeNull();
    expect(moduleDetachIntent(child, {})).toBeNull();
  });

  it("has nothing to say about an issue with no parent", () => {
    expect(moduleDetachIntent(root, { module_id: "module-2" })).toBeNull();
    expect(moduleDetachIntent(root, { project_id: "project-2" })).toBeNull();
  });

  // The write carries both halves, so the dialog applies exactly what the user
  // asked for plus the detach — never a module move that forgot its project.
  it("carries the whole write through to the dialog", () => {
    expect(
      moduleDetachIntent(child, {
        project_id: "project-2",
        module_id: "module-9",
        position: 3,
      })?.updates,
    ).toEqual({ project_id: "project-2", module_id: "module-9", position: 3 });
  });
});
