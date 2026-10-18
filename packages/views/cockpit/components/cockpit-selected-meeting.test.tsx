import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import { CockpitMeetingSchema, CockpitMeetingIssueLinkSchema, EMPTY_COCKPIT_BOARD, EMPTY_COCKPIT_MEETING_WORKFLOW } from "@multica/core/api/schemas";
import enCockpit from "../../locales/en/cockpit.json";
import { workflowSummary } from "./workflow-test-fixtures";
import { cockpitMeetingDetailFixture } from "./cockpit-read-test-fixture";
import { CockpitSelectedMeeting } from "./cockpit-selected-meeting";
import type { CockpitMeetingPanelProps } from "./cockpit-meeting-panel";
vi.mock("@multica/core/api", () => ({ api: { getCockpit: vi.fn(), getCockpitMeetingDetail: vi.fn(), getCockpitMeetingIssues: vi.fn(), getCockpitMeetingNodes: vi.fn(), getCockpitMeetingWorkflowSummary: vi.fn(), searchCockpitScopeMembers: vi.fn(), listCockpitDirectory: vi.fn(), appendCockpitMeetingIssue: vi.fn(), setCockpitMeetingIssueRolesCompact: vi.fn() } }));
vi.mock("../../navigation", () => ({ useNavigation: () => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams("meeting=meeting-1"), push: vi.fn() }), AppLink: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a> }));
vi.mock("./cockpit-meeting-panel", () => ({ CockpitMeetingPanel: (props: CockpitMeetingPanelProps) => <section aria-label="Meeting workspace"><p>{props.meeting.title}</p>{props.notice}
  <section aria-label="Linked issues">{props.issuePaging}<ul>{props.issueLinks.map((link) => <li key={link.issue_id}>{link.issue_title}</li>)}</ul>
    <button disabled={props.readOnly} onClick={() => { void props.onLinkIssue("extra-issue"); }}>Add reference</button>
    <button disabled={props.readOnly} onClick={() => { void props.onSaveIssueRoles?.("issue-1", ["preparation"]); }}>Save purpose</button>
  </section><section aria-label="Linked nodes">{props.nodePaging}</section></section> }));
const links = Array.from({ length: 27 }, (_, index) => CockpitMeetingIssueLinkSchema.parse({ meeting_id: "meeting-1", issue_id: `issue-${index + 1}`, issue_identifier: `T-${index + 1}`, issue_title: `Linked task ${index + 1}`, role: "", roles: [], required_roles: [] }));
const board = { ...structuredClone(EMPTY_COCKPIT_BOARD), meetings: [CockpitMeetingSchema.parse({ id: "meeting-1", title: "Exact meeting" })], meeting_issues: links };
const scope = { projectId: null, moduleId: null };
function setup() { const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitSelectedMeeting wsId="ws-1" meetingId="meeting-1" scope={scope} onClose={vi.fn()} onOpenNode={vi.fn()} /></I18nProvider></QueryClientProvider>); }
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.getCockpitMeetingDetail).mockResolvedValue(cockpitMeetingDetailFixture(board, "meeting-1"));
  vi.mocked(api.getCockpitMeetingWorkflowSummary).mockResolvedValue(workflowSummary({ ...EMPTY_COCKPIT_MEETING_WORKFLOW, meeting_id: "meeting-1" }));
  vi.mocked(api.searchCockpitScopeMembers).mockResolvedValue({ workspace_id: "ws-1", scope: { q: "", ids: ["user-1"] }, items: [], total: 0, filtered_total: 0, next_cursor: null });
  vi.mocked(api.listCockpitDirectory).mockResolvedValue({ entries: [] });
  vi.mocked(api.getCockpitMeetingIssues).mockResolvedValue({ workspace_id: "ws-1", object_id: "meeting-1", kind: "meeting_issues", items: links.slice(25), total: 27, next_cursor: null, payment_total: 0 });
  vi.mocked(api.appendCockpitMeetingIssue).mockResolvedValue(CockpitMeetingIssueLinkSchema.parse({ meeting_id: "meeting-1", issue_id: "extra-issue" }));
  vi.mocked(api.setCockpitMeetingIssueRolesCompact).mockResolvedValue({ ...links[0]!, roles: ["preparation"] });
});
describe("independently loaded meeting workbench", () => {
  it("reads one meeting and 25 relationships, then requests only the selected relationship continuation", async () => {
    setup(); const region = within(await screen.findByRole("region", { name: "Linked issues" })); expect(region.getAllByRole("listitem")).toHaveLength(25); expect(region.queryByText("Linked task 26")).toBeNull();
    expect(api.getCockpit).not.toHaveBeenCalled(); expect(api.getCockpitMeetingIssues).not.toHaveBeenCalled();
    fireEvent.click(region.getByRole("button", { name: "Next page" })); expect(await region.findByText("Linked task 27")).toBeVisible();
    expect(api.getCockpitMeetingIssues).toHaveBeenCalledWith("ws-1", "meeting-1", "25", expect.any(AbortSignal)); expect(region.getAllByRole("listitem")).toHaveLength(2);
  });
  it("retains a previous-page recovery when a continuation fails, without inventing an empty relation set", async () => {
    vi.mocked(api.getCockpitMeetingIssues).mockRejectedValue(new Error("expired cursor")); setup(); const region = within(await screen.findByRole("region", { name: "Linked issues" }));
    fireEvent.click(region.getByRole("button", { name: "Next page" })); expect(await region.findByRole("alert")).toHaveTextContent("Could not load");
    fireEvent.click(region.getByRole("button", { name: "Previous page" })); expect(await region.findByText("Linked task 25")).toBeVisible();
  });
  it("uses single-link commands for appending and purpose edits instead of replacing a paged collection", async () => {
    setup(); await screen.findByText("Exact meeting"); fireEvent.click(screen.getByRole("button", { name: "Add reference" }));
    await waitFor(() => expect(api.appendCockpitMeetingIssue).toHaveBeenCalledWith("ws-1", "meeting-1", "extra-issue"));
    fireEvent.click(screen.getByRole("button", { name: "Save purpose" })); await waitFor(() => expect(api.setCockpitMeetingIssueRolesCompact).toHaveBeenCalledWith("ws-1", "meeting-1", "issue-1", ["preparation"]));
  });
});
