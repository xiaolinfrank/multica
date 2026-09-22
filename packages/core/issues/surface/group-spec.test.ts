// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { IssueTableQuerySpec } from "../../types";
import {
  issueTableCompoundCatalogsModules,
  issueTableModuleGroupSpec,
} from "./group-spec";

function query(
  overrides: Partial<IssueTableQuerySpec> = {},
): IssueTableQuerySpec {
  return {
    scope: { kind: "workspace" },
    filters: {},
    sort: { field: "position", direction: "asc" },
    ...overrides,
  };
}

describe("issueTableModuleGroupSpec", () => {
  it("asks for the project's empty modules on a project page", () => {
    expect(
      issueTableModuleGroupSpec(
        query({ scope: { kind: "project", project_id: "p1" } }),
      ),
    ).toEqual({ kind: "module", include_empty: true });
  });

  it("asks for them when the projects filter names one", () => {
    expect(
      issueTableModuleGroupSpec(query({ filters: { project_ids: ["p1"] } })),
    ).toEqual({ kind: "module", include_empty: true });
  });

  it("leaves a workspace-wide query grouping by the modules that hold work", () => {
    expect(issueTableModuleGroupSpec(query())).toEqual({ kind: "module" });
    expect(
      issueTableModuleGroupSpec(query({ filters: { project_ids: [] } })),
    ).toEqual({ kind: "module" });
  });
});

describe("issueTableCompoundCatalogsModules", () => {
  const inProject = query({ scope: { kind: "project", project_id: "p1" } });

  it("catalogs modules for the module lane axis inside a project", () => {
    expect(issueTableCompoundCatalogsModules("module", inProject)).toBe(true);
  });

  it("leaves every other lane axis derived from cards", () => {
    for (const primary of ["parent", "project", "assignee"]) {
      expect(issueTableCompoundCatalogsModules(primary, inProject)).toBe(false);
    }
  });

  it("needs a project to bound the catalog", () => {
    expect(issueTableCompoundCatalogsModules("module", query())).toBe(false);
  });
});
