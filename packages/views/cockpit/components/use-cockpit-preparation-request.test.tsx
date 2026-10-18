import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@multica/core/api";
import { useCockpitMeetingPreparationDraftStore, type CockpitPreparationPendingCommand } from "@multica/core/cockpit";
import { useCockpitPreparationRequest } from "./use-cockpit-preparation-request";

vi.mock("../../navigation", () => ({ useNavigation: () => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams("meeting=m&meeting_view=details") }) }));
const command: CockpitPreparationPendingCommand = { kind: "cancellation", meetingId: "11111111-1111-4111-8111-111111111111", body: {
  command_key: "22222222-2222-4222-8222-222222222222", expected_revision: 2, context_token: "context", reason: "Meeting is no longer needed", issues: [], run_ids: [],
} };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => useCockpitMeetingPreparationDraftStore.getState().clearDraft());

describe("cancellation command UI lifetime", () => {
  it("does not let a receipt from A close or unlock a new A request after visiting B", async () => {
    const first = deferred<string>(); const second = deferred<string>(); const hook = renderHook(({ id }) => useCockpitPreparationRequest(id), { initialProps: { id: "A" } });
    let previous!: ReturnType<typeof hook.result.current.run<string>>;
    act(() => { previous = hook.result.current.run(command, () => first.promise); }); expect(hook.result.current.busy).toBe(true);
    hook.rerender({ id: "B" }); expect(hook.result.current.busy).toBe(false);
    hook.rerender({ id: "A" }); let latest!: ReturnType<typeof hook.result.current.run<string>>;
    act(() => { latest = hook.result.current.run(command, () => second.promise); }); expect(hook.result.current.busy).toBe(true);
    await act(async () => { first.resolve("old receipt"); expect((await previous)?.stillCurrent()).toBe(false); });
    expect(hook.result.current.busy).toBe(true);
    await act(async () => { second.resolve("current receipt"); expect((await latest)?.stillCurrent()).toBe(true); });
    expect(hook.result.current.busy).toBe(false);
  });
  it("keeps the original intent after an unknown write and a read-only 404, then settles a checked receipt", async () => {
    const hook = renderHook(() => useCockpitPreparationRequest("A"));
    await act(async () => { await hook.result.current.run(command, async () => { throw new Error("Response lost"); }); });
    expect(hook.result.current.pending).toEqual(command); expect(hook.result.current.canRetry).toBe(false);
    await act(async () => { await hook.result.current.verify(async () => { throw new ApiError("Not observed yet", 404, "Not Found"); }); });
    expect(hook.result.current.pending).toEqual(command); expect(hook.result.current.error).toBe("Not observed yet"); expect(hook.result.current.canRetry).toBe(true);
    await act(async () => { await hook.result.current.verify(async (pending) => { expect(pending).toEqual(command); return "checked exact receipt"; }); });
    expect(hook.result.current.pending).toBeUndefined(); expect(hook.result.current.error).toBe("");
  });
});
