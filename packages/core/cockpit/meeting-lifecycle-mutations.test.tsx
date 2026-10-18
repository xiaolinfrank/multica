// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { CockpitLifecycleCommandResult, CockpitMeetingLifecycleHeader } from "../types/cockpit-meeting-lifecycle";
import { cockpitLifecycleKeys, cockpitMeetingLifecycleOptions } from "./meeting-lifecycle-queries";
import { useCockpitMaterialsConfirmation } from "./meeting-lifecycle-mutations";

vi.mock("../api", () => ({ api: { confirmCockpitMaterials: vi.fn(), getCockpitMeetingLifecycle: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function header(wsId = "ws-1", lifecycleRevision = 1): CockpitMeetingLifecycleHeader {
  return { workspace_id: wsId, meeting_id: "meeting-1", lifecycle_revision: lifecycleRevision,
    generated_at: "2026-10-11T00:00:00Z", occurrence: { state: "unconfirmed", started_confirmed_at: null, started_confirmed_by: null,
      ended_at: null, ended_by: null, ended_source: null, actual_started_at: null, actual_ended_at: null },
    materials: { workflow_revision: 1, ready: false, confirmed_at: null, confirmed_by: null, released: false }, workflow_enabled: true,
    can_schedule: true, can_end: true, can_correct_times: false, can_confirm_materials: true, can_reopen: false, can_unschedule: false, blocked_reasons: [] };
}
function receipt(): CockpitLifecycleCommandResult {
  return { workspace_id: "ws-1", meeting_id: "meeting-1", command_key: "019f06d9-3020-7000-8000-000000000003", action: "materials", replayed: true,
    current: header("ws-1", 2), receipt: { revision: 1, issue_id: null,
      request_hash: "a".repeat(64), reason: "", previous_occurrence: null, occurrence: null,
      materials: { workflow_revision: 1, ready: true, confirmed_at: null, confirmed_by: null, released: false } } };
}
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) { return <QueryClientProvider client={client}>{children}</QueryClientProvider>; }
  return { client, wrapper: Wrapper };
}

describe("meeting command reconciliation", () => {
  it.each([true, false])("reads again after a confirmed write even if a read started before the write is still pending (cached: %s)", async (cached) => {
    const { client, wrapper } = setup();
    const key = cockpitLifecycleKeys.header("ws-1", "meeting-1");
    if (cached) client.setQueryData(key, header());
    let finishOld!: (value: CockpitMeetingLifecycleHeader) => void;
    vi.mocked(api.getCockpitMeetingLifecycle).mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; })).mockResolvedValue(header("ws-1", 2));
    vi.mocked(api.confirmCockpitMaterials).mockResolvedValue(receipt());
    const { result } = renderHook(() => ({ read: useQuery(cockpitMeetingLifecycleOptions("ws-1", "meeting-1")), write: useCockpitMaterialsConfirmation("ws-1", "meeting-1") }), { wrapper });
    await waitFor(() => expect(api.getCockpitMeetingLifecycle).toHaveBeenCalledTimes(1));
    await act(async () => { await result.current.write.mutateAsync({ command_key: receipt().command_key, expected_revision: 1, materials_ready: true }); });
    await waitFor(() => expect(api.getCockpitMeetingLifecycle).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.read.data?.lifecycle_revision).toBe(2));
    await act(async () => { finishOld(header()); await Promise.resolve(); });
    expect(client.getQueryData<CockpitMeetingLifecycleHeader>(key)?.lifecycle_revision).toBe(2);
    client.clear();
  });
  it("keeps a newer current header when an old exact command is replayed", async () => {
    const { client, wrapper } = setup();
    const newer = header("ws-1", 20), key = cockpitLifecycleKeys.header("ws-1", "meeting-1");
    client.setQueryData(key, newer);
    vi.mocked(api.confirmCockpitMaterials).mockResolvedValue(receipt());
    const { result } = renderHook(() => useCockpitMaterialsConfirmation("ws-1", "meeting-1"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ command_key: receipt().command_key, expected_revision: 1, materials_ready: true }); });
    expect(client.getQueryData(key)).toBe(newer);
    await waitFor(() => expect(client.getQueryState(key)?.isInvalidated).toBe(true));
    client.clear();
  });

  it("settles only the captured workspace after the same component switches routes", async () => {
    const { client, wrapper } = setup();
    const oldKey = cockpitLifecycleKeys.header("ws-1", "meeting-1"), newKey = cockpitLifecycleKeys.header("ws-2", "meeting-1");
    client.setQueryData(oldKey, header()); client.setQueryData(newKey, header("ws-2"));
    let resolve!: (value: CockpitLifecycleCommandResult) => void;
    vi.mocked(api.confirmCockpitMaterials).mockReturnValue(new Promise((done) => { resolve = done; }));
    const { result, rerender } = renderHook(({ wsId }) => useCockpitMaterialsConfirmation(wsId, "meeting-1"), { wrapper, initialProps: { wsId: "ws-1" } });
    let operation!: Promise<CockpitLifecycleCommandResult>;
    await act(async () => { operation = result.current.mutateAsync({ command_key: receipt().command_key, expected_revision: 1, materials_ready: true }); await Promise.resolve(); });
    rerender({ wsId: "ws-2" });
    await act(async () => { resolve(receipt()); await operation; });
    expect(api.confirmCockpitMaterials).toHaveBeenCalledWith("ws-1", "meeting-1", expect.any(Object));
    await waitFor(() => expect(client.getQueryState(oldKey)?.isInvalidated).toBe(true));
    expect(client.getQueryState(newKey)?.isInvalidated).toBe(false);
    client.clear();
  });
});
