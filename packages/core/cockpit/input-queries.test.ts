// @vitest-environment node
import { QueryClient } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { cockpitInputKeys, invalidateCockpitInputs } from "./input-queries";
import { onCockpitChanged } from "./ws-updaters";
import { cockpitInputContextPath } from "./navigation";

it("refreshes input progress without changing selected NAS observations, other workspaces, or fixed Run facts", async () => {
  const client = new QueryClient();
  const selected = cockpitInputKeys.input("workspace", "input");
  const run = cockpitInputKeys.run("workspace", "run");
  const browse = [...cockpitInputKeys.browse("workspace"), "entries", "root", { cursor: "original" }];
  const other = cockpitInputKeys.input("other-workspace", "input");
  for (const key of [selected, run, browse, other]) client.setQueryData(key, { versionId: "original-fixed-version" });
  onCockpitChanged(client, "workspace", { scope: "inputs", action: "updated", entity: { version_id: "different-version" } });
  await vi.waitFor(() => expect(client.getQueryState(selected)?.isInvalidated).toBe(true));
  expect(client.getQueryState(run)?.isInvalidated).toBe(true);
  for (const key of [browse, other]) expect(client.getQueryState(key)?.isInvalidated).toBe(false);
  expect(client.getQueryData(run)).toEqual({ versionId: "original-fixed-version" });
  client.clear();
});

it("cancels an old first read before accepting newer progress", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const key = cockpitInputKeys.input("workspace", "input");
  let resolveOld!: (value: string) => void;
  let reads = 0;
  const options = { queryKey: key, queryFn: ({ signal }: { signal: AbortSignal }) => {
    void signal.aborted;
    reads++;
    return reads === 1 ? new Promise<string>((resolve) => { resolveOld = resolve; }) : Promise.resolve("ready");
  } };
  const old = client.fetchQuery(options).catch(() => "cancelled");
  await invalidateCockpitInputs(client, "workspace");
  expect(await client.fetchQuery(options)).toBe("ready");
  resolveOld("awaiting_upload"); await old;
  expect(client.getQueryData(key)).toBe("ready");
  client.clear();
});

it("opens and closes an exact input version without losing the meeting and agenda return context", () => {
  const search = new URLSearchParams("project=p&meeting=m&meeting_view=resources&agenda=a&q=previous");
  const opened = cockpitInputContextPath("/workspace/cockpit", search, "input", "version");
  expect(opened).toContain("input_version=version");
  const restored = cockpitInputContextPath("/workspace/cockpit", new URL(opened, "https://example.test").searchParams, null);
  expect(restored).toBe(`/workspace/cockpit?${search}`);
});

it("restores at most 200 explicit header labels in two bounded pages and retains missing identities", async () => {
  const { ApiClient } = await import("../api/client");
  const { setApiInstance } = await import("../api");
  const { cockpitInputSelectedHeadersOptions } = await import("./input-queries");
  const ws = "10000000-0000-4000-8000-000000000001";
  const ids = Array.from({ length: 200 }, (_, i) => `20000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
  setApiInstance(new ApiClient("https://agent3.test"));
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    expect(url.searchParams.get("archive")).toBe("all");
    expect(url.searchParams.get("page_size")).toBe("100");
    expect(url.searchParams.getAll("ids")).toHaveLength(100);
    return Response.json({ workspace_id: ws, scope: { ids: url.searchParams.getAll("ids"), project_id: null, meeting_id: null, agenda_id: null, origin_issue_id: null, q: "", archive: "all", source_kind: "" },
      page_size: 100, items: [], total: 0, next_cursor: null, can_create: false });
  });
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    expect(await client.fetchQuery(cockpitInputSelectedHeadersOptions(ws, ids))).toMatchObject({ requestedIds: ids, items: [], unavailableIds: ids });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(client.fetchQuery(cockpitInputSelectedHeadersOptions(ws, [...ids, ws]))).rejects.toThrow("Invalid input header selection");
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally { client.clear(); vi.unstubAllGlobals(); }
});

it("refreshes restore and exact meeting deletion context only when input references change", async () => {
  const { cockpitReadKeys } = await import("./read-queries");
  const { cockpitPreparationKeys } = await import("./meeting-preparation-queries");
  const client = new QueryClient();
  const context = cockpitReadKeys.context("workspace", { projectId: null, moduleId: null });
  const basis = cockpitPreparationKeys.basis("workspace", "meeting-a");
  const otherBasis = cockpitPreparationKeys.basis("workspace", "meeting-b");
  const otherContext = cockpitReadKeys.context("other", { projectId: null, moduleId: null });
  const input = cockpitInputKeys.input("workspace", "input");
  for (const key of [context, basis, otherBasis, otherContext, input]) client.setQueryData(key, { existing: true });
  onCockpitChanged(client, "workspace", { scope: "inputs", action: "updated", entity: { input_id: "input" } });
  await vi.waitFor(() => expect(client.getQueryState(input)?.isInvalidated).toBe(true));
  expect(client.getQueryState(context)?.isInvalidated).toBe(false);
  expect(client.getQueryState(basis)?.isInvalidated).toBe(false);
  onCockpitChanged(client, "workspace", { scope: "inputs", action: "reference_updated", entity: { input_id: "input", meeting_id: "meeting-a" } });
  await vi.waitFor(() => expect(client.getQueryState(context)?.isInvalidated).toBe(true));
  expect(client.getQueryState(basis)?.isInvalidated).toBe(true);
  expect(client.getQueryState(otherBasis)?.isInvalidated).toBe(false);
  expect(client.getQueryState(otherContext)?.isInvalidated).toBe(false);
  client.clear();
});
