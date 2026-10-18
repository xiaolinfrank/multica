// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { beginCockpitInputRunLaunch, cockpitInputRunLaunchKey, settleCockpitInputRunLaunch, useCockpitInputRunLaunchStore } from "./input-view-drafts";
const id = (n: number) => `b4000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const key = cockpitInputRunLaunchKey(id(1), id(2), id(3));
const intent = { attemptId: id(4), manifestVersionId: id(5), startedAt: "2026-10-11T10:00:00Z" };
beforeEach(() => useCockpitInputRunLaunchStore.getState().clearDraft());
describe("non-idempotent input-bound run launch intent", () => {
  it("retains an unknown launch and requires a distinct explicit authorization to start another", () => {
    expect(beginCockpitInputRunLaunch(key, intent)).toBe(true);
    settleCockpitInputRunLaunch(key, intent.attemptId, { state: "unknown" });
    const prior = useCockpitInputRunLaunchStore.getState().draft.intents[key]!;
    const next = { ...intent, attemptId: id(6) };
    expect(beginCockpitInputRunLaunch(key, next, prior)).toBe(false);
    expect(beginCockpitInputRunLaunch(key, next, prior, true)).toBe(true);
    settleCockpitInputRunLaunch(key, intent.attemptId, { state: "confirmed", runId: id(7) });
    expect(useCockpitInputRunLaunchStore.getState().draft.intents[key]?.confirmedRunId).toBeNull();
    settleCockpitInputRunLaunch(key, next.attemptId, { state: "confirmed", runId: id(8) });
    expect(useCockpitInputRunLaunchStore.getState().draft.intents[key]?.confirmedRunId).toBe(id(8));
  });
  it("does not assign malformed keys or another actor's existing intent", () => {
    expect(beginCockpitInputRunLaunch('not-a-key', intent)).toBe(false);
    expect(beginCockpitInputRunLaunch(key, intent)).toBe(true);
    const prior = useCockpitInputRunLaunchStore.getState().draft.intents[key]!;
    const other = cockpitInputRunLaunchKey(id(1), id(9), id(3));
    expect(beginCockpitInputRunLaunch(other, { ...intent, attemptId: id(10) }, prior, true)).toBe(false);
    expect(Object.keys(useCockpitInputRunLaunchStore.getState().draft.intents)).toEqual([key]);
  });
});
