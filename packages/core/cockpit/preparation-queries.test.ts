// @vitest-environment node
import { QueryClient, QueryObserver, isCancelledError } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { CockpitPreparationOperationHeader } from "../types/cockpit-meeting-preparation";
import { cockpitPreparationKeys, cockpitPreparationOperationOptions, invalidateCockpitMeetingPreparationFacts } from "./meeting-preparation-queries";
import { cockpitLifecycleKeys } from "./meeting-lifecycle-queries";
import { cockpitKeys } from "./queries";
import { onCockpitChanged } from "./ws-updaters";

vi.mock("../api", () => ({ api: { getCockpitPreparationOperation: vi.fn() } }));
afterEach(() => vi.resetAllMocks());
const WS = "workspace", MEETING = "meeting", OP = "operation";
function header(revision: number): CockpitPreparationOperationHeader {
  return { workspace_id: WS, meeting_id: MEETING, id: OP, kind: "cancel_preparation", revision, state: "active", command_key: "key",
    created_by: "user", created_by_name: "Preparer", responsible_user_id: "user", responsible_user_name: "Preparer",
    created_at: "2026-10-11T00:00:00Z", updated_at: "2026-10-11T00:00:00Z", counts: { total: 1, pending: 1, applied: 0, needs_attention: 0, skipped: 0 },
    can_continue: true, can_resume: false, can_pause: true, can_claim: false, blocked_reasons: [] };
}
function client() { return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }); }

describe("preparation fact reconciliation", () => {
  it.each([false, true])("replaces a pending pre-command GET with a fresh read even when cached=%s", async (cached) => {
    const qc = client(), options = cockpitPreparationOperationOptions(WS, MEETING, OP);
    if (cached) qc.setQueryData(options.queryKey, header(1));
    let finishOld!: (value: CockpitPreparationOperationHeader) => void;
    const old = new Promise<CockpitPreparationOperationHeader>((resolve) => { finishOld = resolve; });
    vi.mocked(api.getCockpitPreparationOperation).mockImplementationOnce(() => old).mockResolvedValueOnce(header(2));
    const observer = new QueryObserver(qc, { ...options, staleTime: Infinity });
    const unsubscribe = observer.subscribe(() => {});
    const pending = qc.fetchQuery({ ...options, staleTime: 0 }).catch((error: unknown) => { if (!isCancelledError(error)) throw error; });
    try {
      await vi.waitFor(() => expect(api.getCockpitPreparationOperation).toHaveBeenCalledTimes(1));
      await invalidateCockpitMeetingPreparationFacts(qc, WS, MEETING, OP);
      expect(api.getCockpitPreparationOperation).toHaveBeenCalledTimes(2);
      expect(qc.getQueryData(options.queryKey)).toEqual(header(2));
      finishOld(header(1)); await pending;
      expect(qc.getQueryData(options.queryKey)).toEqual(header(2));
      expect(observer.getCurrentResult().data?.revision).toBe(2);
    } finally { finishOld(header(1)); unsubscribe(); qc.clear(); }
  });

  it("reconciles a lifecycle WS event while the first preparation GET is still pending", async () => {
    const qc = client(), options = cockpitPreparationOperationOptions(WS, MEETING, OP);
    const receiptKey = cockpitLifecycleKeys.command(WS, MEETING, "confirmed-command");
    const otherKey = cockpitPreparationKeys.operation("other-workspace", MEETING, OP);
    qc.setQueryData(receiptKey, { content: "fixed receipt" });
    qc.setQueryData(otherKey, { revision: 7 });
    let finishOld!: (value: CockpitPreparationOperationHeader) => void;
    const old = new Promise<CockpitPreparationOperationHeader>((resolve) => { finishOld = resolve; });
    vi.mocked(api.getCockpitPreparationOperation).mockImplementationOnce(() => old).mockResolvedValueOnce(header(2));
    const observer = new QueryObserver(qc, { ...options, staleTime: Infinity });
    const unsubscribe = observer.subscribe(() => {});
    const pending = qc.fetchQuery(options).catch((error: unknown) => { if (!isCancelledError(error)) throw error; });
    try {
      await vi.waitFor(() => expect(api.getCockpitPreparationOperation).toHaveBeenCalledTimes(1));
      onCockpitChanged(qc, WS, { scope: "meeting_lifecycle", action: "changed", entity: { meeting_id: MEETING, revision: 2 } });
      await vi.waitFor(() => expect(api.getCockpitPreparationOperation).toHaveBeenCalledTimes(2));
      expect(qc.getQueryData(options.queryKey)).toEqual(header(2));
      finishOld(header(1)); await pending;
      expect(observer.getCurrentResult().data?.revision).toBe(2);
      expect(qc.getQueryData(options.queryKey)).toEqual(header(2));
      expect(qc.getQueryData(receiptKey)).toEqual({ content: "fixed receipt" });
      expect(qc.getQueryState(receiptKey)?.isInvalidated).toBe(false);
      expect(qc.getQueryState(otherKey)?.isInvalidated).toBe(false);
    } finally { finishOld(header(1)); unsubscribe(); qc.clear(); }
  });

  it("refreshes mutable workspace facts while allowing immutable version and receipt reads to finish", async () => {
    const qc = client();
    const stableKeys = [cockpitLifecycleKeys.command(WS, MEETING, "command")];
    const mutableKeys = [cockpitPreparationKeys.operation(WS, MEETING, OP), cockpitPreparationKeys.operations(WS, MEETING), cockpitPreparationKeys.meeting(WS, MEETING), cockpitLifecycleKeys.header(WS, MEETING)];
    const other = cockpitPreparationKeys.operation("other-workspace", MEETING, OP);
    for (const key of [...mutableKeys, other]) qc.setQueryData(key, { revision: 7 });
    const finish: Array<(value: { content: string }) => void> = [];
    const reads = stableKeys.map((queryKey) => qc.fetchQuery({ queryKey, queryFn: () => new Promise<{ content: string }>((resolve) => finish.push(resolve)), staleTime: Infinity }));
    const collected = Promise.allSettled(reads);
    try {
      await vi.waitFor(() => expect(finish).toHaveLength(1));
      await invalidateCockpitMeetingPreparationFacts(qc, WS);
      for (const key of mutableKeys) expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
      expect(qc.getQueryState(other)?.isInvalidated).toBe(false);
      for (const resolve of finish) resolve({ content: "  Fixed receipt body\n" });
      await expect(collected).resolves.toEqual(stableKeys.map(() => ({ status: "fulfilled", value: { content: "  Fixed receipt body\n" } })));
      for (const key of stableKeys) expect(qc.getQueryState(key)?.isInvalidated).toBe(false);
      for (const key of mutableKeys) expect(qc.getQueryData(key)).toEqual({ revision: 7 });
    } finally { for (const resolve of finish) resolve({ content: "  Fixed receipt body\n" }); qc.clear(); }
  });

  it("reconciles the named meeting without clearing another meeting or applying a historic receipt as current state", async () => {
    const qc = client();
    const affected = [cockpitPreparationKeys.operation(WS, MEETING, OP), cockpitPreparationKeys.effects(WS, MEETING, OP),
      cockpitPreparationKeys.effect(WS, MEETING, OP, "effect"),
      cockpitPreparationKeys.authorization(WS, MEETING, OP, "effect"), cockpitPreparationKeys.basis(WS, MEETING), cockpitKeys.workflow(WS, MEETING)];
    const untouched = [cockpitPreparationKeys.operation(WS, "other-meeting", OP), cockpitPreparationKeys.operation("other-workspace", MEETING, OP),
      cockpitLifecycleKeys.command(WS, MEETING, "command")];
    for (const key of [...affected, ...untouched]) qc.setQueryData(key, { revision: 12 });
    await invalidateCockpitMeetingPreparationFacts(qc, WS, MEETING, OP);
    for (const key of affected) expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
    for (const key of untouched) expect(qc.getQueryState(key)?.isInvalidated).toBe(false);
    for (const key of [...affected, ...untouched]) expect(qc.getQueryData(key)).toEqual({ revision: 12 });
    qc.clear();
  });
});
