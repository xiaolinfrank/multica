import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import { useCockpitMeetingDirectoryDraftStore, cockpitMeetingDirectoryDraftKey, setCockpitDirectoryForm } from "@multica/core/cockpit";
import { CockpitDirectoryOperation } from "./cockpit-directory-operation";
import { CockpitDirectoryRetry } from "./cockpit-directory-retry";
import { WS, MEETING, OP, ROOT, HASH, operation, preview, receipt, summary, step, directoryId } from "./meeting-directory-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";

vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ issueDetail: (id: string) => `/ws/issues/${id}` }) }));
vi.mock("../../navigation", () => ({ AppLink: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a>, useNavigation: () => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams() }) }));
vi.mock("../../common/local-path-link", () => ({ LocalPathLink: ({ path }: { path: string }) => <span>{path}</span> }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: {
  getTask: vi.fn(), getCockpitDirectoryOperation: vi.fn(), getCockpitDirectorySteps: vi.fn(), previewCockpitDirectoryRetry: vi.fn(), retryCockpitDirectory: vi.fn(), getCockpitDirectoryAttempts: vi.fn(),
  getCockpitDirectoryRoots: vi.fn(), getCockpitDirectoryRoot: vi.fn(), previewCockpitMeetingDirectory: vi.fn(),
} }));
beforeEach(() => { vi.clearAllMocks(); useCockpitMeetingDirectoryDraftStore.getState().clearDraft(); });
describe("directory partial repair", () => {
  it.each([true, false])("shows only recorded Issue and Run sources without inventing a human Issue (delegated: %s)", async (delegated) => {
    const issueId = directoryId(80), runId = directoryId(81);
    const original = operation(); const header = { ...original, source_principal: delegated ? { ...original.source_principal, source: "task_token", actor_type: "agent", actor_name: "Preparation agent", confirmed_by_user_id: null, issue_id: issueId, run_id: runId } : original.source_principal };
    vi.mocked(api.getCockpitDirectoryOperation).mockResolvedValue(header);
    vi.mocked(api.getCockpitDirectorySteps).mockResolvedValue({ workspace_id: WS, meeting_id: MEETING, operation_id: OP, items: [step()], total: 1, counts: header.counts });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitDirectoryOperation wsId={WS} summary={summary()} operationId={OP} active={false} onCreated={vi.fn()} onManageMeeting={vi.fn()} refreshSummary={vi.fn()} /></I18nProvider></QueryClientProvider>);
    try {
      await screen.findByText(enCockpit.meeting_directory.background);
      if (delegated) {
        expect(screen.getByRole("link", { name: `${enCockpit.input_materials.source_issue} ${enCockpit.action_flow.new_tab}` })).toHaveAttribute("href", `/ws/issues/${issueId}`);
        expect(screen.getByRole("button", { name: enCockpit.input_materials.source_run })).toBeVisible();
      } else {
        expect(screen.queryByRole("link", { name: `${enCockpit.input_materials.source_issue} ${enCockpit.action_flow.new_tab}` })).toBeNull();
        expect(screen.queryByRole("button", { name: enCockpit.input_materials.source_run })).toBeNull();
      }
      expect(api.getTask).not.toHaveBeenCalled();
    } finally { view.unmount(); client.clear(); }
  });

  it("reopens each completed plan with only its original single or custom partition and keeps their repair drafts separate", async () => {
    const secondId = directoryId(90), names = new Map([[OP, "照片"], [secondId, "custom-audio"]]);
    const header = (id: string) => ({ ...operation(), id, state: "completed", counts: { total: 2, pending: 0, running: 0, retry_wait: 0, satisfied: 2, needs_attention: 0, abandoned: 0 } });
    const rows = (id: string) => [step({ operation_id: id, state: "satisfied" }), step({ id: directoryId(20), operation_id: id, position: 1, kind: "partition", label: `Original folder for ${id}`, relative_path: `meetings/review/${names.get(id)}`, state: "satisfied" })];
    vi.mocked(api.getCockpitDirectoryOperation).mockImplementation(async (_ws, _meeting, id) => header(id));
    vi.mocked(api.getCockpitDirectorySteps).mockImplementation(async (_ws, _meeting, id) => ({ workspace_id: WS, meeting_id: MEETING, operation_id: id, items: rows(id), total: 2, counts: header(id).counts }));
    vi.mocked(api.getCockpitDirectoryRoots).mockResolvedValue({ workspace_id: WS, page_size: 25, items: [{ root_id: ROOT, root_path: "/approved", prepare_subpath_count: 1 }], total: 1, next_cursor: null });
    vi.mocked(api.getCockpitDirectoryRoot).mockResolvedValue({ workspace_id: WS, root_id: ROOT, root_path: "/approved", prepare_subpath_count: 1, prepare_subpaths: ["meetings"] });
    vi.mocked(api.previewCockpitMeetingDirectory).mockImplementation(async (_ws, _meeting, body) => ({ ...preview(), observed_binding: { nas_dir: body.observed_nas_dir, revision: body.observed_binding_revision }, bind_after_base: false,
      counts: { total: 2, exists: 2, missing: 0, conflict: 0, unknown: 0 }, steps: [preview().steps[0]!, { step_id: null, position: 1, parent_position: 0, kind: "partition", label: body.partitions[0]!, relative_path: `meetings/review/${body.partitions[0]}`, path_hash: HASH, planned_state: "exists", error_code: "" }] }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}>{children}</I18nProvider></QueryClientProvider>;
    const props = { wsId: WS, summary: { ...summary(), binding: { nas_dir: operation().target.directory, revision: 1 } }, active: false, onCreated: vi.fn(), onManageMeeting: vi.fn(), refreshSummary: vi.fn() };
    const view = render(<CockpitDirectoryOperation {...props} operationId={OP} />, { wrapper });
    for (const [id, name] of names) {
      if (id !== OP) view.rerender(<CockpitDirectoryOperation {...props} operationId={id} />);
      await screen.findByText(`Original folder for ${id}`);
      fireEvent.click(screen.getByRole("button", { name: enCockpit.meeting_directory.repair })); const dialog = within(screen.getByRole("dialog"));
      expect(dialog.getByRole("checkbox", { name })).toBeChecked(); expect(dialog.getByRole("checkbox", { name })).toBeDisabled();
      expect(dialog.queryByRole("checkbox", { name: "会议材料" })).toBeNull(); expect(dialog.queryByRole("checkbox", { name: "会议纪要与录音转写" })).toBeNull();
      expect(dialog.getByRole("textbox", { name: enCockpit.meeting_directory.relative_path })).toHaveAttribute("readonly");
      const button = dialog.getByRole("button", { name: enCockpit.meeting_directory.preview }); await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button);
      await waitFor(() => expect(api.previewCockpitMeetingDirectory).toHaveBeenLastCalledWith(WS, MEETING, expect.objectContaining({ mode: "repair", root_id: ROOT, relative_directory: "meetings/review", partitions: [name] })));
      expect(useCockpitMeetingDirectoryDraftStore.getState().draft.forms[cockpitMeetingDirectoryDraftKey(WS, MEETING, "prepare", "repair", id)]).toMatchObject({ partitions: [name] });
      fireEvent.click(dialog.getByRole("button", { name: enCockpit.task_create.cancel })); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
    expect(api.previewCockpitMeetingDirectory).toHaveBeenCalledTimes(2);
    expect(useCockpitMeetingDirectoryDraftStore.getState().draft.forms[cockpitMeetingDirectoryDraftKey(WS, MEETING, "prepare", "repair", OP)]).toMatchObject({ partitions: ["照片"] });
  });

  it("does not offer a default repair scope when the original full step list cannot be read", async () => {
    vi.mocked(api.getCockpitDirectoryOperation).mockResolvedValue({ ...operation(), state: "completed" });
    vi.mocked(api.getCockpitDirectorySteps).mockRejectedValue(new Error("Step page unavailable"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitDirectoryOperation wsId={WS} summary={summary()} operationId={OP} active={false} onCreated={vi.fn()} onManageMeeting={vi.fn()} refreshSummary={vi.fn()} /></I18nProvider></QueryClientProvider>);
    expect(await screen.findByRole("button", { name: enCockpit.meeting_directory.repair })).toBeDisabled();
    expect(screen.getByText(enCockpit.meeting_directory.repair_scope_unavailable)).toBeVisible(); expect(api.previewCockpitMeetingDirectory).not.toHaveBeenCalled();
  });

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
