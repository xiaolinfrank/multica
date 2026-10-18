import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@multica/core/api";
import { cockpitKeys, cockpitMeetingDirectoryDraftKey, prepareCockpitDirectoryCommand, useCockpitMeetingDirectoryDraftStore } from "@multica/core/cockpit";
import type { CockpitDirectoryCommandResult } from "@multica/core/types";
import { useCockpitDirectoryCommand } from "./use-cockpit-directory-command";
import { WS, MEETING, OTHER, KEY, body, result, history } from "./meeting-directory-test-fixtures";

const navigation = vi.hoisted(() => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams() }));
vi.mock("../../navigation", () => ({ useNavigation: () => navigation }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { createCockpitMeetingDirectory: vi.fn(), getCockpitLifecycleCommand: vi.fn() } }));
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, ...renderHook(({ meetingId }) => useCockpitDirectoryCommand(WS, meetingId, cockpitMeetingDirectoryDraftKey(WS, meetingId, "prepare")), { initialProps: { meetingId: MEETING }, wrapper }) };
}
beforeEach(() => { vi.clearAllMocks(); useCockpitMeetingDirectoryDraftStore.getState().clearDraft(); navigation.searchParams = new URLSearchParams(`meeting=${MEETING}&meeting_view=resources`); });

describe("directory command recovery", () => {
  it("keeps an unknown command fixed, checks its receipt without writing, and refreshes the original meeting facts", async () => {
    const key = cockpitMeetingDirectoryDraftKey(WS, MEETING, "prepare");
    prepareCockpitDirectoryCommand(key, { kind: "prepare", meetingId: MEETING, body: body() });
    vi.mocked(api.getCockpitLifecycleCommand).mockRejectedValueOnce(new ApiError("Not recorded yet", 404, "Not Found"));
    const hook = setup(); hook.client.setQueryData(cockpitKeys.workflow(WS, MEETING), { beforeCommit: true });
    await act(async () => { await hook.result.current.verify(); });
    expect(hook.result.current.pending?.body).toEqual(body()); expect(hook.result.current.canRetry).toBe(true);
    expect(api.createCockpitMeetingDirectory).not.toHaveBeenCalled();
    vi.mocked(api.getCockpitLifecycleCommand).mockResolvedValueOnce(history());
    await act(async () => { await hook.result.current.verify(); });
    expect(hook.result.current.pending).toBeUndefined(); expect(api.createCockpitMeetingDirectory).not.toHaveBeenCalled();
    expect(api.getCockpitLifecycleCommand).toHaveBeenLastCalledWith(WS, MEETING, KEY, expect.any(AbortSignal));
    expect(hook.client.getQueryState(cockpitKeys.workflow(WS, MEETING))?.isInvalidated).toBe(true);
  });

  it("does not let an A to B to A late receipt unlock or navigate the new A interaction", async () => {
    const replies: Array<(value: CockpitDirectoryCommandResult) => void> = [];
    vi.mocked(api.createCockpitMeetingDirectory).mockImplementation(() => new Promise((resolve) => replies.push(resolve)));
    const hook = setup(); let first!: ReturnType<typeof hook.result.current.run>, second!: ReturnType<typeof hook.result.current.run>;
    act(() => { first = hook.result.current.run({ kind: "prepare", meetingId: MEETING, body: body() }); });
    await waitFor(() => expect(replies).toHaveLength(1));
    navigation.searchParams = new URLSearchParams(`meeting=${OTHER}`); hook.rerender({ meetingId: OTHER }); expect(hook.result.current.busy).toBe(false);
    navigation.searchParams = new URLSearchParams(`meeting=${MEETING}`); hook.rerender({ meetingId: MEETING });
    act(() => { second = hook.result.current.run({ kind: "prepare", meetingId: MEETING, body: body() }); });
    await waitFor(() => expect(replies).toHaveLength(2));
    await act(async () => { replies[0]!(result()); await first; });
    expect((await first)?.stillCurrent()).toBe(false); expect(hook.result.current.busy).toBe(true);
    await act(async () => { replies[1]!(result()); await second; });
    expect((await second)?.stillCurrent()).toBe(true); expect(hook.result.current.busy).toBe(false);
  });
});
