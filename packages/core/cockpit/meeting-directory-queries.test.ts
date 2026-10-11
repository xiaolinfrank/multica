// @vitest-environment node
import { QueryClient, QueryObserver, isCancelledError } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../api";
import type { CockpitDirectorySummary } from "../types/cockpit-meeting-directory";
import { cockpitDirectoryKeys, cockpitDirectorySummaryOptions } from "./meeting-directory-queries";
import { cockpitLifecycleKeys } from "./meeting-lifecycle-queries";
import { onCockpitChanged } from "./ws-updaters";

vi.mock("../api", () => ({ api: { getCockpitMeetingDirectorySummary: vi.fn() } }));
afterEach(() => vi.resetAllMocks());
function summary(revision: number): CockpitDirectorySummary {
  return { workspace_id: "workspace", meeting_id: "meeting", generated_at: "2026-10-11T01:00:00Z",
    binding: { nas_dir: revision === 1 ? "" : "/approved/meeting", revision }, binding_candidate: null, binding_candidate_reason: "",
    capabilities: { available: true, can_preview: true, can_create: true }, blocked_reasons: [], current: null,
    history_total: 0, unfinished_total: 0, needs_attention_total: 0 };
}

it.each(["meeting_directory", "meeting"] as const)("reconciles %s while the first directory read is pending without touching another meeting or an exact command", async (scope) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const options = cockpitDirectorySummaryOptions("workspace", "meeting");
  const otherMeeting = cockpitDirectoryKeys.summary("workspace", "other-meeting");
  const otherWorkspace = cockpitDirectoryKeys.summary("other-workspace", "meeting");
  const command = cockpitLifecycleKeys.command("workspace", "meeting", "fixed-command");
  qc.setQueryData(otherMeeting, { binding: "unchanged" }); qc.setQueryData(otherWorkspace, { binding: "unchanged" });
  qc.setQueryData(command, { receipt: "fixed authorization" });
  let finishOld!: (value: CockpitDirectorySummary) => void;
  const old = new Promise<CockpitDirectorySummary>((resolve) => { finishOld = resolve; });
  vi.mocked(api.getCockpitMeetingDirectorySummary).mockImplementationOnce(() => old).mockResolvedValueOnce(summary(2));
  const observer = new QueryObserver(qc, { ...options, staleTime: Infinity });
  const unsubscribe = observer.subscribe(() => {});
  const pending = qc.fetchQuery(options).catch((error: unknown) => { if (!isCancelledError(error)) throw error; });
  try {
    await vi.waitFor(() => expect(api.getCockpitMeetingDirectorySummary).toHaveBeenCalledTimes(1));
    onCockpitChanged(qc, "workspace", { scope, action: "updated", entity: scope === "meeting" ? { id: "meeting" } : { meeting_id: "meeting" } });
    await vi.waitFor(() => expect(api.getCockpitMeetingDirectorySummary).toHaveBeenCalledTimes(2));
    finishOld(summary(1)); await pending;
    expect(observer.getCurrentResult().data?.binding).toEqual(summary(2).binding);
    for (const key of [otherMeeting, otherWorkspace, command]) expect(qc.getQueryState(key)?.isInvalidated).toBe(false);
    expect(qc.getQueryData(command)).toEqual({ receipt: "fixed authorization" });
  } finally { finishOld(summary(1)); unsubscribe(); qc.clear(); }
});
