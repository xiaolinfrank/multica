// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@multica/core/api";
import type { CockpitIssueMeetingReference, CockpitIssueReferencePage } from "@multica/core/types";
import { WorkspaceSlugProvider } from "@multica/core/paths";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider } from "../../navigation";
import type { NavigationAdapter } from "../../navigation/types";
import { CockpitMeetingsSection } from "./cockpit-meetings-section";
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/api", () => ({ api: { getCockpit: vi.fn(), getCockpitIssueMeetingReferences: vi.fn(), getCockpitMeetingRegister: vi.fn(), getCockpitIssueActionSources: vi.fn(), appendCockpitMeetingIssue: vi.fn(), removeCockpitIssueMeetingReference: vi.fn() } }));
const adapter: NavigationAdapter = { push: vi.fn(), replace: vi.fn(), back: vi.fn(), pathname: "/", searchParams: new URLSearchParams(), hash: "", getShareableUrl: (path) => path };
const ref = (id = "meeting-1", title = "Review"): CockpitIssueMeetingReference => ({ meeting_id: id, code: "M-01", title, meet_date: "2026-10-10", available: true, role: "task", roles: [], required_roles: [], can_unlink: true });
let page: CockpitIssueReferencePage<CockpitIssueMeetingReference>;
function renderSection(issueId = "issue-1") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return renderWithI18n(<QueryClientProvider client={client}><WorkspaceSlugProvider slug="acme"><NavigationProvider value={adapter}><CockpitMeetingsSection issueId={issueId} /></NavigationProvider></WorkspaceSlugProvider></QueryClientProvider>);
}
beforeEach(() => {
  cleanup(); vi.clearAllMocks();
  page = { workspace_id: "ws-1", issue_id: "issue-1", items: [ref()], total: 1, next_cursor: null };
  vi.mocked(api.getCockpitIssueMeetingReferences).mockImplementation(async () => structuredClone(page));
  vi.mocked(api.getCockpitIssueActionSources).mockResolvedValue({ issue_id: "issue-1", items: [], total: 0, next_cursor: null });
  vi.mocked(api.getCockpitMeetingRegister).mockImplementation(async (_ws, _scope, query) => ({ workspace_id: "ws-1", scope: { project_id: null, module_id: null, project_title: "", module_title: "" }, node_id: null, node_ids: [], day_counts: [], date_from: null, date_to: null,
    items: [{ id: query?.cursor ? "meeting-3" : "meeting-2", code: query?.cursor ? "M-03" : "M-02", title: "Candidate meeting" }], total: 30, next_cursor: query?.cursor ? null : "next-search" }) as unknown as Awaited<ReturnType<typeof api.getCockpitMeetingRegister>>);
  vi.mocked(api.removeCockpitIssueMeetingReference).mockImplementation(async (_ws, issueId, targetId) => {
    page.items = page.items.filter((item) => item.meeting_id !== targetId); page.total = page.items.length;
    return { workspace_id: "ws-1", issue_id: issueId, kind: "meeting", target_id: targetId, removed: true };
  });
  vi.mocked(api.appendCockpitMeetingIssue).mockResolvedValue({ meeting_id: "meeting-2", issue_id: "issue-1", issue_number: 1, issue_identifier: "BIO-1", issue_title: "Issue", issue_status: "backlog", role: "", roles: [], required_roles: [], position: 0 } as Awaited<ReturnType<typeof api.appendCockpitMeetingIssue>>);
});
describe("bounded issue meeting references", () => {
  it("removes only an explicit direct reference while preserving the meeting's agenda source", async () => {
    page.items = [{ ...ref(), has_direct_reference: true, has_agenda_reference: true, agenda_id: "agenda-1", agenda_total: 2 }];
    vi.mocked(api.removeCockpitIssueMeetingReference).mockImplementationOnce(async (_ws, issueId, targetId) => {
      page.items = [{ ...page.items[0]!, has_direct_reference: false, can_unlink: false }];
      return { workspace_id: "ws-1", issue_id: issueId, kind: "meeting", target_id: targetId, removed: true };
    });
    renderSection(); const agenda = await screen.findByRole("link", { name: "Open agenda & preparation" });
    expect(agenda).toHaveAttribute("href", "/acme/cockpit?meeting=meeting-1&agenda=agenda-1&meeting_view=agenda");
    fireEvent.click(screen.getByRole("button", { name: "Remove direct meeting link: M-01 Review" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove direct meeting link: M-01 Review" })).toBeNull());
    expect(screen.getByRole("link", { name: "M-01 Review" })).toBeVisible(); expect(screen.getByRole("link", { name: "Open agenda & preparation" })).toBeVisible();
  });

  it("reads lightweight reverse links including the filing role without the board", async () => {
    renderSection(); expect(await screen.findByRole("link", { name: "M-01 Review" })).toHaveAttribute("href", "/acme/cockpit?meeting=meeting-1");
    expect(api.getCockpitIssueMeetingReferences).toHaveBeenCalledWith("ws-1", "issue-1", { cursor: undefined }, expect.any(AbortSignal));
    expect(api.getCockpit).not.toHaveBeenCalled(); expect(api.getCockpitMeetingRegister).not.toHaveBeenCalled();
  });
  it("protects formal and retired review relationships while manual purposes remain removable", async () => {
    page.items = [{ ...ref("retired", "Retired review"), roles: ["review"], required_roles: ["review"], can_unlink: false }, { ...ref(), roles: ["review", "future_role"] }]; page.total = 2;
    renderSection(); const protectedRow = (await screen.findByRole("link", { name: "M-01 Retired review" })).closest("li")!;
    expect(protectedRow).toHaveTextContent("Managed by the meeting workflow"); expect(within(protectedRow).getByRole("button")).toBeDisabled();
    expect(screen.getByText("Other: future_role")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Unlink M-01 Review" })); await waitFor(() => expect(api.removeCockpitIssueMeetingReference).toHaveBeenCalledWith("ws-1", "issue-1", "meeting-1"));
  });
  it("shows fixed action sources independently from mutable references", async () => {
    vi.mocked(api.getCockpitIssueActionSources).mockResolvedValue({ issue_id: "issue-1", total: 1, next_cursor: null, items: [{ id: "action-1", meeting_id: "meeting-1", meeting_code: "M-01", meeting_title: "Delivery review", version_id: "v1", version_number: 1, title: "Verify interface" }] });
    renderSection(); const sources = await screen.findByRole("region", { name: "Meeting action sources" });
    expect(within(sources).getByRole("link", { name: "M-01 Delivery review" })).toHaveAttribute("href", "/acme/cockpit?meeting=meeting-1&action=action-1");
    expect(within(sources).queryByRole("button", { name: /Unlink/ })).toBeNull(); expect(sources).toHaveTextContent("Minutes v1 · Verify interface");
  });
  it("keeps orphan and unnamed references readable and cleans only the explicit orphan", async () => {
    page.items = [{ ...ref("missing", ""), available: false, can_unlink: true, code: "" }, { ...ref("untitled", ""), code: "", meet_date: "" }]; page.total = 2; renderSection();
    await screen.findByText("Meeting unavailable"); expect(screen.getByRole("link", { name: "Untitled meeting" })).toHaveAttribute("href", "/acme/cockpit?meeting=untitled");
    expect(screen.getAllByRole("link")).toHaveLength(1); expect(api.removeCockpitIssueMeetingReference).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove unavailable meeting reference missing" }));
    await waitFor(() => expect(api.removeCockpitIssueMeetingReference).toHaveBeenCalledWith("ws-1", "issue-1", "missing"));
    expect(screen.getByRole("link", { name: "Untitled meeting" })).toBeInTheDocument();
  });
  it("uses encoded identities through the workspace navigation adapter", async () => {
    const id = "会议/1?scope=a&b"; page.items = [ref(id)]; renderSection(); const row = await screen.findByRole("link", { name: "M-01 Review" });
    const href = `/acme/cockpit?meeting=${encodeURIComponent(id)}`; expect(row).toHaveAttribute("href", href); fireEvent.click(row); expect(adapter.push).toHaveBeenCalledWith(href);
  });
  it("searches and pages meeting choices on demand, then appends only the chosen pair", async () => {
    renderSection(); await screen.findByRole("link", { name: "M-01 Review" }); const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add meeting" })); await screen.findByRole("button", { name: "M-02 Candidate meeting" });
    await user.click(screen.getByRole("button", { name: "Next page" })); await screen.findByRole("button", { name: "M-03 Candidate meeting" });
    expect(api.getCockpitMeetingRegister).toHaveBeenLastCalledWith("ws-1", { projectId: null, moduleId: null }, { q: "", cursor: "next-search", page_size: 25 }, expect.any(AbortSignal));
    await user.type(screen.getByRole("textbox", { name: "Search by number, name or parties" }), "Candidate");
    await waitFor(() => expect(api.getCockpitMeetingRegister).toHaveBeenLastCalledWith("ws-1", { projectId: null, moduleId: null }, { q: "Candidate", cursor: undefined, page_size: 25 }, expect.any(AbortSignal)));
    await user.click(await screen.findByRole("button", { name: "M-02 Candidate meeting" })); await waitFor(() => expect(api.appendCockpitMeetingIssue).toHaveBeenCalledWith("ws-1", "meeting-2", "issue-1"));
    expect(screen.queryByRole("textbox", { name: "Search by number, name or parties" })).toBeNull();
  });
  it("keeps the choice and error visible until an append is confirmed", async () => {
    let reject!: (error: Error) => void;
    vi.mocked(api.appendCockpitMeetingIssue).mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    renderSection(); await screen.findByRole("link", { name: "M-01 Review" });
    fireEvent.click(screen.getByRole("button", { name: "Add meeting" }));
    fireEvent.click(await screen.findByRole("button", { name: "M-02 Candidate meeting" }));
    await waitFor(() => expect(api.appendCockpitMeetingIssue).toHaveBeenCalled());
    expect(screen.getByRole("textbox", { name: "Search by number, name or parties" })).toBeInTheDocument();
    reject(new Error("Result not confirmed"));
    await screen.findByText("Result not confirmed");
    expect(screen.getByRole("button", { name: "M-02 Candidate meeting" })).toBeEnabled();
  });

  it("paginates references using server totals rather than an in-memory board", async () => {
    page.total = 31; page.next_cursor = "next-ref";
    vi.mocked(api.getCockpitIssueMeetingReferences).mockImplementation(async (_ws, _issue, query) => ({ ...page, items: [ref(query?.cursor ? "last" : "first", query?.cursor ? "Last" : "First")], next_cursor: query?.cursor ? null : "next-ref" }));
    renderSection(); await screen.findByRole("link", { name: "M-01 First" }); fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByRole("link", { name: "M-01 Last" }); expect(api.getCockpitIssueMeetingReferences).toHaveBeenLastCalledWith("ws-1", "issue-1", { cursor: "next-ref" }, expect.any(AbortSignal));
  });
  it("shows failed reads honestly and preserves add/collapse on a confirmed empty page", async () => {
    vi.mocked(api.getCockpitIssueMeetingReferences).mockRejectedValueOnce(new Error("Offline")); page.items = []; page.total = 0; renderSection();
    await screen.findByRole("alert"); expect(screen.queryByText("No meetings linked.")).toBeNull(); fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("No meetings linked."); expect(screen.getByRole("button", { name: "Add meeting" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /Meetings/ })); expect(screen.queryByRole("button", { name: "Add meeting" })).toBeNull();
  });
});
