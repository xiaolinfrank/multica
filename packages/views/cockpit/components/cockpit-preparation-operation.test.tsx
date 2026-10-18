import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import { useCockpitMeetingPreparationDraftStore } from "@multica/core/cockpit";
import type { CockpitPreparationEffect, CockpitPreparationOperationHeader } from "@multica/core/types";
import { CockpitPreparationOperation } from "./cockpit-preparation-operation";
import enCockpit from "../../locales/en/cockpit.json";
import enIssues from "../../locales/en/issues.json";

vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ cockpit: () => "/ws/cockpit", issueDetail: (id: string) => `/ws/issues/${id}` }) }));
vi.mock("../../navigation", () => ({ useNavigation: () => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams("meeting=m&preparation=p") }), AppLink: ({ children, href, ...props }: React.ComponentProps<"a">) => <a href={href} {...props}>{children}</a> }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { getCockpitPreparationOperation: vi.fn(), getCockpitPreparationEffects: vi.fn(), getCockpitPreparationEffect: vi.fn(), applyCockpitPreparationEffect: vi.fn() } }));
// Other confirmation dialogs have separate command tests. Keep this suite on
// the actual runner, Query invalidation, fixed receipt and bounded page wiring.
vi.mock("./cockpit-preparation-control", () => ({ CockpitPreparationControl: () => null }));
vi.mock("./cockpit-preparation-reauthorization", () => ({ CockpitPreparationReauthorization: () => null, CockpitPreparationAuthorizationRecord: () => null }));

const id = (value: number) => `10000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const ws = id(1), meeting = id(2), operation = id(3), time = "2026-10-11T12:00:00Z";
function fixture(total: number) {
  const rows: CockpitPreparationEffect[] = Array.from({ length: total }, (_, index) => ({ id: id(100 + index), operation_id: operation, slot_id: id(200 + index), position: index + 1,
    kind: ["cancel_issue", "change_due_date", "link_meeting", "stop_run"][index % 4]!, label: `Disposition ${index + 1}`, revision: 1, state: "pending", command_key: id(300 + index), dependency_id: null, error_code: "", reason: "", targets: [], receipt: null,
    can_apply: true, can_skip: true, can_reauthorize: false, authorization_key: id(400 + index), authorization_revision: 1 }));
  const header = (): CockpitPreparationOperationHeader => {
    const applied = rows.filter((row) => row.state === "applied").length;
    return { workspace_id: ws, meeting_id: meeting, id: operation, kind: "cancel_preparation", revision: applied + 1, state: applied === total ? "completed" : "active", command_key: id(4),
      responsible_user_name: "Lee", created_by: id(7), created_by_name: "Lee", responsible_user_id: id(7),
      created_at: time, updated_at: time, counts: { total, pending: total - applied, applied, needs_attention: 0, skipped: 0 }, can_continue: applied < total, can_pause: applied < total, can_resume: false, can_claim: false, blocked_reasons: [] };
  };
  const clone = <T,>(value: T): T => structuredClone(value);
  vi.mocked(api.getCockpitPreparationOperation).mockImplementation(async () => header());
  vi.mocked(api.getCockpitPreparationEffects).mockImplementation(async (_ws, _meeting, _operation, query = {}) => {
    const offset = query.cursor === "page-two" ? 25 : 0;
    return { workspace_id: ws, meeting_id: meeting, operation_id: operation, revision: header().revision, page_size: 25, items: clone(rows.slice(offset, offset + 25)), total, next_cursor: offset + 25 < total ? "page-two" : null };
  });
  vi.mocked(api.getCockpitPreparationEffect).mockImplementation(async (_ws, _meeting, _operation, effectId) => ({ workspace_id: ws, meeting_id: meeting, operation_id: operation, effect: clone(rows.find((row) => row.id === effectId)!), current: header() }));
  const apply = (effectId: string) => {
    const row = rows.find((item) => item.id === effectId)!; row.state = "applied"; row.can_apply = false;
    row.receipt = { effect_id: row.id, command_key: row.command_key, request_hash: "a".repeat(64), kind: row.kind, issue_id: null, run_id: null, issue: null, run_status: null,
      stopped_wakeup_ids: [], cancelled_queue_ids: [], applied_at: time, authorization_key: row.authorization_key, authorization_revision: row.authorization_revision, changed: true, stopped_wakeup_total: 0, cancelled_queue_total: 0, facts_hash: "b".repeat(64), target_meeting_id: null };
    return { workspace_id: ws, meeting_id: meeting, operation_id: operation, effect_id: row.id, command_key: row.command_key, replayed: false, receipt: clone(row.receipt), current: header() };
  };
  vi.mocked(api.applyCockpitPreparationEffect).mockImplementation(async (_ws, _meeting, _operation, effectId) => apply(effectId));
  return { rows, header, apply };
}
function show(autoStart = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, issues: enIssues } }}><CockpitPreparationOperation wsId={ws} meetingId={meeting} operationId={operation} autoStart={autoStart} /></I18nProvider></QueryClientProvider>);
  return () => { view.unmount(); client.clear(); };
}
beforeEach(() => { vi.clearAllMocks(); useCockpitMeetingPreparationDraftStore.getState().clearDraft(); });

describe("confirmed cancellation disposition runner", () => {
  it("waits for explicit continuation on a reopened instance and advances through both bounded pages in order", async () => {
    const data = fixture(27); const cleanup = show();
    try {
      await screen.findByRole("heading", { name: enCockpit.meeting_preparation.cancellation }); expect(api.applyCockpitPreparationEffect).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Continue remaining items" }));
      await waitFor(() => expect(api.applyCockpitPreparationEffect).toHaveBeenCalledTimes(27));
      await waitFor(() => expect(data.header().state).toBe("completed"));
      expect(vi.mocked(api.applyCockpitPreparationEffect).mock.calls.map((call) => call[3])).toEqual(data.rows.map((row) => row.id));
      expect(vi.mocked(api.getCockpitPreparationEffects).mock.calls.some((call) => call[3]?.cursor === "page-two")).toBe(true);
      expect(vi.mocked(api.getCockpitPreparationEffects).mock.calls.every((call) => call[3]?.page_size === 25)).toBe(true);
    } finally { cleanup(); }
  });
  it("checks the exact committed effect after a lost response and stops until another explicit continuation", async () => {
    const data = fixture(2);
    vi.mocked(api.applyCockpitPreparationEffect).mockImplementationOnce(async (_ws, _meeting, _operation, effectId) => { data.apply(effectId); throw new Error("Response lost"); });
    const cleanup = show(true);
    try {
      await screen.findByText(enCockpit.meeting_preparation.stopped_unknown);
      expect(api.applyCockpitPreparationEffect).toHaveBeenCalledTimes(1);
      expect(vi.mocked(api.getCockpitPreparationEffect).mock.calls.filter((call) => call[3] === data.rows[0]!.id).length).toBeGreaterThanOrEqual(2);
      expect(useCockpitMeetingPreparationDraftStore.getState().draft.commands).toEqual({});
      expect(data.header().counts).toMatchObject({ applied: 1, pending: 1 });
      fireEvent.click(screen.getByRole("button", { name: "Continue remaining items" }));
      await waitFor(() => expect(api.applyCockpitPreparationEffect).toHaveBeenCalledTimes(2));
      expect(vi.mocked(api.applyCockpitPreparationEffect).mock.calls.map((call) => call[3])).toEqual(data.rows.map((row) => row.id));
    } finally { cleanup(); }
  });
  it("keeps the same authorization when explicitly retrying an unobserved write", async () => {
    fixture(2);
    vi.mocked(api.applyCockpitPreparationEffect).mockRejectedValueOnce(new Error("Response lost before observation"));
    const cleanup = show(true);
    try {
      await screen.findByText(enCockpit.meeting_preparation.stopped_unknown);
      const first = vi.mocked(api.applyCockpitPreparationEffect).mock.calls[0]!;
      expect(api.applyCockpitPreparationEffect).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole("button", { name: enCockpit.meeting_preparation.continue }));
      await waitFor(() => expect(api.applyCockpitPreparationEffect).toHaveBeenCalledTimes(3));
      expect(vi.mocked(api.applyCockpitPreparationEffect).mock.calls[1]?.slice(0, 5)).toEqual(first.slice(0, 5));
      expect(useCockpitMeetingPreparationDraftStore.getState().draft.commands).toEqual({});
    } finally { cleanup(); }
  });
  it("stops after the in-flight item without sending another item", async () => {
    const data = fixture(2);
    let resolve!: (value: ReturnType<typeof data.apply>) => void;
    vi.mocked(api.applyCockpitPreparationEffect).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const cleanup = show(true);
    try {
      await waitFor(() => expect(api.applyCockpitPreparationEffect).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByRole("button", { name: enCockpit.meeting_preparation.stop_here }));
      await act(async () => resolve(data.apply(data.rows[0]!.id)));
      await screen.findByRole("button", { name: enCockpit.meeting_preparation.continue });
      expect(api.applyCockpitPreparationEffect).toHaveBeenCalledTimes(1);
      expect(data.header().counts).toMatchObject({ applied: 1, pending: 1 });
    } finally { cleanup(); }
  });
  it("leaves an unsupported effect readable without applying it", async () => {
    const data = fixture(1); data.rows[0]!.kind = "future_disposition";
    const cleanup = show(true);
    try {
      await screen.findByText(enCockpit.meeting_preparation.stopped);
      expect(screen.getByText(enCockpit.artifacts.unknown)).toBeVisible();
      expect(api.applyCockpitPreparationEffect).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });
  it("links a transfer receipt to the destination meeting's preparation without an agenda", async () => {
    const data = fixture(1); data.rows[0]!.kind = "link_meeting"; data.apply(data.rows[0]!.id);
    data.rows[0]!.receipt!.target_meeting_id = id(810);
    const cleanup = show();
    try {
      const link = await screen.findByRole("link", { name: new RegExp(enCockpit.meeting_disposition.open_target) });
      const query = new URL(link.getAttribute("href")!, "https://example.test").searchParams;
      expect(query.get("meeting")).toBe(id(810));
      expect(query.get("meeting_view")).toBe("preparation");
      expect(query.has("agenda")).toBe(false);
    } finally { cleanup(); }
  });
  it("shows the actual terminal run outcome when confirmation made no new stop request", async () => {
    const data = fixture(1); data.rows[0]!.kind = "stop_run"; data.apply(data.rows[0]!.id);
    data.rows[0]!.receipt = { ...data.rows[0]!.receipt!, kind: "stop_run", run_id: id(800), issue_id: id(801), run_status: "completed", changed: false };
    const cleanup = show();
    try {
      const row = within(await screen.findByRole("listitem", { name: "Disposition 1" }));
      expect(row.getByText(enCockpit.meeting_disposition.run_completed)).toBeVisible();
      expect(row.getByText(enCockpit.meeting_preparation.unchanged)).toBeVisible();
      expect(screen.getByRole("button", { name: enCockpit.meeting_preparation.open_run })).toBeEnabled();
      expect(api.applyCockpitPreparationEffect).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });
});
