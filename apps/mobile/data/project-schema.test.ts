import { describe, expect, it } from "vitest";
import {
  EMPTY_PROJECT,
  ListProjectsResponseSchema,
  ProjectSchema,
} from "./schemas";

/**
 * Tests for mobile's CLIENT-SIDE parsing of the project payload, focused on
 * `collab_path` (人机协作空间路径).
 *
 * Scope, stated the same way as data/inbox-schema.test.ts: these are
 * hand-written fixtures run against mobile's own schema. They pin how this
 * client reacts to a payload; no server code runs here.
 *
 * Why the omitted-key case matters most: an installed build can talk to a
 * backend older than the field, and `ProjectSchema` is nested inside
 * `ListProjectsResponseSchema`. Without the `.default(null)` a single project
 * missing the key fails the array element, which fails the response, which
 * drops the entire project list to EMPTY_LIST_PROJECTS_RESPONSE — the whole
 * screen empties, not one row.
 */

const SERVER_PROJECT = {
  id: "project-1",
  workspace_id: "ws-1",
  title: "AI医药联合创新平台",
  description: null,
  icon: null,
  status: "in_progress",
  priority: "high",
  lead_type: "member",
  lead_id: "user-1",
  start_date: null,
  due_date: null,
  collab_path:
    "/Volumes/人机协作空间/AI医药联合创新平台/01高质量数据集/01.01回顾性队列数据集（JIA）",
  created_at: "2026-09-20T00:00:00Z",
  updated_at: "2026-09-20T00:00:00Z",
  issue_count: 3,
  done_count: 1,
  resource_count: 0,
};

describe("project schema collab_path", () => {
  it("keeps the path a current backend sends", () => {
    const parsed = ProjectSchema.safeParse(SERVER_PROJECT);

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.collab_path).toBe(
      SERVER_PROJECT.collab_path,
    );
  });

  it("keeps an explicit null (project with no path bound)", () => {
    const parsed = ProjectSchema.safeParse({
      ...SERVER_PROJECT,
      collab_path: null,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.collab_path).toBeNull();
  });

  it("defaults to null when an older backend omits the key", () => {
    const { collab_path: _omitted, ...withoutKey } = SERVER_PROJECT;

    const parsed = ProjectSchema.safeParse(withoutKey);

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.collab_path).toBeNull();
  });

  it("does not drop the whole list when one project omits the key", () => {
    const { collab_path: _omitted, ...withoutKey } = SERVER_PROJECT;

    const parsed = ListProjectsResponseSchema.safeParse({
      projects: [SERVER_PROJECT, { ...withoutKey, id: "project-2" }],
      total: 2,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.projects).toHaveLength(2);
    expect(parsed.success && parsed.data.projects[1]?.collab_path).toBeNull();
  });

  it("gives the drift fallback a path field so consumers never read undefined", () => {
    expect(EMPTY_PROJECT.collab_path).toBeNull();
  });
});
