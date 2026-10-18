import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@multica/core/api";
import { cockpitKeys, useCockpitMeetingAgendaDraftStore, cockpitMeetingAgendaDraftKey, prepareCockpitMeetingCommand } from "@multica/core/cockpit";
import type { CockpitLifecycleCommandResult } from "@multica/core/types";
import { useCockpitMeetingCommand } from "./use-cockpit-meeting-command";
import { lifecycleFixture, lifecycleResultFixture } from "./meeting-lifecycle-test-fixtures";
const navigation = vi.hoisted(() => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams("meeting=A") }));
vi.mock("../../navigation", () => ({ useNavigation: () => navigation }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { recordCockpitOccurrence: vi.fn(), getCockpitLifecycleCommand: vi.fn() } }));
function setup() { const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, ...renderHook(({ meeting }) => useCockpitMeetingCommand("ws-1", meeting, cockpitMeetingAgendaDraftKey("ws-1", meeting, "occurrence")), { initialProps: { meeting: "A" }, wrapper }) }; }
const body = { command_key: "11111111-1111-4111-8111-111111111111", expected_revision: 1, transition: "end" as const };
const resultFor = (meetingId: string, commandKey: string) => lifecycleResultFixture(lifecycleFixture({ meeting_id: meetingId, occurrence: { ...lifecycleFixture().occurrence, state: "ended", ended_at: "2026-01-01T10:00:00Z" } }), commandKey, "end", { occurrence: { ...lifecycleFixture().occurrence, state: "ended", ended_at: "2026-01-01T10:00:00Z" } });
beforeEach(() => { vi.clearAllMocks(); useCockpitMeetingAgendaDraftStore.getState().clearDraft(); navigation.searchParams = new URLSearchParams("meeting=A"); });

describe("meeting command interaction isolation", () => {
  it("does not let A to B to A late completion unlock or clear the new A interaction", async () => {
    const resolvers: Array<(value: CockpitLifecycleCommandResult) => void> = [];
    vi.mocked(api.recordCockpitOccurrence).mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    const hook = setup(); let first!: ReturnType<typeof hook.result.current.run>; let second!: ReturnType<typeof hook.result.current.run>; let third!: ReturnType<typeof hook.result.current.run>;
    act(() => { first = hook.result.current.run({ kind: "occurrence", body }); }); await waitFor(() => expect(resolvers).toHaveLength(1)); expect(hook.result.current.busy).toBe(true);
    navigation.searchParams = new URLSearchParams("meeting=B"); hook.rerender({ meeting: "B" }); expect(hook.result.current.busy).toBe(false);
    act(() => { second = hook.result.current.run({ kind: "occurrence", body: { ...body, command_key: "22222222-2222-4222-8222-222222222222" } }); }); await waitFor(() => expect(resolvers).toHaveLength(2));
    navigation.searchParams = new URLSearchParams("meeting=A"); hook.rerender({ meeting: "A" }); expect(hook.result.current.busy).toBe(false);
    act(() => { third = hook.result.current.run({ kind: "occurrence", body }); }); await waitFor(() => expect(resolvers).toHaveLength(3));
    await act(async () => { resolvers[0]!(resultFor("A", body.command_key)); await first; }); expect(hook.result.current.busy).toBe(true); expect((await first)?.stillCurrent()).toBe(false);
    await act(async () => { resolvers[1]!(resultFor("B", "22222222-2222-4222-8222-222222222222")); await second; }); expect(hook.result.current.busy).toBe(true);
    await act(async () => { resolvers[2]!(resultFor("A", body.command_key)); await third; }); expect(hook.result.current.busy).toBe(false); expect((await third)?.stillCurrent()).toBe(true);
  });
  it("checks an original command through a read without rewriting, and never interprets a missing receipt as permission to change its key", async () => {
    const key = cockpitMeetingAgendaDraftKey("ws-1", "A", "occurrence"); prepareCockpitMeetingCommand(key, { kind: "occurrence", body });
    vi.mocked(api.getCockpitLifecycleCommand).mockRejectedValueOnce(new ApiError("Not yet recorded", 404, "Not Found")); const hook = setup(); hook.client.setQueryData(cockpitKeys.workflow("ws-1", "A"), { observedBeforeCommit: true });
    await act(async () => { await hook.result.current.verify(); }); expect(hook.result.current.pending?.body).toEqual(body); expect(api.recordCockpitOccurrence).not.toHaveBeenCalled();
    const confirmed = resultFor("A", body.command_key);
    vi.mocked(api.getCockpitLifecycleCommand).mockResolvedValueOnce({ workspace_id: "ws-1", meeting_id: "A", command_key: body.command_key, action: "end", actor_id: "user-1", actor_name: "Member", created_at: "2026-01-01T10:00:00Z", revision: 2, issue_id: null, receipt: confirmed.receipt });
    await act(async () => { await hook.result.current.verify(); }); expect(hook.result.current.pending).toBeUndefined(); expect(api.recordCockpitOccurrence).not.toHaveBeenCalled(); await waitFor(() => expect(hook.client.getQueryState(cockpitKeys.workflow("ws-1", "A"))?.isInvalidated).toBe(true));
  });
});
