import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import { useCockpitScopeViewStore } from "@multica/core/cockpit";
import { CockpitDirectoryAttempts } from "./cockpit-directory-attempts";
import { WS, MEETING, OP, STEP, KEY, TIME, step, directoryId } from "./meeting-directory-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";

vi.mock("../../common/local-path-link", () => ({ LocalPathLink: ({ path }: { path: string }) => <span>{path}</span> }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { getCockpitDirectoryAttempts: vi.fn(), getCockpitDirectoryAttempt: vi.fn() } }));
beforeEach(() => { vi.clearAllMocks(); useCockpitScopeViewStore.getState().reset(); });
describe("directory attempt evidence", () => {
  it("loads bounded history on demand and distinguishes a late observation from a successful current attempt", async () => {
    const attempts = Array.from({ length: 26 }, (_, index) => ({ id: directoryId(index + 100), step_id: STEP, attempt_number: 26 - index, state: "expired", started_at: TIME, finished_at: TIME, error_code: "io_timeout", outcome: null, observed_at: null }));
    vi.mocked(api.getCockpitDirectoryAttempts).mockImplementation(async (_ws, _meeting, _op, _step, query) => ({ workspace_id: WS, meeting_id: MEETING, operation_id: OP, step_id: STEP, page_size: 25,
      items: query?.cursor ? attempts.slice(25) : attempts.slice(0, 25), total: 26, next_cursor: query?.cursor ? null : "older-attempts" }));
    vi.mocked(api.getCockpitDirectoryAttempt).mockResolvedValue({ ...attempts[0]!, workspace_id: WS, meeting_id: MEETING, operation_id: OP, grant_command_key: KEY, grant_revision: 1, error_message: "", receipt: null,
      late_receipt: { directory: "/approved/meeting", directory_identity: "inode-a", root_identity: "mount-a", outcome: "created", observed_at: TIME }, late_observed_at: TIME });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitDirectoryAttempts wsId={WS} meetingId={MEETING} step={step({ attempt_count: 26 })} /></I18nProvider></QueryClientProvider>);
    expect(api.getCockpitDirectoryAttempts).not.toHaveBeenCalled(); expect(api.getCockpitDirectoryAttempt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Attempts (26)" })); const dialog = within(screen.getByRole("dialog"));
    await dialog.findByRole("button", { name: /^Attempt 26/ }); expect(dialog.getAllByRole("listitem")).toHaveLength(25);
    fireEvent.click(dialog.getByRole("button", { name: "Next page" })); await dialog.findByRole("button", { name: /^Attempt 1 ·/ }); expect(dialog.getAllByRole("listitem")).toHaveLength(1);
    expect(api.getCockpitDirectoryAttempt).not.toHaveBeenCalled();
    fireEvent.click(dialog.getByRole("button", { name: "Previous page" }));
    fireEvent.click(await dialog.findByRole("button", { name: /^Attempt 26/ }));
    await dialog.findByRole("heading", { name: "Attempt 26 · Attempt expired" });
    expect(dialog.getByText(enCockpit.meeting_directory.late_hint)).toBeVisible();
    expect(dialog.queryByText(enCockpit.meeting_directory.succeeded)).toBeNull();
    await waitFor(() => expect(api.getCockpitDirectoryAttempt).toHaveBeenCalledExactlyOnceWith(WS, MEETING, OP, STEP, attempts[0]!.id, expect.any(AbortSignal)));
    expect(vi.mocked(api.getCockpitDirectoryAttempts).mock.calls.every((call) => call[4]?.page_size === 25)).toBe(true);
  });
});
