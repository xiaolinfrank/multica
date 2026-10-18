import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import { useCockpitMeetingPreparationDraftStore } from "@multica/core/cockpit";
import type { CockpitLifecycleCommandDetail, CockpitPreparationCommandResult, CockpitPreparationControlInput, CockpitPreparationEffect, CockpitPreparationOperationHeader } from "@multica/core/types";
import { CockpitPreparationOperation } from "./cockpit-preparation-operation";
import enCockpit from "../../locales/en/cockpit.json";
import enIssues from "../../locales/en/issues.json";

vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ cockpit: () => "/ws/cockpit", issueDetail: (id: string) => `/ws/issues/${id}` }) }));
vi.mock("../../navigation", () => ({ useNavigation: () => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams("meeting=m&meeting_view=details&preparation=p") }), AppLink: ({ children, href, ...props }: React.ComponentProps<"a">) => <a href={href} {...props}>{children}</a> }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: {
  getCockpitPreparationOperation: vi.fn(), getCockpitPreparationEffects: vi.fn(), getCockpitPreparationEffect: vi.fn(),
  applyCockpitPreparationEffect: vi.fn(), controlCockpitPreparationOperation: vi.fn(), getCockpitLifecycleCommand: vi.fn(),
} }));

const id = (value: number) => `10000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const ws = id(1), meeting = id(2), operation = id(3), effectId = id(4), time = "2026-10-13T10:00:00Z";
function fixture() {
  const effect: CockpitPreparationEffect = { id: effectId, operation_id: operation, slot_id: id(5), position: 1, kind: "cancel_issue", label: "Cancel preparation issue", revision: 1,
    state: "pending", command_key: id(6), dependency_id: null, error_code: "", reason: "", targets: [], receipt: null,
    can_apply: true, can_skip: true, can_reauthorize: false, authorization_key: id(7), authorization_revision: 1 };
  const header: CockpitPreparationOperationHeader = { workspace_id: ws, meeting_id: meeting, id: operation, kind: "cancel_preparation", revision: 1, state: "active", command_key: id(8),
    responsible_user_name: "Lee", created_by: id(9), created_by_name: "Lee", responsible_user_id: id(9), created_at: time, updated_at: time,
    counts: { total: 1, pending: 1, applied: 0, needs_attention: 0, skipped: 0 }, can_continue: true, can_pause: true, can_resume: false, can_claim: false, blocked_reasons: [] };
  vi.mocked(api.getCockpitPreparationOperation).mockImplementation(async () => structuredClone(header));
  vi.mocked(api.getCockpitPreparationEffects).mockImplementation(async () => ({ workspace_id: ws, meeting_id: meeting, operation_id: operation, revision: header.revision, page_size: 25, items: [structuredClone(effect)], total: 1, next_cursor: null }));
  const control = (body: CockpitPreparationControlInput): CockpitPreparationCommandResult => {
    header.revision += 1; header.can_continue = false; header.can_pause = false;
    header.state = body.transition === "pause" ? "paused" : "completed";
    if (body.transition === "skip") { effect.state = "skipped"; effect.can_apply = false; effect.can_skip = false; header.counts.pending = 0; header.counts.skipped = 1; }
    return { workspace_id: ws, meeting_id: meeting, command_key: body.command_key, action: `preparation_${body.transition}`, replayed: false, current: structuredClone(header),
      receipt: { operation_id: operation, kind: "cancel_preparation", revision: header.revision, state: header.state, effect_ids: [effectId], effect_id: body.effect_id, reason: body.reason,
        request_hash: "a".repeat(64), occurrence: null, context_token: "", authorization: null, previous_authorization: null } };
  };
  vi.mocked(api.controlCockpitPreparationOperation).mockImplementation(async (_ws, _meeting, _operation, body) => control(body));
  return { header, effect, control };
}
function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, issues: enIssues } }}><CockpitPreparationOperation wsId={ws} meetingId={meeting} operationId={operation} /></I18nProvider></QueryClientProvider>);
  return () => { view.unmount(); client.clear(); };
}
beforeEach(() => { vi.clearAllMocks(); useCockpitMeetingPreparationDraftStore.getState().clearDraft(); });

describe("cancellation operation control wiring", () => {
  it.each(["pause", "skip"] as const)("confirms %s with a reason without applying any issue changes", async (transition) => {
    const data = fixture(); const cleanup = show();
    try {
      fireEvent.click(await screen.findByRole("button", { name: enCockpit.meeting_preparation[transition] }));
      const dialog = within(screen.getByRole("dialog"));
      expect(dialog.getByRole("button", { name: enCockpit.meeting_lifecycle.confirm })).toBeDisabled();
      fireEvent.change(dialog.getByRole("textbox", { name: enCockpit.meeting_lifecycle.reason }), { target: { value: "Leave the original issue unchanged." } });
      fireEvent.click(dialog.getByRole("button", { name: enCockpit.meeting_lifecycle.confirm }));
      await waitFor(() => expect(api.controlCockpitPreparationOperation).toHaveBeenCalledTimes(1));
      expect(vi.mocked(api.controlCockpitPreparationOperation).mock.calls[0]).toMatchObject([ws, meeting, operation, { transition, effect_id: transition === "skip" ? effectId : null, expected_revision: 1, reason: "Leave the original issue unchanged." }]);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(data.header.state).toBe(transition === "pause" ? "paused" : "completed");
      expect(api.applyCockpitPreparationEffect).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });

  it("recovers a committed pause by reading its fixed receipt without resuming work", async () => {
    const data = fixture();
    let receipt!: CockpitPreparationCommandResult;
    vi.mocked(api.controlCockpitPreparationOperation).mockImplementationOnce(async (_ws, _meeting, _operation, body) => { receipt = data.control(body); throw new Error("Pause response lost"); });
    vi.mocked(api.getCockpitLifecycleCommand).mockImplementation(async (_ws, _meeting, commandKey): Promise<CockpitLifecycleCommandDetail> => ({ workspace_id: ws, meeting_id: meeting, command_key: commandKey,
      action: "preparation_pause", actor_id: id(9), actor_name: "Lee", created_at: time, revision: receipt.receipt.revision, issue_id: null,
      receipt: { revision: receipt.receipt.revision, issue_id: null, request_hash: "a".repeat(64), reason: receipt.receipt.reason, occurrence: null, previous_occurrence: null, materials: null, preparation: receipt.receipt } }));
    const cleanup = show();
    try {
      fireEvent.click(await screen.findByRole("button", { name: enCockpit.meeting_preparation.pause }));
      const dialog = within(screen.getByRole("dialog"));
      fireEvent.change(dialog.getByRole("textbox", { name: enCockpit.meeting_lifecycle.reason }), { target: { value: "Wait for the meeting owner." } });
      fireEvent.click(dialog.getByRole("button", { name: enCockpit.meeting_lifecycle.confirm }));
      await dialog.findByText("Pause response lost");
      expect(dialog.getByRole("textbox", { name: enCockpit.meeting_lifecycle.reason })).toHaveValue("Wait for the meeting owner.");
      fireEvent.click(dialog.getByRole("button", { name: enCockpit.meeting_lifecycle.check_command }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(api.getCockpitLifecycleCommand).toHaveBeenCalledExactlyOnceWith(ws, meeting, receipt.command_key, expect.any(AbortSignal));
      expect(useCockpitMeetingPreparationDraftStore.getState().draft.commands).toEqual({});
      expect(api.controlCockpitPreparationOperation).toHaveBeenCalledTimes(1);
      expect(api.applyCockpitPreparationEffect).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });
});
