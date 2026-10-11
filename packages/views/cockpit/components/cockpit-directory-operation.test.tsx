import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import { useCockpitMeetingDirectoryDraftStore, cockpitMeetingDirectoryDraftKey, setCockpitDirectoryForm } from "@multica/core/cockpit";
import { CockpitDirectoryOperation } from "./cockpit-directory-operation";
import { CockpitDirectoryRetry } from "./cockpit-directory-retry";
import { WS, MEETING, OP, operation, preview, receipt, summary, step, directoryId } from "./meeting-directory-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";

vi.mock("../../navigation", () => ({ useNavigation: () => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams() }) }));
vi.mock("../../common/local-path-link", () => ({ LocalPathLink: ({ path }: { path: string }) => <span>{path}</span> }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: {
  getCockpitDirectoryOperation: vi.fn(), getCockpitDirectorySteps: vi.fn(), previewCockpitDirectoryRetry: vi.fn(), retryCockpitDirectory: vi.fn(), getCockpitDirectoryAttempts: vi.fn(),
} }));
beforeEach(() => { vi.clearAllMocks(); useCockpitMeetingDirectoryDraftStore.getState().clearDraft(); });
describe("directory partial repair", () => {
  it("explicitly includes the still-pending base step when a changed binding requires it, without dropping the selected partition", async () => {
    const base = step({ state: "pending", can_retry: true }), child = step({ id: directoryId(20), position: 1, kind: "partition", state: "needs_attention", can_retry: true });
    const key = cockpitMeetingDirectoryDraftKey(WS, MEETING, "retry", OP);
    setCockpitDirectoryForm(key, { kind: "retry", observedRevision: 3, reason: "Keep this explanation", stepIds: [child.id] });
    const header = { ...operation(), revision: 3, state: "needs_attention", can_retry: true, blocked_reasons: ["base_reauthorization_required"] };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitDirectoryRetry wsId={WS} header={header} steps={[base, child]} onDone={vi.fn()} /></I18nProvider></QueryClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Retry selected steps (1)" })); const dialog = within(screen.getByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: enCockpit.meeting_directory.select_base }));
    expect(useCockpitMeetingDirectoryDraftStore.getState().draft.forms[key]).toMatchObject({ stepIds: [child.id, base.id], reason: "Keep this explanation" });
    await waitFor(() => expect(dialog.getByRole("button", { name: enCockpit.meeting_templates.preview_again })).toHaveFocus());
    expect(api.previewCockpitDirectoryRetry).not.toHaveBeenCalled(); expect(api.retryCockpitDirectory).not.toHaveBeenCalled();
  });

  it("retries only the explicitly selected missing step while retaining verified steps and does not create an issue", async () => {
    const base = step({ state: "satisfied", outcome: "observed_existing", label: "Existing meeting directory" });
    const missing = step({ id: directoryId(20), position: 1, kind: "partition", relative_path: "meetings/review/photos", label: "Missing photos folder", state: "needs_attention", can_retry: true, last_error_code: "io_failed" });
    let current = { ...operation(), state: "needs_attention", revision: 3, can_retry: true, blocked_reasons: ["directory_retry_required"], counts: { total: 2, pending: 0, running: 0, retry_wait: 0, satisfied: 1, needs_attention: 1, abandoned: 0 } };
    vi.mocked(api.getCockpitDirectoryOperation).mockImplementation(async () => current);
    vi.mocked(api.getCockpitDirectorySteps).mockImplementation(async () => ({ workspace_id: WS, meeting_id: MEETING, operation_id: OP, items: [base, missing], total: 2, counts: current.counts }));
    vi.mocked(api.previewCockpitDirectoryRetry).mockResolvedValue({ ...preview(), operation_id: OP, operation_revision: 3, step_ids: [missing.id], steps: [{ ...preview().steps[0]!, step_id: missing.id, kind: "partition", label: missing.label, relative_path: missing.relative_path }], counts: { total: 1, exists: 0, missing: 1, conflict: 0, unknown: 0 } });
    vi.mocked(api.retryCockpitDirectory).mockImplementation(async (_ws, _meeting, _operation, body) => {
      current = { ...current, state: "active", revision: 4, can_retry: false };
      return { workspace_id: WS, meeting_id: MEETING, command_key: body.command_key, action: "directory_retry", replayed: false,
        receipt: { ...receipt(), context_token: body.context_token, reason: body.reason, operation_revision: 4, directory_step_ids: [missing.id], grant: { ...receipt().grant, command_key: body.command_key } }, current };
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitDirectoryOperation wsId={WS} summary={summary()} operationId={OP} active={false} onCreated={vi.fn()} onManageMeeting={vi.fn()} refreshSummary={vi.fn()} /></I18nProvider></QueryClientProvider>);
    await screen.findByText("Existing meeting directory");
    expect(screen.queryByRole("checkbox", { name: "Existing meeting directory" })).toBeNull();
    expect(api.retryCockpitDirectory).not.toHaveBeenCalled(); expect(api.getCockpitDirectoryAttempts).not.toHaveBeenCalled();
    expect(screen.getByText(enCockpit.meeting_directory.retry_required)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: enCockpit.meeting_directory.select_retryable }));
    expect(screen.getByRole("checkbox", { name: "Missing photos folder" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Retry selected steps (1)" }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: enCockpit.meeting_templates.preview_again }));
    const confirm = await dialog.findByRole("checkbox", { name: enCockpit.meeting_directory.confirm_retry }); fireEvent.click(confirm);
    fireEvent.click(dialog.getByRole("button", { name: enCockpit.meeting_lifecycle.confirm }));
    await waitFor(() => expect(api.retryCockpitDirectory).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.retryCockpitDirectory).mock.calls[0]?.[3]).toEqual({ command_key: expect.any(String), expected_revision: 3, context_token: preview().context_token, step_ids: [missing.id], reason: "" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("Existing meeting directory")).toBeVisible();
  });
});
