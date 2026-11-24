import { describe, expect, it } from "vitest";
import {
  DirectoryFillResultSchema, IssueDirectoryEnsureResultSchema, IssueDirectoryStatusSchema,
  NodeDirectorySyncResponseSchema, PlanDirectoryListSchema, PlanDirectoryStatusSchema,
  RunningAgentTasksRefusalSchema,
} from "./directory-schemas";

describe("directory response schemas", () => {
  it("keeps a readable status while dropping fields of the wrong type", () => {
    const parsed = PlanDirectoryStatusSchema.parse({
      node_id: "n1", kind: "work_item", project_id: "p1",
      project_collab_path: "/Volumes/Space", directory_name: "01.01确权线",
      expected_directory_name: "01.01确权线", full_path: "/Volumes/Space/01.01确权线",
      status: "ok",
      running_tasks: [{ task_id: "t1", issue_id: "i1", issue_identifier: "TES-1", status: "running" }],
      shared_collab_projects: [],
      // A newer server field the client does not know yet.
      future_field: true,
    });
    expect(parsed.status).toBe("ok");
    expect(parsed.running_tasks[0]!.issue_identifier).toBe("TES-1");
  });

  it("reads Go's nil slices as empty lists, not as a failed status", () => {
    // A module with no collaboration root answers `shared_collab_projects: null`
    // (Go's nil slice). Treating that as invalid would hide a path that is
    // actually fine.
    const parsed = PlanDirectoryStatusSchema.parse({ node_id: "n1", kind: "module", status: "no_collab_path", shared_collab_projects: null, running_tasks: null });
    expect(parsed.status).toBe("no_collab_path");
    expect(parsed.shared_collab_projects).toEqual([]);
    expect(PlanDirectoryListSchema.parse({ items: null }).items).toEqual([]);
  });

  it("degrades an unknown kind and a mistyped path instead of failing the panel", () => {
    const parsed = PlanDirectoryStatusSchema.parse({
      node_id: "n1", kind: "mystery", status: "ok",
      project_collab_path: 42, directory_name: { nested: true },
      expected_directory_name: null, full_path: null,
    });
    expect(parsed.kind).toBe("work_item");
    expect(parsed.project_collab_path).toBeNull();
    expect(parsed.directory_name).toBeNull();
    expect(parsed.running_tasks).toEqual([]);
  });

  it("accepts an empty list body and fills missing arrays", () => {
    expect(PlanDirectoryListSchema.parse({}).items).toEqual([]);
    const fill = DirectoryFillResultSchema.parse({ applied: true, counts: { create: 2 } });
    expect(fill.items).toEqual([]);
    expect(fill.counts.create).toBe(2);
    expect(fill.shared_collab_projects).toEqual([]);
  });

  it("treats a malformed sync result as failed rather than half-applied", () => {
    expect(NodeDirectorySyncResponseSchema.parse({ directory_sync: { status: "renamed" } }).directory_sync.status).toBe("renamed");
    expect(NodeDirectorySyncResponseSchema.parse({}).directory_sync.status).toBe("failed");
  });

  it("reads an issue folder that was never allocated", () => {
    const parsed = IssueDirectoryStatusSchema.parse({ issue_id: "i1", status: "unallocated" });
    expect(parsed.status).toBe("unallocated");
    expect(parsed.directory_name).toBeNull();
    expect(parsed.full_path).toBeNull();
  });

  it("requires the running-tasks refusal to name itself", () => {
    expect(RunningAgentTasksRefusalSchema.safeParse({ code: "running_agent_tasks", running_tasks: [] }).success).toBe(true);
    expect(RunningAgentTasksRefusalSchema.safeParse({ code: "something_else" }).success).toBe(false);
    expect(IssueDirectoryEnsureResultSchema.parse({ status: "missing", exists: false }).exists).toBe(false);
  });
});
