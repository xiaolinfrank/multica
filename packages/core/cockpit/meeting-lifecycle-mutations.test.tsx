// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { CockpitLifecycleCommandResult, CockpitMeetingLifecycleHeader } from "../types/cockpit-meeting-lifecycle";
import { cockpitLifecycleKeys, cockpitMeetingLifecycleOptions } from "./meeting-lifecycle-queries";
import { useCreateCockpitAgenda } from "./meeting-lifecycle-mutations";

vi.mock("../api", () => ({ api: { createCockpitAgenda: vi.fn(), getCockpitMeetingLifecycle: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function header(wsId = "ws-1", agendaRevision = 1): CockpitMeetingLifecycleHeader {
  return { workspace_id: wsId, meeting_id: "meeting-1", lifecycle_revision: 1, agenda_revision: agendaRevision,
    generated_at: "2026-10-11T00:00:00Z", occurrence: { state: "unconfirmed", started_confirmed_at: null, started_confirmed_by: null,
      ended_at: null, ended_by: null, ended_source: null, actual_started_at: null, actual_ended_at: null },
    materials: null, workflow_enabled: false, agenda_total: agendaRevision - 1,
    can_schedule: true, can_end: true, can_correct_times: false, can_edit_agenda: true, can_confirm_materials: false, can_reopen: false, can_unschedule: false, blocked_reasons: [] };
}
function receipt(): CockpitLifecycleCommandResult {
  return { workspace_id: "ws-1", meeting_id: "meeting-1", command_key: "019f06d9-3020-7000-8000-000000000003", action: "agenda_create", replayed: true,
    current: header("ws-1", 2), receipt: { revision: 1, agenda_revision: 2, agenda_id: "agenda-1", reference_id: null, issue_id: null,
      request_hash: "a".repeat(64), reason: "", previous_occurrence: null, occurrence: null, materials: null, reference: null,
      agenda: { id: "agenda-1", workspace_id: "ws-1", meeting_id: "meeting-1", revision: 1, title: "Earlier topic", purposes: [],
        desired_outcome: "", notes: "", sort_order: 1, facilitator_user_id: null, facilitator_name: "", node_id: null, node_code: "", node_title: "",
        reference_count: 0, created_at: "2026-10-11T00:00:00Z", updated_at: "2026-10-11T00:00:00Z", removed_at: null, can_edit: true, can_remove: true } } };
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
    vi.mocked(api.createCockpitAgenda).mockResolvedValue(receipt());
    const { result } = renderHook(() => ({ read: useQuery(cockpitMeetingLifecycleOptions("ws-1", "meeting-1")), write: useCreateCockpitAgenda("ws-1", "meeting-1") }), { wrapper });
    await waitFor(() => expect(api.getCockpitMeetingLifecycle).toHaveBeenCalledTimes(1));
    await act(async () => { await result.current.write.mutateAsync({ command_key: receipt().command_key, expected_revision: 1, title: "Earlier topic" }); });
    await waitFor(() => expect(api.getCockpitMeetingLifecycle).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.read.data?.agenda_revision).toBe(2));
    await act(async () => { finishOld(header()); await Promise.resolve(); });
    expect(client.getQueryData<CockpitMeetingLifecycleHeader>(key)?.agenda_revision).toBe(2);
    client.clear();
  });
  it("keeps a newer current header when an old exact command is replayed", async () => {
    const { client, wrapper } = setup();
    const newer = header("ws-1", 20), key = cockpitLifecycleKeys.header("ws-1", "meeting-1");
    client.setQueryData(key, newer);
    vi.mocked(api.createCockpitAgenda).mockResolvedValue(receipt());
    const { result } = renderHook(() => useCreateCockpitAgenda("ws-1", "meeting-1"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ command_key: receipt().command_key, expected_revision: 1, title: "Earlier topic" }); });
    expect(client.getQueryData(key)).toBe(newer);
    await waitFor(() => expect(client.getQueryState(key)?.isInvalidated).toBe(true));
    client.clear();
  });

  it("settles only the captured workspace after the same component switches routes", async () => {
    const { client, wrapper } = setup();
    const oldKey = cockpitLifecycleKeys.header("ws-1", "meeting-1"), newKey = cockpitLifecycleKeys.header("ws-2", "meeting-1");
    client.setQueryData(oldKey, header()); client.setQueryData(newKey, header("ws-2"));
    let resolve!: (value: CockpitLifecycleCommandResult) => void;
    vi.mocked(api.createCockpitAgenda).mockReturnValue(new Promise((done) => { resolve = done; }));
    const { result, rerender } = renderHook(({ wsId }) => useCreateCockpitAgenda(wsId, "meeting-1"), { wrapper, initialProps: { wsId: "ws-1" } });
    let operation!: Promise<CockpitLifecycleCommandResult>;
    await act(async () => { operation = result.current.mutateAsync({ command_key: receipt().command_key, expected_revision: 1, title: "Earlier topic" }); await Promise.resolve(); });
    rerender({ wsId: "ws-2" });
    await act(async () => { resolve(receipt()); await operation; });
    expect(api.createCockpitAgenda).toHaveBeenCalledWith("ws-1", "meeting-1", expect.any(Object));
    await waitFor(() => expect(client.getQueryState(oldKey)?.isInvalidated).toBe(true));
    expect(client.getQueryState(newKey)?.isInvalidated).toBe(false);
    client.clear();
  });
});
