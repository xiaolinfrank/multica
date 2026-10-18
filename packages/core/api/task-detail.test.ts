// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";

afterEach(() => vi.unstubAllGlobals());

describe("exact task reads", () => {
  it("keeps a fixed input pointer and unknown preparation state without treating old runs as prepared", async () => {
    const manifestId = "10000000-0000-4000-8000-000000000001";
    const base = { id: "run-1", workspace_id: "ws-1", agent_id: "agent-1", status: "queued" };
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ ...base, input_manifest_version_id: manifestId, input_preparation_state: "future_state" }))
      .mockResolvedValueOnce(Response.json(base));
    vi.stubGlobal("fetch", fetch);
    const api = new ApiClient("https://example.test");
    expect(await api.getTask("ws-1", "run-1")).toMatchObject({ input_manifest_version_id: manifestId, input_preparation_state: "future_state" });
    expect(await api.getTask("ws-1", "run-1")).toMatchObject({ input_manifest_version_id: null, input_preparation_state: "not_recorded" });
  });
  it("reads a single task in the explicit workspace without loading Issue history", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "run-1", workspace_id: "ws-1", agent_id: "agent-1", status: "completed" })));
    vi.stubGlobal("fetch", fetch);
    const api = new ApiClient("https://example.test");
    expect(await api.getTask("ws-1", "run-1")).toMatchObject({ id: "run-1", status: "completed" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0]!;
    expect(url).toBe("https://example.test/api/tasks/run-1");
    expect(new Headers(options.headers).get("X-Workspace-ID")).toBe("ws-1");
  });

  it.each([
    { id: "another-run", workspace_id: "ws-1", agent_id: "agent-1", status: "completed" },
    { id: "run-1", workspace_id: "another-workspace", agent_id: "agent-1", status: "completed" },
    { id: "run-1", agent_id: "agent-1", status: "completed" },
    { id: "run-1", workspace_id: "ws-1", agent_id: "agent-1" },
  ])("does not fabricate a task from an ambiguous response %#", async (response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(response))));
    expect(await new ApiClient("https://example.test").getTask("ws-1", "run-1")).toBeNull();
  });
});


it("starts a new Run only with the observed fixed input manifest and keeps historical retries separate", async () => {
  const manifestId = "10000000-0000-4000-8000-000000000001";
  const task = { id: "run-2", workspace_id: "ws-1", issue_id: "issue-1", agent_id: "agent-1", status: "queued", input_manifest_version_id: manifestId };
  const fetcher = vi.fn().mockImplementation(async () => Response.json(task));
  vi.stubGlobal("fetch", fetcher);
  const client = new ApiClient("https://example.test");
  expect(await client.rerunIssue("issue-1", undefined, { expectedInputManifestVersionId: manifestId })).toMatchObject({ id: "run-2", input_manifest_version_id: manifestId });
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ expected_input_manifest_version_id: manifestId });
  await expect(client.rerunIssue("issue-1", "old-run", { expectedInputManifestVersionId: manifestId })).rejects.toThrow("historical Run");
  expect(fetcher).toHaveBeenCalledTimes(1);
  await client.rerunIssue("issue-1", "old-run");
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({ task_id: "old-run" });
});

it("does not confirm a new Run whose response lost the selected material version", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ id: "run-2", agent_id: "agent-1", status: "queued" })));
  await expect(new ApiClient("https://example.test").rerunIssue("issue-1", undefined, { expectedInputManifestVersionId: "10000000-0000-4000-8000-000000000001" })).rejects.toThrow("Invalid task rerun response");
});
