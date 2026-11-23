// @vitest-environment node
import { describe, expect, it } from "vitest";
import { seedIssueScope } from "./seed-issue-scope";

const draft = {
  projectId: "draft-project",
  moduleId: "draft-module",
  workItemId: "draft-work-item",
};

const emptyDraft = { projectId: undefined, moduleId: undefined, workItemId: undefined };

describe("seedIssueScope", () => {
  // The caller's filing wins in full. A level the caller left out is empty,
  // never borrowed from the draft: a draft remembers rows from another visit,
  // and mixing the two files the issue under a pair neither side chose.
  it("takes only the project when the caller names only the project", () => {
    expect(seedIssueScope({ project_id: "p1" }, draft)).toEqual({
      project_id: "p1",
      module_id: null,
      work_item_id: null,
    });
  });

  it("takes project and module, and leaves the work item unfiled", () => {
    expect(seedIssueScope({ project_id: "p1", module_id: "m1" }, draft)).toEqual({
      project_id: "p1",
      module_id: "m1",
      work_item_id: null,
    });
  });

  it("takes all three levels when the caller names all three", () => {
    expect(
      seedIssueScope({ project_id: "p1", module_id: "m1", work_item_id: "w1" }, draft),
    ).toEqual({ project_id: "p1", module_id: "m1", work_item_id: "w1" });
  });

  // The server derives the project from the module when only the module is
  // given, so this stays a legal state — and it must stay a *module-only*
  // state, not the draft's project with the caller's module on top.
  it("lets a module stand alone rather than borrowing the draft's project", () => {
    expect(seedIssueScope({ module_id: "m1" }, draft)).toEqual({
      project_id: null,
      module_id: "m1",
      work_item_id: null,
    });
  });

  // `project_id: null` is the caller saying "no project", which is not the
  // same as not saying anything.
  it("reads an explicit null as a named level, and drops the deeper ones", () => {
    expect(seedIssueScope({ project_id: null }, draft)).toEqual({
      project_id: null,
      module_id: null,
      work_item_id: null,
    });
  });

  it("takes the whole draft when the caller names nothing", () => {
    expect(seedIssueScope({}, draft)).toEqual({
      project_id: "draft-project",
      module_id: "draft-module",
      work_item_id: "draft-work-item",
    });
    expect(seedIssueScope(undefined, draft)).toEqual({
      project_id: "draft-project",
      module_id: "draft-module",
      work_item_id: "draft-work-item",
    });
  });

  it("answers an empty filing when neither side names a level", () => {
    expect(seedIssueScope(undefined, emptyDraft)).toEqual({
      project_id: null,
      module_id: null,
      work_item_id: null,
    });
  });

  // A caller's empty string is a named-but-cleared level, not a fallback.
  it("treats an empty string as cleared rather than missing", () => {
    expect(seedIssueScope({ project_id: "", module_id: "m1" }, draft)).toEqual({
      project_id: null,
      module_id: "m1",
      work_item_id: null,
    });
  });
});
