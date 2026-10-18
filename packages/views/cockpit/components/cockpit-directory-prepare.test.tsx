import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api, ApiError } from "@multica/core/api";
import { cockpitMeetingDirectoryDraftKey, prepareCockpitDirectoryCommand, useCockpitMeetingDirectoryDraftStore } from "@multica/core/cockpit";
import { CockpitDirectoryPrepare } from "./cockpit-directory-prepare";
import { WS, MEETING, ROOT, OP, body, history, preview, summary } from "./meeting-directory-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";

vi.mock("../../navigation", () => ({ useNavigation: () => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams() }) }));
vi.mock("../../common/local-path-link", () => ({ LocalPathLink: ({ path }: { path: string }) => <span>{path}</span> }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: {
  getCockpitDirectoryRoots: vi.fn(), getCockpitDirectoryRoot: vi.fn(), previewCockpitMeetingDirectory: vi.fn(), createCockpitMeetingDirectory: vi.fn(), getCockpitLifecycleCommand: vi.fn(),
} }));
beforeEach(() => {
  vi.clearAllMocks(); useCockpitMeetingDirectoryDraftStore.getState().clearDraft();
  vi.mocked(api.getCockpitDirectoryRoots).mockResolvedValue({ workspace_id: WS, page_size: 25, total: 1, next_cursor: null, items: [{ root_id: ROOT, root_path: "/approved", prepare_subpath_count: 1 }] });
  vi.mocked(api.getCockpitDirectoryRoot).mockResolvedValue({ workspace_id: WS, root_id: ROOT, root_path: "/approved", prepare_subpath_count: 1, prepare_subpaths: ["meetings"] });
});
function setup(value = summary()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  const created = vi.fn();
  const view = render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitDirectoryPrepare wsId={WS} summary={value} refresh={vi.fn()} onManageMeeting={vi.fn()} onCreated={created} /></I18nProvider></QueryClientProvider>);
  return { ...view, client, created };
}

describe("directory preparation authorization", () => {
  it("keeps edited destination after a conflict and requires an explicitly refreshed preview and confirmation", async () => {
    vi.mocked(api.previewCockpitMeetingDirectory).mockImplementation(async (_ws, _meeting, input) => ({ ...preview(), target: { ...preview().target, relative_directory: input.relative_directory, directory: `/approved/${input.relative_directory}` } }));
    vi.mocked(api.createCockpitMeetingDirectory).mockRejectedValue(new ApiError("Binding changed during confirmation", 409, "Conflict"));
    setup(); fireEvent.click(screen.getByRole("button", { name: enCockpit.meeting_directory.prepare }));
    const dialog = within(screen.getByRole("dialog"));
    await dialog.findByText("meetings", { selector: "li" });
    fireEvent.change(dialog.getByRole("textbox", { name: enCockpit.meeting_directory.relative_path }), { target: { value: "meetings/edited" } });
    fireEvent.click(dialog.getByRole("button", { name: enCockpit.meeting_directory.preview }));
    const confirmation = await dialog.findByRole("checkbox", { name: enCockpit.meeting_directory.confirm_plan });
    fireEvent.click(confirmation); fireEvent.click(dialog.getByRole("button", { name: enCockpit.meeting_directory.confirm }));
    await dialog.findByText("Binding changed during confirmation");
    expect(confirmation).not.toBeChecked(); expect(confirmation).toBeDisabled();
    expect(dialog.getByRole("button", { name: enCockpit.meeting_directory.confirm })).toBeDisabled();
    const key = cockpitMeetingDirectoryDraftKey(WS, MEETING, "prepare", "prepare");
    expect(useCockpitMeetingDirectoryDraftStore.getState().draft.forms[key]).toMatchObject({ relativeDirectory: "meetings/edited" });
    fireEvent.click(dialog.getByRole("button", { name: enCockpit.meeting_templates.preview_again }));
    await waitFor(() => expect(vi.mocked(api.previewCockpitMeetingDirectory)).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(dialog.getByRole("checkbox", { name: enCockpit.meeting_directory.confirm_plan })).toBeEnabled());
    expect(dialog.getByRole("checkbox", { name: enCockpit.meeting_directory.confirm_plan })).not.toBeChecked();
    expect(dialog.getByRole("button", { name: enCockpit.meeting_directory.confirm })).toBeDisabled();
  });

  it("can recover the exact original receipt after current preparation permissions are revoked", async () => {
    const key = cockpitMeetingDirectoryDraftKey(WS, MEETING, "prepare", "prepare");
    prepareCockpitDirectoryCommand(key, { kind: "prepare", meetingId: MEETING, body: body() });
    vi.mocked(api.getCockpitLifecycleCommand).mockResolvedValue(history());
    const hook = setup({ ...summary(), capabilities: { available: true, can_preview: false, can_create: false }, blocked_reasons: ["permission_revoked"] });
    fireEvent.click(screen.getByRole("button", { name: enCockpit.meeting_directory.prepare }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByRole("button", { name: enCockpit.meeting_lifecycle.retry_command })).toBeDisabled();
    await act(async () => { fireEvent.click(dialog.getByRole("button", { name: enCockpit.meeting_lifecycle.check_command })); });
    await waitFor(() => expect(hook.created).toHaveBeenCalledExactlyOnceWith(OP));
    expect(api.getCockpitDirectoryRoots).not.toHaveBeenCalled(); expect(api.createCockpitMeetingDirectory).not.toHaveBeenCalled();
    expect(useCockpitMeetingDirectoryDraftStore.getState().draft.commands[key]).toBeUndefined();
  });
});
