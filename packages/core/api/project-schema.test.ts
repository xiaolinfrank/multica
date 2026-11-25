// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ModuleSchema, ProjectSchema } from "./schemas";
import { CockpitScopeItemPageSchema } from "./cockpit-read-schemas";

const project = {
  id: "project", workspace_id: "workspace", title: "Project", description: null,
  icon: null, status: "planned", priority: "none", lead_type: null, lead_id: null,
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
};

describe("project creator response compatibility", () => {
  it.each([{}, { creator_type: null, creator_id: null }, { creator_type: 42, creator_id: {} }])("defaults missing or malformed metadata: %j", (creator) => {
    const parsed = ProjectSchema.parse({ ...project, ...creator });
    expect(parsed.id).toBe("project");
    expect(parsed.creator_type).toBeNull();
    expect(parsed.creator_id).toBeNull();
  });
  it("preserves creators and unknown future types without granting rights", () => {
    for (const type of ["member", "agent", "future"]) {
      const parsed = ProjectSchema.parse({ ...project, creator_type: type, creator_id: "creator" });
      expect(parsed.creator_type).toBe(type);
      expect(parsed.creator_id).toBe("creator");
    }
  });
  it("accepts optional/malformed plan codes on projects, modules, and scope items", () => {
    expect(ProjectSchema.parse(project).code).toBeNull();
    expect(ProjectSchema.parse({ ...project, code: "01" }).code).toBe("01");
    expect(ProjectSchema.parse({ ...project, code: 123 }).code).toBeNull();

    const baseModule = {
      id: "m1", workspace_id: "workspace", project_id: "project", title: "Module",
      description: null, position: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    };
    expect(ModuleSchema.parse(baseModule).code).toBeNull();
    expect(ModuleSchema.parse({ ...baseModule, code: "01.01" }).code).toBe("01.01");
    expect(ModuleSchema.parse({ ...baseModule, code: 42 }).code).toBeNull();

    const page = CockpitScopeItemPageSchema.parse({
      workspace_id: "ws-1",
      project_id: null,
      total: 2,
      next_cursor: null,
      items: [
        { id: "p1", code: "01", title: "Alpha", project_id: null },
        { id: "p2", title: "Beta", project_id: null },
      ],
    });
    expect(page.items[0]?.code).toBe("01");
    expect(page.items[1]?.code).toBeUndefined();
  });
});
