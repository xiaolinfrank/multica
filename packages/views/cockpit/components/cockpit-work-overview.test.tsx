import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@multica/core/api";
import { I18nProvider } from "@multica/core/i18n/react";
import { resetAllRegisteredDrafts } from "@multica/core/drafts/cleanup-registry";
import { useCockpitDashboardViewStore } from "@multica/core/cockpit";
import { CockpitWorkOverview } from "./cockpit-work-overview";
import { overviewAttention, overviewScope, workOverview } from "./overview-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";
import enIssues from "../../locales/en/issues.json";

vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: {
  getCockpitWorkOverview: vi.fn(), getCockpitOverviewAttention: vi.fn(), getCockpitOverviewExecution: vi.fn(), getCockpitOverviewMeetings: vi.fn(), searchProjects: vi.fn(),
} }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ cockpit: () => "/ws/cockpit", issueDetail: (id: string) => `/ws/issues/${id}` }) }));
vi.mock("../../navigation", () => ({ AppLink: ({ href, children, newTabTitle: _title, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { newTabTitle?: string }) => <a href={href} {...props}>{children}</a> }));

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, issues: enIssues } }}>
    <CockpitWorkOverview wsId="ws-1" today="2026-10-10" onOpenArea={vi.fn()} />
  </I18nProvider></QueryClientProvider>);
}
function queue() { return within(screen.getByRole("region", { name: "Next actions" })); }
function scrollElement(): HTMLElement {
  const element = screen.getByRole("region", { name: "Work overview" }).children[1];
  if (!(element instanceof HTMLElement)) throw new Error("Overview scroll surface missing");
  return element;
}
beforeEach(() => {
  vi.clearAllMocks(); useCockpitDashboardViewStore.getState().reset();
  vi.mocked(api.getCockpitWorkOverview).mockImplementation(async (_wsId, query) => {
    const result = workOverview();
    return { ...result, attention: { ...result.attention, view: query.attention_view ?? "mine", total: query.attention_view === "team" ? 100 : 40 } };
  });
  vi.mocked(api.getCockpitOverviewAttention).mockImplementation(async (_wsId, query) => ({ ...overviewScope, view: query.view, kind: query.kind ?? "",
    items: [overviewAttention(query.page_size === 25 ? 25 : 9)], total: query.view === "team" ? 100 : 40, next_cursor: null }));
  vi.mocked(api.searchProjects).mockResolvedValue({ projects: [] });
});

describe("work overview read model", () => {
  it("uses only the bundled preview, retains old unresolved work, and opens actual destinations without granting approval", async () => {
    const result = workOverview();
    result.attention.items[0] = overviewAttention(1, { can_act: false });
    vi.mocked(api.getCockpitWorkOverview).mockResolvedValue(result);
    setup();
    await screen.findByText("Open item 1");
    expect(queue().getAllByRole("article")).toHaveLength(8);
    expect(within(queue().getByRole("article", { name: "Open item 1" })).getByRole("link", { name: "View details" })).toHaveAttribute("href", "/ws/issues/issue-1");
    expect(queue().getAllByText(/2024/)).toHaveLength(8);
    expect(api.getCockpitOverviewAttention).not.toHaveBeenCalled();
    expect(api.getCockpitOverviewExecution).not.toHaveBeenCalled();
    expect(api.getCockpitOverviewMeetings).not.toHaveBeenCalled();
    expect(api.searchProjects).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Business overview" })).toHaveAttribute("href", "/ws/cockpit?view=operations");
    expect(screen.getByRole("link", { name: /Release verification/ })).toHaveAttribute("href", "/ws/cockpit?node=node-1");
    expect(screen.getByRole("link", { name: /Release review/ })).toHaveAttribute("href", "/ws/cockpit?meeting=meeting-1");
  });

  it("continues the preview with size 8, starts the complete queue at 25 without its cursor, and resets scope for Team", async () => {
    setup(); await screen.findByText("Open item 1");
    fireEvent.click(queue().getByRole("button", { name: "Next page" }));
    await screen.findByText("Open item 9");
    expect(vi.mocked(api.getCockpitOverviewAttention).mock.lastCall?.[1]).toMatchObject({ page_size: 8, cursor: "preview-next", view: "mine" });
    fireEvent.click(screen.getByRole("button", { name: "View all next actions" }));
    await screen.findByText("Open item 25");
    expect(vi.mocked(api.getCockpitOverviewAttention).mock.lastCall?.[1]).toMatchObject({ page_size: 25, cursor: undefined, view: "mine" });
    expect(queue().getByRole("button", { name: "Previous page" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Team queue" }));
    await waitFor(() => expect(vi.mocked(api.getCockpitOverviewAttention).mock.lastCall?.[1]).toMatchObject({ page_size: 25, cursor: undefined, view: "team" }));
    expect(screen.getByRole("button", { name: "Back to work overview" })).toBeVisible();
  });

  it("makes exception counts' broad issue-queue destination visible and uses the same audience", async () => {
    setup(); await screen.findByText("Open item 1");
    const overdue = screen.getByRole("button", { name: "Your overdue issues: 4. Open issue queue" });
    expect(overdue).toHaveTextContent("Open issue queue");
    fireEvent.click(overdue);
    await waitFor(() => expect(vi.mocked(api.getCockpitOverviewAttention).mock.lastCall?.[1]).toMatchObject({ page_size: 25, kind: "issue", view: "mine", cursor: undefined }));
  });

  it("keeps unknown targets read-only and directs backlog recovery to the identified minutes issue", async () => {
    const result = workOverview();
    result.attention.items = [overviewAttention(1, { kind: "future_kind", reason: "future_reason", target: { ...overviewAttention(1).target, kind: "future_target" } }),
      overviewAttention(2, { kind: "workflow", reason: "restore_backlog", next_action: "restore_backlog", target: { ...overviewAttention(2).target, kind: "meeting", id: "meeting-2", meeting_id: "meeting-2", issue_id: "minutes-2" } })];
    vi.mocked(api.getCockpitWorkOverview).mockResolvedValue(result);
    setup(); await screen.findByText("Open item 1");
    expect(within(queue().getByRole("article", { name: "Open item 1" })).queryByRole("link")).toBeNull();
    expect(queue().getByRole("link", { name: "Open minutes issue" })).toHaveAttribute("href", "/ws/issues/minutes-2");
  });

  it("keeps a failed project scope explicit and recoverable without silently querying all projects", async () => {
    useCockpitDashboardViewStore.getState().update("ws-1", { projectId: "deleted-project" });
    vi.mocked(api.getCockpitWorkOverview).mockResolvedValue(null);
    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent("This view could not be loaded");
    expect(screen.getByRole("button", { name: "Project scope" })).toBeVisible();
    expect(vi.mocked(api.getCockpitWorkOverview).mock.lastCall?.[1].project_id).toBe("deleted-project");
    expect(screen.queryByRole("region", { name: "Execution snapshot" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Project scope" }));
    fireEvent.click(await screen.findByRole("button", { name: "All projects" }));
    await waitFor(() => expect(vi.mocked(api.getCockpitWorkOverview).mock.lastCall?.[1].project_id).toBeUndefined());
  });

  it("marks a failed refresh as stale without replacing known counts with zero", async () => {
    setup(); await screen.findByText("Open item 1");
    vi.mocked(api.getCockpitWorkOverview).mockRejectedValue(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh overview" }));
    await screen.findByText("Refresh failed. Showing the last confirmed snapshot.");
    expect(within(screen.getByRole("region", { name: "Execution snapshot" })).getByText("8")).toBeVisible();
  });

  it("restores scroll after the required data arrives and remembers it across an ordinary return", async () => {
    useCockpitDashboardViewStore.getState().update("ws-1", { scrollTop: 360 });
    const view = setup(); await screen.findByText("Open item 1");
    await waitFor(() => expect(scrollElement().scrollTop).toBe(360));
    fireEvent.scroll(scrollElement(), { target: { scrollTop: 720 } });
    view.unmount();
    expect(useCockpitDashboardViewStore.getState().views["ws-1"]?.scrollTop).toBe(720);
    setup(); await screen.findByText("Open item 1");
    await waitFor(() => expect(scrollElement().scrollTop).toBe(720));
  });

  it("does not recreate session context when logout clears it before unmount", async () => {
    const view = setup(); await screen.findByText("Open item 1");
    fireEvent.scroll(scrollElement(), { target: { scrollTop: 720 } });
    act(() => resetAllRegisteredDrafts());
    view.unmount();
    expect(useCockpitDashboardViewStore.getState().views).toEqual({});
  });
});
