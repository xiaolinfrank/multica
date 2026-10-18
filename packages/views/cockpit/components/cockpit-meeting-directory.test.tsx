import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import { useCockpitScopeViewStore, useCockpitMeetingDirectoryDraftStore } from "@multica/core/cockpit";
import { CockpitMeetingDirectory } from "./cockpit-meeting-directory";
import { WS, MEETING, OP, summary, operation, directoryId } from "./meeting-directory-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";

const navigation = vi.hoisted(() => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams(), push: vi.fn() }));
vi.mock("../../navigation", () => ({ useNavigation: () => navigation, AppLink: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a> }));
vi.mock("../../common/local-path-link", () => ({ LocalPathLink: ({ path }: { path: string }) => <span>{path}</span> }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { getCockpitMeetingDirectorySummary: vi.fn(), getCockpitDirectoryOperations: vi.fn() } }));
beforeEach(() => { vi.clearAllMocks(); useCockpitScopeViewStore.getState().reset(); useCockpitMeetingDirectoryDraftStore.getState().clearDraft(); navigation.searchParams = new URLSearchParams(`meeting=${MEETING}&meeting_view=resources&agenda=${directoryId(90)}&preparation=${directoryId(91)}&meeting_q=release`); });
function setup(available = true, operationId: string | null = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitMeetingDirectory wsId={WS} meetingId={MEETING} available={available} active operationId={operationId} onManageMeeting={vi.fn()} /></I18nProvider></QueryClientProvider>);
}
describe("meeting directory entry", () => {
  it("loads history only when opened, limits pages to 25 and preserves recovery when a later page fails", async () => {
    vi.mocked(api.getCockpitMeetingDirectorySummary).mockResolvedValue({ ...summary(), current: null, history_total: 26 });
    const first = Array.from({ length: 25 }, (_, index) => ({ ...operation(), id: directoryId(100 + index), target: { ...operation().target, directory: `/approved/meeting-${index}` } }));
    vi.mocked(api.getCockpitDirectoryOperations).mockImplementation(async (_ws, _meeting, query) => {
      if (query?.cursor) throw new Error("Temporary page failure");
      return { workspace_id: WS, meeting_id: MEETING, items: first, page_size: 25, total: 26, next_cursor: "next-history-page" };
    });
    setup(); const open = await screen.findByRole("button", { name: "Directory history (26)" }); expect(api.getCockpitDirectoryOperations).not.toHaveBeenCalled(); fireEvent.click(open);
    await screen.findByRole("link", { name: "/approved/meeting-24" }); expect(screen.getAllByRole("listitem")).toHaveLength(25);
    expect(vi.mocked(api.getCockpitDirectoryOperations).mock.calls[0]?.[2]).toEqual({ cursor: undefined, page_size: 25 });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Previous page" })).toBeEnabled());
    await screen.findByRole("button", { name: enCockpit.task_flow.first_page });
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    await screen.findByRole("link", { name: "/approved/meeting-24" });
    expect(api.getCockpitDirectoryOperations).toHaveBeenCalledTimes(2);
  });

  it("offers a precise return from an unsupported directory deep link without dropping the meeting context", () => {
    navigation.searchParams.set("directory_operation", OP); setup(false, OP);
    expect(screen.getByText(enCockpit.feature_availability.unavailable)).toBeVisible();
    const link = screen.getByRole("link", { name: enCockpit.meeting_directory.return_materials });
    const href = new URL(link.getAttribute("href")!, "https://example.test");
    expect(href.searchParams.get("directory_operation")).toBeNull(); expect(href.searchParams.get("meeting")).toBe(MEETING);
    expect(href.searchParams.get("agenda")).toBe(directoryId(90)); expect(href.searchParams.get("preparation")).toBe(directoryId(91)); expect(href.searchParams.get("meeting_q")).toBe("release");
    expect(api.getCockpitMeetingDirectorySummary).not.toHaveBeenCalled(); expect(api.getCockpitDirectoryOperations).not.toHaveBeenCalled();
  });
});
