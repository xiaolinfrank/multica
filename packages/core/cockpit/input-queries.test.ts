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
