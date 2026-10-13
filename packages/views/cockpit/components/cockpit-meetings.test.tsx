import { resetCockpitTestNavigation, useCockpitTestNavigation } from "./cockpit-navigation-test-fixture";
import { workflowFixture, workflowSummary, compactWorkflow } from "./workflow-test-fixtures";
import { EMPTY_COCKPIT_MEETING_WORKFLOW } from "@multica/core/api/schemas";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import enCockpit from "../../locales/en/cockpit.json";
import enCommon from "../../locales/en/common.json";
// The folder field reuses the project collaboration path's wording, because
// the server applies one rule to both and a rule is stated once.
import enProjects from "../../locales/en/projects.json";
import type { CockpitBoard, CockpitMeeting, CockpitDirectoryEntry } from "@multica/core/types";

// The register's wiring: the tab renders the board's meetings, the four views
// are reachable, selecting one opens its panel, and filing one shows the name
// and the destination BEFORE it creates anything.
//
// The calendar maths, the generated name and the link grouping are pinned in
// packages/core/cockpit/meetings.test.ts (node suite); this file does not
// re-test them.

vi.mock("../../common/actor-avatar", () => ({ ActorAvatar: () => <span /> }));

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ cockpit: () => "/ws/cockpit", projects: () => "/ws/projects", projectDetail: (id: string) => `/ws/projects/${id}`, settings: () => "/ws/settings", issueDetail: (id: string) => `/ws/issues/${id}`, memberDetail: (id: string) => `/ws/members/${id}`, agentDetail: (id: string) => `/ws/agents/${id}`, squadDetail: (id: string) => `/ws/squads/${id}` }),
}));

vi.mock("../../navigation", async () => {
  const fixture = await import("./cockpit-navigation-test-fixture");
  return { useNavigation: fixture.useCockpitTestNavigation, AppLink: fixture.CockpitTestLink };
});

vi.mock("@multica/core/api", async (original) => ({
  ...(await original<typeof import("@multica/core/api")>()),
  api: {
    getBaseUrl: () => "https://example.test",
    getCockpitNodeIndex: vi.fn(), searchCockpitAssignees: vi.fn(), getCockpit: vi.fn(), getCockpitContext: vi.fn(), getCockpitPlan: vi.fn(), getCockpitMeetingDetail: vi.fn(), getCockpitNodeDetail: vi.fn(),
    getCockpitMeetingRegister: vi.fn(), getCockpitMeetingNextCode: vi.fn(), searchCockpitScopes: vi.fn(), searchCockpitScopeMembers: vi.fn(), searchCockpitScopeNodes: vi.fn(),
    appendCockpitMeetingIssue: vi.fn(), appendCockpitMeetingNode: vi.fn(), getCockpitNodeCodePreview: vi.fn(),
    getCockpitMeetingWorkflowSummary: vi.fn(),
    commandCockpitMeetingWorkflow: vi.fn(),
    updateCockpit: vi.fn(),
    createCockpitNode: vi.fn(),
    updateCockpitNode: vi.fn(),
    deleteCockpitNode: vi.fn(),
    setCockpitNodeIssues: vi.fn(),
    deleteCockpitNodeIssue: vi.fn(),
    createCockpitPayment: vi.fn(),
    updateCockpitPayment: vi.fn(),
    deleteCockpitPayment: vi.fn(),
    createCockpitMilestone: vi.fn(),
    updateCockpitMilestone: vi.fn(),
    deleteCockpitMilestone: vi.fn(),
    createCockpitMeeting: vi.fn(),
    getCockpitDirectoryPage: vi.fn(), upsertCockpitDirectoryCompact: vi.fn(), deleteCockpitDirectoryCompact: vi.fn(),
    listCockpitDirectory: vi.fn(),
    upsertCockpitDirectory: vi.fn(),
    deleteCockpitDirectoryEntry: vi.fn(),
    updateCockpitMeeting: vi.fn(),
    deleteCockpitMeeting: vi.fn(),
    provisionCockpitMeeting: vi.fn(),
    getCockpitMeetingDestination: vi.fn(),
    scanCockpitMeetingFolders: vi.fn(),
    importCockpitMeetingFolders: vi.fn(),
    setCockpitMeetingIssues: vi.fn(),
    deleteCockpitMeetingIssue: vi.fn(),
    setCockpitMeetingNodes: vi.fn(),
    deleteCockpitMeetingNode: vi.fn(),
    listProjects: vi.fn(),
    listModules: vi.fn(),
    searchIssues: vi.fn(),
    listCockpitSnapshots: vi.fn(),
    createCockpitSnapshot: vi.fn(),
    restoreCockpitSnapshot: vi.fn(),
    deleteCockpitSnapshot: vi.fn(),
    listCockpitChanges: vi.fn(),
    createCockpitChange: vi.fn(),
    applyCockpitChange: vi.fn(),
    rejectCockpitChange: vi.fn(),
    withdrawCockpitChange: vi.fn(),
    listMembers: vi.fn(),
  },
}));

vi.mock("@multica/core/auth", () => {
  const useAuthStore = Object.assign(
    (selector?: (state: { user: { id: string } }) => unknown) =>
      selector ? selector({ user: { id: "user-1" } }) : { user: { id: "user-1" } },
    { getState: () => ({ user: { id: "user-1" } }) },
  );
  return { useAuthStore };
});

import { api } from "@multica/core/api";
import { CockpitPage } from "./cockpit-entry";
import { useCockpitScopeViewStore, useCockpitMeetingCreateDraftStore } from "@multica/core/cockpit";
import { cockpitContextFixture, cockpitPlanFixture, cockpitMeetingDetailFixture, cockpitNodeDetailFixture, cockpitMeetingRegisterFixture } from "./cockpit-read-test-fixture";

/** Today in the viewer's own calendar — what the page computes for itself. */
function todayString(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** "20260921" — the day part of a meeting number. */
function codeDay(offsetDays = 0): string {
  return todayString(offsetDays).replaceAll("-", "");
}

function meeting(over: Partial<CockpitMeeting> & { id: string }): CockpitMeeting {
  return {
    meet_date: null, time_range: "", start_time: null, end_time: null, title: "",
    code: "", kind: "", status: "", parties: "", organizer: "", location: "",
    attendees: "", meet_no: "", link: "", note: "", minutes: "", decisions: "", actions: "",
    nas_dir: "", detected: false, track: "", ...over,
  };
}

const board: CockpitBoard = {
  cockpit: {
    id: "cp",
    workspace_id: "ws-1",
    title: "Programme board",
    goal_title: "End-to-end demo",
    goal_date: "2026-12-31",
    summary_overall: "",
    summary_next: "",
    summary_support: "",
    basis: "",
    meeting_assignee_type: "",
    meeting_assignee_id: null,
    meeting_project_id: "project-06",
    meeting_module_id: "module-0606",
    meeting_node_id: "node-060603",
    meeting_dir: "",
    created_at: "",
    updated_at: "",
  },
  nodes: [
    {
      id: "root", cockpit_id: "cp", parent_id: null, project_id: "project-06", code: "L1-06", name: "Programme management",
      position: 0, color: "#2563eb", owner: "", collaborators: "", start_date: null, end_date: null,
      status: "", progress: 0, deliverable: "", dependencies: "", note: "", current_progress: "",
      vendor: "", budget_category: "", budget_amount: null, exec_status: "", contract: "",
      source: "", updated_by_type: "", updated_by_id: null, created_at: "", updated_at: "",
    },
    {
      id: "n0606", cockpit_id: "cp", parent_id: "root", project_id: "project-06", module_id: "module-0606", code: "06.06", name: "Joint working and meetings",
      position: 0, color: "", owner: "", collaborators: "", start_date: null, end_date: null,
      status: "", progress: 0, deliverable: "", dependencies: "", note: "", current_progress: "",
      vendor: "", budget_category: "", budget_amount: null, exec_status: "", contract: "",
      source: "", updated_by_type: "", updated_by_id: null, created_at: "", updated_at: "",
    },
  ],
  payments: [],
  issue_links: [],
  milestones: [],
  meetings: [
    meeting({
      id: "meet-1",
      // Today's first number is already taken, so the form must propose -02.
      code: `${codeDay()}-01`,
      meet_date: todayString(2),
      start_time: "10:00",
      end_time: "11:00",
      title: "Working group weekly",
      kind: "Standing",
      track: "项目管理",
      decisions: "Adopt the v3 data schema",
      parties: "Fosun Pharma、BGI",
      nas_dir: "/Volumes/share/06.06/20260921-01 Working group weekly",
      // The stored folder is a literal path, not a generated one.
    }),
    meeting({
      id: "meet-2",
      code: `${codeDay(-20)}-01`,
      meet_date: todayString(-20),
      title: "Kickoff",
      status: "Held",
    }),
    // An unscheduled draft: the timeline cannot place it and must say so.
    meeting({ id: "meet-3", title: "Compliance review TBD" }),
  ],
  meeting_issues: [
    {
      meeting_id: "meet-1", issue_id: "issue-1", role: "task", roles: [], required_roles: [], issue_number: 42,
      issue_identifier: "BIO-42", issue_title: "Working group weekly", issue_status: "todo",
      position: -1,
    },
  ],
  meeting_nodes: [{ meeting_id: "meet-1", node_id: "n0606", position: 0 }],
};

let fixtureBoard: CockpitBoard;

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, common: enCommon, projects: enProjects } }}>
        <CockpitPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

async function openRegister() {
  resetCockpitTestNavigation("/ws/cockpit?tab=meetings");
  renderPage();
  await within(await screen.findByRole("region", { name: "Meetings" })).findByRole("button", { name: "New meeting" });
}

let directoryEntries: CockpitDirectoryEntry[] = [];

beforeEach(() => {
  useCockpitMeetingCreateDraftStore.getState().clearDraft();
  resetCockpitTestNavigation("/ws/cockpit?tab=meetings");
  useCockpitScopeViewStore.getState().reset();
  vi.clearAllMocks();
  fixtureBoard = structuredClone(board);
  directoryEntries = [];
  vi.mocked(api.getCockpitDirectoryPage).mockImplementation(async (_ws, query = {}) => {
    const entries = directoryEntries.filter((entry) => (!query.parties?.length || query.parties.includes(entry.party)) && (query.party === undefined || query.party === entry.party) && (!query.q || [entry.name, entry.party, entry.position].join(" ").toLowerCase().includes(query.q.toLowerCase())));
    const offset = Number(query.cursor || 0), size = query.page_size ?? 25;
    return { workspace_id: "ws-1", scope: "workspace", q: query.q ?? "", party: query.party ?? null, parties: query.parties ?? null, items: entries.slice(offset, offset + size), total: entries.length, next_cursor: offset + size < entries.length ? String(offset + size) : null };
  });
  vi.mocked(api.upsertCockpitDirectoryCompact).mockImplementation(async (_ws, body) => {
    const entries: CockpitDirectoryEntry[] = [], skipped: { party: string; name: string }[] = [];
    for (const entry of body.entries) {
      if (body.only_unknown_names && directoryEntries.some((current) => current.name === entry.name)) { skipped.push({ party: entry.party, name: entry.name }); continue; }
      const before = directoryEntries.find((current) => current.party === entry.party && current.name === entry.name);
      const next = { party: entry.party, name: entry.name, position: entry.clear_position ? "" : entry.position || before?.position || "", source: before?.source ?? "user" };
      directoryEntries = [...directoryEntries.filter((current) => current.party !== entry.party || current.name !== entry.name), next]; entries.push(next);
    }
    return { workspace_id: "ws-1", scope: "workspace", action: "upserted", entries, skipped, deleted: [] };
  });
  vi.mocked(api.deleteCockpitDirectoryCompact).mockImplementation(async (_ws, key) => {
    directoryEntries = directoryEntries.filter((entry) => entry.name !== key.name || entry.party !== key.party);
    return { workspace_id: "ws-1", scope: "workspace", action: "deleted", entries: [], skipped: [], deleted: [key] };
  });
  fixtureBoard.nodes.push({ ...fixtureBoard.nodes[1]!, id: "node-060603", code: "06.06.03", name: "Minutes and material", parent_id: "n0606", project_id: null, module_id: null });
  vi.mocked(api.updateCockpitMeeting).mockImplementation(async (id, patch) => {
    const found = fixtureBoard.meetings.find((item) => item.id === id); if (!found) throw new Error("Missing meeting fixture");
    const updated = { ...found, ...patch }; fixtureBoard.meetings = fixtureBoard.meetings.map((item) => item.id === id ? updated : item); return updated;
  });
  vi.mocked(api.getCockpitNodeIndex).mockImplementation(async () => ({ workspace_id: "ws-1", items: fixtureBoard.nodes.map(({ id, parent_id, code, position }) => ({ id, parent_id, code, position })), total: fixtureBoard.nodes.length }));
  vi.mocked(api.searchCockpitAssignees).mockImplementation(async (_ws, query) => ({ workspace_id: "ws-1", q: query?.q ?? "", kind: query?.kind ?? "all", selected_type: query?.selected_type ?? null, selected_id: query?.selected_id ?? null,
    items: [{ id: query?.selected_id ?? "user-1", type: "member", title: "Yang Tao", email: "", avatar_url: "", status: "active", runtime_bound: null, can_assign: true, reason: "" }], total: 1, next_cursor: null }));
  vi.mocked(api.getCockpitContext).mockImplementation(async (_ws, scope) => {
    const value = cockpitContextFixture(fixtureBoard, scope);
    return { ...value, scope: { ...value.scope, project_title: scope.projectId ? "06 Programme management" : "", module_title: scope.moduleId ? "06.06 Joint working and meetings" : "" } };
  });
  vi.mocked(api.getCockpitPlan).mockImplementation(async (_ws, scope) => cockpitPlanFixture(fixtureBoard, scope));
  vi.mocked(api.getCockpitMeetingDetail).mockImplementation(async (_ws, id, scope) => cockpitMeetingDetailFixture(fixtureBoard, id, scope));
  vi.mocked(api.getCockpitNodeDetail).mockImplementation(async (_ws, id, scope) => cockpitNodeDetailFixture(fixtureBoard, id, scope));
  vi.mocked(api.getCockpitMeetingRegister).mockImplementation(async (_ws, scope, query) => {
    // Fixed responses for the known filtering scenarios; matching semantics are
    // owned by the service regression, not reimplemented in a browser fixture.
    const ids = query.q === "kickoff" || query.statuses?.includes("Held") ? ["meet-2"]
      : query.q === "v3 data" || query.tracks?.includes("项目管理") || query.only?.includes("consensus") ? ["meet-1"] : null;
    return cockpitMeetingRegisterFixture(ids ? { ...fixtureBoard, meetings: fixtureBoard.meetings.filter((item) => ids.includes(item.id)) } : fixtureBoard, scope, query);
  });
  vi.mocked(api.getCockpitMeetingNextCode).mockImplementation(async (_ws, date) => ({ workspace_id: "ws-1", date, code: `${date.replaceAll("-", "")}-02` }));
  vi.mocked(api.searchCockpitScopes).mockImplementation(async (_ws, kind, query) => ({ workspace_id: "ws-1", project_id: query.project_id ?? null,
    items: [{ id: kind === "projects" ? "project-06" : "module-0606", title: kind === "projects" ? "06 Programme management" : "06.06 Joint working and meetings", project_id: kind === "projects" ? null : "project-06" }], total: 1, next_cursor: null }));
  vi.mocked(api.searchCockpitScopeMembers).mockImplementation(async (_ws, query) => {
    const people = [{ id: "user-1", title: "Yang Tao", avatar_url: "", role: "owner" }, { id: "user-2", title: "Wang Gong", avatar_url: "", role: "member" }];
    const items = people.filter((person) => (!query?.ids?.length || query.ids.includes(person.id)) && (!query?.q || person.title.toLowerCase().includes(query.q.toLowerCase())));
    return { workspace_id: "ws-1", scope: { q: query?.q ?? "", ids: query?.ids ?? [] }, items, total: items.length, filtered_total: items.length, next_cursor: null };
  });
  vi.mocked(api.searchCockpitScopeNodes).mockImplementation(async (_ws, query) => {
    const items = fixtureBoard.nodes.map((node) => { const detail = cockpitNodeDetailFixture(fixtureBoard, node.id); return { id: node.id, title: node.name, code: node.code,
      project_id: detail.binding.project_id, module_id: detail.binding.module_id, eligible: detail.binding.eligible, reason: detail.binding.eligible ? "" : "structural_node" }; })
      .filter((node) => (!query?.eligible || node.eligible) && (!query?.q || node.title.toLowerCase().includes(query.q.toLowerCase())));
    return { workspace_id: "ws-1", scope: { project_id: query?.project_id ?? null, module_id: query?.module_id ?? null, q: query?.q ?? "", eligible: query?.eligible ?? true }, items: items.slice(0,20), total: items.length, filtered_total: items.length, next_cursor: null };
  });

  vi.mocked(api.getCockpitMeetingWorkflowSummary).mockImplementation(async (_wsId, meetingId) => workflowSummary({ ...EMPTY_COCKPIT_MEETING_WORKFLOW, meeting_id: meetingId }));
    vi.mocked(api.listCockpitDirectory).mockResolvedValue({ entries: [] });
  vi.mocked(api.listCockpitSnapshots).mockResolvedValue([]);
  vi.mocked(api.listCockpitChanges).mockResolvedValue([]);
  vi.mocked(api.listMembers).mockResolvedValue([
    { user_id: "user-1", role: "owner", name: "Yang Tao", email: "yangtao@example.com", avatar_url: null },
    { user_id: "user-2", role: "member", name: "Wang Gong", email: "wanggong@example.com", avatar_url: null },
  ] as unknown as Awaited<ReturnType<typeof api.listMembers>>);
  vi.mocked(api.listProjects).mockResolvedValue({ projects: [
    { id: "project-06", title: "06 Programme management" },
  ], total: 1 } as unknown as Awaited<ReturnType<typeof api.listProjects>>);
  vi.mocked(api.listModules).mockResolvedValue({ modules: [
    { id: "module-0606", project_id: "project-06", title: "06.06 Joint working and meetings" },
  ], total: 1 } as unknown as Awaited<ReturnType<typeof api.listModules>>);
  vi.mocked(api.commandCockpitMeetingWorkflow).mockImplementation(async (_wsId, meetingId, command) => {
    if (command.action !== "enabled") throw new Error("Unexpected workflow command in meeting setup fixture");
    const result = workflowFixture({ meeting_id: meetingId, reviewer_id: command.body.reviewer_id });
    vi.mocked(api.getCockpitMeetingWorkflowSummary).mockImplementation(async (_scope, id) => workflowSummary(id === meetingId ? result : { ...EMPTY_COCKPIT_MEETING_WORKFLOW, meeting_id: id }));
    return compactWorkflow(result, command);
  });
  vi.mocked(api.getCockpitMeetingDestination).mockResolvedValue({
    project_id: "project-06",
    project_title: "06 Programme management",
    module_id: "module-0606",
    module_title: "06.06 Joint working and meetings",
    node_id: "node-060603",
    node_code: "06.06.03",
    node_title: "Minutes and material",
    collab_path: "/Volumes/share",
    base_dir: "/Volumes/share/06.06/06.06.03",
    derived: true,
    base_dir_exists: true,
    creatable: true,
    error: "",
  });
  vi.mocked(api.scanCockpitMeetingFolders).mockResolvedValue({
    base_dir: "/Volumes/share/06.06/06.06.03",
    base_dir_exists: true,
    matched: 1,
    truncated: false,
    error: "",
    entries: [
      {
        name: "20260921-01 Working group weekly",
        path: "/Volumes/share/06.06/06.06.03/20260921-01 Working group weekly",
        modified_at: "", files: 3, meeting_id: "meet-1",
        code: "20260921-01", meet_date: "2026-09-21", parties: "", title: "Working group weekly",
      },
      {
        name: "20260920 Unicom trusted connector",
        path: "/Volumes/share/06.06/06.06.03/20260920 Unicom trusted connector",
        modified_at: "", files: 5, meeting_id: "",
        code: "", meet_date: "2026-09-20", parties: "", title: "Unicom trusted connector",
      },
    ],
  });
});

describe("the meeting register", () => {
  it("lists the board's meetings with their number, span and links", async () => {
    await openRegister();

    const row = (await screen.findByText(`${codeDay()}-01`)).closest("li")!;
    expect(within(row).getByText(/10:00–11:00/)).toBeInTheDocument();
    expect(within(row).getByText("Fosun Pharma、BGI")).toBeInTheDocument();
    expect(within(row).getByText("1 issues · 1 work items")).toBeInTheDocument();
    expect(screen.getByText("Kickoff")).toBeInTheDocument();
    expect(api.getCockpit).not.toHaveBeenCalled();
  });

  it("switches between the four views without losing the board", async () => {
    // Keep this shared fixture inside the current week and month. The normal
    // +2-day meeting can fall outside either window at a weekend/month end.
    const visibleInEveryView = structuredClone(board);
    visibleInEveryView.meetings[0]!.meet_date = todayString();
    fixtureBoard = visibleInEveryView;
    await openRegister();
    await screen.findByText(`${codeDay()}-01`);

    for (const view of ["Month", "Week", "Agenda"]) {
      fireEvent.click(screen.getByRole("button", { name: view, pressed: false }));
      expect(screen.getByRole("button", { name: view, pressed: true })).toBeInTheDocument();
      if (view === "Month" || view === "Week") fireEvent.click(await screen.findByRole("button", { name: `Meetings on ${todayString()}: 1` }));
      expect((await screen.findAllByLabelText(/Open Working group weekly/)).length).toBeGreaterThan(0);
    }
  });

  // The confirmation names the record. It used to be handed the delete
  // button's own accessible name, so it offered to permanently remove
  // "Delete meeting Working group weekly".
  it("names the meeting, not the button, when it asks before deleting", async () => {
    await openRegister();
    fireEvent.click(await screen.findByLabelText("Open Working group weekly"));
        fireEvent.click(await screen.findByRole("button", { name: "Meeting actions" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete meeting Working group weekly" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Delete meeting Working group weekly" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText("Working group weekly will be permanently removed. This cannot be undone."),
    ).toBeInTheDocument();
  });

  it("opens one meeting in a panel, with its task, its work item and its folder", async () => {
    await openRegister();
    fireEvent.click(await screen.findByLabelText("Open Working group weekly"));
    fireEvent.click(await screen.findByRole("tab", { name: "Preparation" }));

    // The meeting's own task reads as an ordinary issue.
    expect(await screen.findByText("BIO-42")).toBeInTheDocument();
    // The linked work item is addressed by the code the gantt uses.
    expect(screen.getByRole("button", { name: /Show .*Joint working and meetings/ })).toBeInTheDocument();
    // The folder fact lives in the bottom fact region, no tab needed.
    expect(await screen.findByText("/Volumes/share/06.06/20260921-01 Working group weekly")).toBeInTheDocument();
  });

  it("numbers the work-item picker with the shipped row codes", async () => {
    // A directionless exec row under L1-02 ships as "02.04" once the merged
    // group counts as one row; the base tree would number it "02.05".
    const extra = [
      { ...board.nodes[0]!, id: "l2", code: "L1-02", name: "Platform", parent_id: null },
      { ...board.nodes[0]!, id: "dir1", code: "02.01", name: "Infra", parent_id: "l2" },
      { ...board.nodes[0]!, id: "dir2", code: "02.02", name: "Arch", parent_id: "l2" },
      { ...board.nodes[0]!, id: "dir3", code: "02.03", name: "Data", parent_id: "l2" },
      { ...board.nodes[0]!, id: "dir10", code: "02.10", name: "院端节点与部署", parent_id: "l2" },
      { ...board.nodes[0]!, id: "t2", code: "L3-02-02", name: "Design", parent_id: "dir2" },
      { ...board.nodes[0]!, id: "t3", code: "L3-02-08", name: "Ship", parent_id: "l2" },
    ];
    fixtureBoard = structuredClone({ ...board, nodes: [...board.nodes, ...extra] });
    await openRegister();
    fireEvent.click(await screen.findByLabelText("Open Working group weekly"));
    fireEvent.click(await screen.findByRole("tab", { name: "Preparation" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add work item" }));
    expect(await screen.findByRole("button", { name: /02\.04 Ship/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /02\.05 Ship/ })).not.toBeInTheDocument();
  });

  it("retains a retired review relation from required roles without loading version history", async () => {
    const linked = structuredClone(board);
    linked.meeting_issues.push({ ...linked.meeting_issues[0]!, issue_id: "retired-review", issue_number: 99,
      issue_identifier: "BIO-99", issue_title: "Review from a previous round", role: "", roles: ["review"], required_roles: ["review"] });
    fixtureBoard = linked;
    const summary = workflowSummary(workflowFixture({ meeting_id: "meet-1" }));
    expect(summary.current_version).toBeNull();
    expect(summary.published_version).toBeNull();
    vi.mocked(api.getCockpitMeetingWorkflowSummary).mockResolvedValue(summary);
    await openRegister();
    fireEvent.click(await screen.findByLabelText("Open Working group weekly"));
    fireEvent.click(await screen.findByRole("tab", { name: "Preparation" }));
    expect(await screen.findByRole("button", { name: "Unlink BIO-42" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Unlink BIO-99" })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Edit purposes for BIO-99" }));
    const review = screen.getByRole("checkbox", { name: "Review" });
    expect(review).toBeChecked();
    expect(review).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(review);
    expect(review).toBeChecked();
    expect(api.deleteCockpitMeetingIssue).not.toHaveBeenCalled();
  });

  it("writes a field edit from the panel as a patch of just that field", async () => {
    await openRegister();
    fireEvent.click(await screen.findByLabelText("Open Working group weekly"));

    vi.mocked(api.updateCockpitMeeting).mockResolvedValue(
      meeting({ id: "meet-1", location: "Room 2" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Location" }));
    const input = screen.getByRole("textbox", { name: "Location" });
    fireEvent.change(input, { target: { value: "Room 2" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(api.updateCockpitMeeting).toHaveBeenCalledWith("meet-1", { location: "Room 2" }),
    );
  });

  it("rebinds the folder to one that already exists, and refuses a relative path", async () => {
    await openRegister();
    fireEvent.click(await screen.findByLabelText("Open Working group weekly"));

    fireEvent.click(await screen.findByRole("button", { name: "Edit path" }));
    const input = screen.getByRole("textbox", { name: "Material folder" });

    // A path relative to the reader's own machine is the mistake this field
    // exists to catch: it names it here rather than letting the server answer
    // 400 into a toast after the panel has already closed.
    fireEvent.change(input, { target: { value: "share/06.06/weekly" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent(/absolute path/i);
    expect(api.updateCockpitMeeting).not.toHaveBeenCalled();

    vi.mocked(api.updateCockpitMeeting).mockResolvedValue(
      meeting({ id: "meet-1", nas_dir: "/Volumes/share/legacy/weekly" }),
    );
    fireEvent.change(input, { target: { value: "  /Volumes/share/legacy/weekly  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Stored trimmed: the same string is later compared against the folder
    // provisioning would have made.
    await waitFor(() =>
      expect(api.updateCockpitMeeting).toHaveBeenCalledWith("meet-1", {
        nas_dir: "/Volumes/share/legacy/weekly",
      }),
    );
  });

  it("shows the generated name and the exact folder before anything is created", async () => {
    await openRegister();
    fireEvent.click(await within(await screen.findByRole("region", { name: "Meetings" })).findByRole("button", { name: "New meeting" }));

    const dialog = await screen.findByRole("dialog");
    // The scoped create form edits explicit parties without loading every
    // historical meeting to invent a complete vocabulary.
    fireEvent.click(within(dialog).getByRole("button", { name: "Parties" }));
    const partyBox = screen.getByRole("textbox", { name: "Parties" });
    fireEvent.change(partyBox, { target: { value: "Fosun Pharma" } });
    fireEvent.click(screen.getByRole("button", { name: 'Add “Fosun Pharma”' }));
    fireEvent.change(partyBox, { target: { value: "BGI" } });
    fireEvent.click(screen.getByRole("button", { name: 'Add “BGI”' }));
    // A name nobody has used yet is offered as something to add.
    fireEvent.change(partyBox, { target: { value: "Unicom" } });
    expect(screen.getByRole("button", { name: 'Add “Unicom”' })).toBeInTheDocument();
    fireEvent.change(partyBox, { target: { value: "" } });
    fireEvent.keyDown(partyBox, { key: "Enter" });

    fireEvent.change(within(dialog).getByLabelText("Subject"), {
      target: { value: "Data handover" },
    });

    // The name is shown, not offered: it is the number and the subject, and
    // it is what the folder and the task are named after. The parties are on
    // the row above it and deliberately not in it — one meeting here has ten.
    const code = `${codeDay()}-02`;
    expect(within(dialog).getByTestId("meeting-name-preview").textContent).toBe(
      `${code} Data handover`,
    );
    expect(within(dialog).queryByRole("textbox", { name: "Name" })).toBeNull();
    // The destination is named, not implied: the project, the module, the
    // archive sub-item and the absolute path the folder will be created at —
    // one level below the module, where the programme keeps its material.
    expect(within(dialog).getByText("06 Programme management", { exact: true })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(dialog).getByText(new RegExp(`/Volumes/share/06\\.06/06\\.06\\.03/${code}`)),
      ).toBeInTheDocument(),
    );
    // And where the task lands: under the sub-item, not merely numbered by it.
    expect(within(dialog).queryByText(/› 06\.06\.03\./)).toBeNull();
  });

  it("creates the meeting and directory without creating a minutes task", async () => {
    const created = meeting({ id: "meet-new", code: "20260921-02", title: "New one" });
    vi.mocked(api.createCockpitMeeting).mockImplementation(async (body) => { fixtureBoard.meetings.push(created); return { ...created, creation_key: body.creation_key, replayed: false }; });
    vi.mocked(api.provisionCockpitMeeting).mockResolvedValue({
      meeting: { ...created, nas_dir: "/Volumes/share/06.06/20260921-02 New one" },
      issues: [],
      task: null,
      task_error: "",
      dir: "/Volumes/share/06.06/20260921-02 New one",
      dir_created: true,
      dir_error: "",
    });

    await openRegister();
    fireEvent.click(await within(await screen.findByRole("region", { name: "Meetings" })).findByRole("button", { name: "New meeting" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(api.getCockpitMeetingDestination).toHaveBeenCalled());
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Create meeting" })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole("button", { name: "Create meeting" }));

    await waitFor(() => expect(api.createCockpitMeeting).toHaveBeenCalled());
    expect(api.commandCockpitMeetingWorkflow).not.toHaveBeenCalled();
    // The row is written on its own, then the side effects are asked for —
    // an unmounted share must never cost the record of a meeting.
    expect(vi.mocked(api.createCockpitMeeting).mock.calls[0]![0]).not.toHaveProperty("code");
    await waitFor(() =>
      expect(api.provisionCockpitMeeting).toHaveBeenCalledWith(
        "meet-new",
        expect.objectContaining({ project_id: "project-06", module_id: "module-0606", create_task: false }),
        "ws-1",
      ),
    );
    expect(vi.mocked(api.createCockpitMeeting).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.provisionCockpitMeeting).mock.invocationCallOrder[0]!);
  });

  it("hands an acknowledged background directory plan to its reader without waiting for completion or repeating provisioning", async () => {
    const created = meeting({ id: "meet-background", code: `${codeDay()}-02`, title: "Background preparation" });
    const operationId = "10000000-0000-4000-8000-000000000099";
    vi.mocked(api.createCockpitMeeting).mockImplementation(async (body) => { fixtureBoard.meetings.push(created); return { ...created, creation_key: body.creation_key, replayed: false }; });
    vi.mocked(api.provisionCockpitMeeting).mockResolvedValue({ meeting: created, issues: [], task: null, task_error: "", dir: "/Volumes/share/preparing", dir_created: false,
      dir_error: "Preparation continues in the background", directory_operation_id: operationId, directory_state: "active", dir_error_code: "" });
    function Destination() { const navigation = useCockpitTestNavigation(); return <output data-testid="creation-destination">{navigation.searchParams.toString()}</output>; }
    await openRegister(); render(<Destination />);
    fireEvent.click(await within(await screen.findByRole("region", { name: "Meetings" })).findByRole("button", { name: "New meeting" }));
    const dialog = await screen.findByRole("dialog"); await waitFor(() => expect(within(dialog).getByRole("button", { name: "Create meeting" })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole("button", { name: "Create meeting" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const destination = new URLSearchParams(screen.getByTestId("creation-destination").textContent ?? "");
    expect(destination.get("meeting")).toBe(created.id); expect(destination.get("meeting_view")).toBe("resources"); expect(destination.get("directory_operation")).toBe(operationId);
    expect(api.createCockpitMeeting).toHaveBeenCalledTimes(1); expect(api.provisionCockpitMeeting).toHaveBeenCalledTimes(1);
    expect(useCockpitMeetingCreateDraftStore.getState().draft.byScope).toEqual({});
  });

  it("replays the same meeting creation intent after a committed response is lost", async () => {
    const created = meeting({ id: "meet-replayed", code: `${codeDay()}-02`, title: "Recovered meeting" });
    let first = true;
    vi.mocked(api.createCockpitMeeting).mockImplementation(async (body) => {
      if (first) { first = false; fixtureBoard.meetings.push(created); throw new Error("Creation response lost"); }
      return { ...created, creation_key: body.creation_key, replayed: true };
    });
    vi.mocked(api.provisionCockpitMeeting).mockResolvedValue({ meeting: { ...created, nas_dir: "/Volumes/share/replayed" }, issues: [], task: null, task_error: "", dir: "/Volumes/share/replayed", dir_created: true, dir_error: "" });
    await openRegister(); fireEvent.click(await within(await screen.findByRole("region", { name: "Meetings" })).findByRole("button", { name: "New meeting" }));
    const dialog = await screen.findByRole("dialog"); await waitFor(() => expect(within(dialog).getByRole("button", { name: "Create meeting" })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole("button", { name: "Create meeting" })); expect(await within(dialog).findByRole("alert")).toHaveTextContent("Creation response lost");
    expect(api.commandCockpitMeetingWorkflow).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" })); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const calls = vi.mocked(api.createCockpitMeeting).mock.calls; expect(calls).toHaveLength(2); expect(calls[1]?.[0]).toEqual(calls[0]?.[0]); expect(calls[0]?.[0].creation_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(fixtureBoard.meetings.filter((row) => row.id === created.id)).toHaveLength(1);
    expect(api.commandCockpitMeetingWorkflow).not.toHaveBeenCalled();
  });

  it("retries failed directory preparation on the same saved meeting without creating another task", async () => {
    const created = meeting({ id: "meet-retry", code: `${codeDay()}-02`, title: "Retry setup" });
    vi.mocked(api.createCockpitMeeting).mockImplementation(async (body) => { fixtureBoard.meetings.push(created); return { ...created, creation_key: body.creation_key, replayed: false }; });
    vi.mocked(api.provisionCockpitMeeting).mockRejectedValueOnce(new Error("Directory temporarily unavailable"));
    vi.mocked(api.provisionCockpitMeeting).mockResolvedValue({
      meeting: { ...created, nas_dir: "/Volumes/share/retry" }, issues: [], task: null, task_error: "",
      dir: "/Volumes/share/retry", dir_created: true, dir_error: "",
    });
    await openRegister();
    fireEvent.click(await within(await screen.findByRole("region", { name: "Meetings" })).findByRole("button", { name: "New meeting" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Create meeting" })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole("button", { name: "Create meeting" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Directory temporarily unavailable");
    expect(api.provisionCockpitMeeting).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry remaining setup" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.createCockpitMeeting).toHaveBeenCalledTimes(1);
    expect(api.commandCockpitMeetingWorkflow).not.toHaveBeenCalled();
    expect(vi.mocked(api.provisionCockpitMeeting).mock.calls.map(([meetingId]) => meetingId)).toEqual(["meet-retry", "meet-retry"]);
    expect(api.provisionCockpitMeeting).toHaveBeenCalledWith("meet-retry", expect.objectContaining({ create_task: false }), "ws-1");
  });

  it("holds new contacts until the meeting actually exists", async () => {
    const created = meeting({ id: "meet-new", code: `${codeDay()}-02`, title: "New one" });
    vi.mocked(api.createCockpitMeeting).mockImplementation(async (body) => { fixtureBoard.meetings.push(created); return { ...created, creation_key: body.creation_key, replayed: false }; });
    vi.mocked(api.provisionCockpitMeeting).mockResolvedValue({
      meeting: { ...created, nas_dir: "/Volumes/share/new" }, issues: [], task: null, task_error: "",
      dir: "/Volumes/share/new", dir_created: true, dir_error: "",
    });

    // One fresh unit, one fresh attendee, then abandon the draft.
    await openRegister();
    fireEvent.click(await within(await screen.findByRole("region", { name: "Meetings" })).findByRole("button", { name: "New meeting" }));
    let dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Parties" }));
    let box = screen.getByRole("textbox", { name: "Parties" });
    fireEvent.change(box, { target: { value: "Unicom" } });
    fireEvent.click(screen.getByRole("button", { name: "Add “Unicom”" }));
    fireEvent.keyDown(box, { key: "Enter" });

    fireEvent.click(within(dialog).getByRole("button", { name: "Attendees" }));
    const attendeeBox = screen.getByRole("textbox", { name: "Attendees" });
    fireEvent.change(attendeeBox, { target: { value: "New Person" } });
    fireEvent.click(screen.getByRole("button", { name: "Add “New Person”" }));
    // Escape inside the editor closes just it, keeping the token and popover.
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Position" }), { key: "Escape" });
    fireEvent.keyDown(attendeeBox, { key: "Enter" });

    // The field committed — the draft knows the name — but the book must not
    // learn from a meeting that may never be saved.
    expect(api.upsertCockpitDirectoryCompact).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.upsertCockpitDirectoryCompact).not.toHaveBeenCalled();

    // The same draft, saved this time: the book learns on create.
    fireEvent.click(await within(await screen.findByRole("region", { name: "Meetings" })).findByRole("button", { name: "New meeting" }));
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Parties" }));
    box = screen.getByRole("textbox", { name: "Parties" });
    fireEvent.change(box, { target: { value: "Unicom" } });
    fireEvent.click(screen.getByRole("button", { name: "Add “Unicom”" }));
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Attendees" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Attendees" }), {
      target: { value: "New Person" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add “New Person”" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Position" }), { key: "Escape" });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Attendees" }), { key: "Enter" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Create meeting" })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole("button", { name: "Create meeting" }));

    await waitFor(() => expect(api.createCockpitMeeting).toHaveBeenCalled());
    await waitFor(() =>
      expect(api.upsertCockpitDirectoryCompact).toHaveBeenCalledWith("ws-1", { only_unknown_names: true, entries: [
        { party: "Unicom", name: "New Person", position: "" },
      ] }),
    );
  });

  it("keeps the register reachable from the cockpit shell beside the retained business overview", async () => {
    resetCockpitTestNavigation("/ws/cockpit?tab=plan&plan_view=operations");
    renderPage();
    fireEvent.click(await screen.findByRole("link", { name: "Meetings" }));
    expect(await screen.findByRole("button", { name: "List", pressed: true })).toBeInTheDocument();
  });
});

describe("reading meetings back off the share", () => {
  it("offers only the folders no meeting records, with what it guessed editable", async () => {
    await openRegister();
    fireEvent.click(await screen.findByRole("button", { name: "Read from the share" }));

    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("20260920 Unicom trusted connector");
    // The folder that already has a meeting is not offered again.
    expect(within(dialog).queryByText("20260921-01 Working group weekly")).not.toBeInTheDocument();
    expect(within(dialog).getByText("/Volumes/share/06.06/06.06.03")).toBeInTheDocument();

    // Every guess is an input, because a guess has to be correctable before
    // it becomes a row.
    const subject = within(dialog).getByLabelText(
      "Subject of 20260920 Unicom trusted connector",
    ) as HTMLInputElement;
    expect(subject.value).toBe("Unicom trusted connector");
    expect(
      (within(dialog).getByLabelText("Date of 20260920 Unicom trusted connector") as HTMLInputElement)
        .value,
    ).toBe("2026-09-20");

    fireEvent.change(subject, { target: { value: "Trusted connector review" } });
    vi.mocked(api.importCockpitMeetingFolders).mockResolvedValue({
      meetings: [meeting({ id: "meet-2", title: "Trusted connector review", detected: true, nas_dir: "/Volumes/share/06.06/06.06.03/20260920 Unicom trusted connector" })],
      issues: [],
      skipped: [],
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Import 1" }));

    await waitFor(() =>
      expect(api.importCockpitMeetingFolders).toHaveBeenCalledWith({
        items: [
          {
            name: "20260920 Unicom trusted connector",
            code: "",
            meet_date: "2026-09-20",
            title: "Trusted connector review",
            parties: "",
          },
        ],
        project_id: "project-06",
        module_id: "module-0606",
        node_id: "node-060603",
        // These meetings have already been held; opening a task for each is
        // opt-in, not the default.
        create_task: false,
        expected_base_dir: "/Volumes/share/06.06/06.06.03",
      }, "ws-1"),
    );
  });

  it("says a row was read off the share until someone has checked it", async () => {
    fixtureBoard = {
      ...structuredClone(board),
      meetings: [meeting({ id: "meet-1", title: "Guessed meeting", meet_date: todayString(), detected: true })],
    };
    await openRegister();

    fireEvent.click(await screen.findByLabelText("Open Guessed meeting"));
    const panel = await screen.findByText(/guessed from the folder name/i);
    expect(panel).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Checked" }));
    await waitFor(() =>
      expect(api.updateCockpitMeeting).toHaveBeenCalledWith("meet-1", { detected: false }),
    );
  });
});

describe("the people at a meeting", () => {
  it("offers workspace members and accepts anyone else", async () => {
    await openRegister();
    fireEvent.click(await screen.findByLabelText("Open Working group weekly"));

    fireEvent.click(await screen.findByRole("button", { name: "Attendees: Find workspace member" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search workspace members" }), { target: { value: "Wang Gong" } });
    fireEvent.click(await screen.findByRole("button", { name: "Wang Gong" }));
    await waitFor(() => expect(api.updateCockpitMeeting).toHaveBeenCalledWith("meet-1", { attendees: "Wang Gong" }));
    fireEvent.click(await screen.findByRole("button", { name: "Attendees" }));
    const box = screen.getByRole("textbox", { name: "Attendees" });

    // Half the room at a joint meeting has no account here.
    fireEvent.change(box, { target: { value: "Zhang from BGI" } });
    fireEvent.click(screen.getByRole("button", { name: 'Add “Zhang from BGI”' }));
    // The list is shorter now and a different row sits under the cursor.
    // Enter must still mean "done" rather than "tick whatever moved there".
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Remove Wang Gong" }));
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() =>
      expect(api.updateCockpitMeeting).toHaveBeenCalledWith("meet-1", {
        attendees: "Wang Gong、Zhang from BGI",
      }),
    );
  });

  it("groups the contact book by unit and files fresh names on its own", async () => {
    directoryEntries = [
        { party: "Fosun Pharma", name: "Liu Huanhuan", position: "Project manager", source: "user" },
        { party: "BGI", name: "Xiao Wang", position: "", source: "user" },
      ];
    await openRegister();
    fireEvent.click(await screen.findByLabelText("Open Working group weekly"));

    // The auto-save notice rides under the attendee field.
    expect(
      await screen.findByText("New people and positions you type are saved to the contact book automatically and offered next time."),
    ).toBeInTheDocument();

    // Narrow the meeting to its one unit so a fresh name can be attributed.
    fireEvent.click(screen.getByRole("button", { name: "Parties" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove BGI" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Parties" }), { key: "Enter" });
    await waitFor(() =>
      expect(api.updateCockpitMeeting).toHaveBeenCalledWith("meet-1", {
        parties: "Fosun Pharma",
      }),
    );
    // The confirmed scoped detail must reach the picker before it opens.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Parties" }).textContent).toBe("Fosun Pharma"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Attendees" }));
    let listbox = await screen.findByRole("listbox", { name: "Attendees" });
    // Scoped to the meeting's one unit: BGI's group is behind the toggle now
    // that BGI left the meeting.
    expect(within(listbox).queryByText(/Xiao Wang/)).toBeNull();
    expect(await within(listbox).findByText("Project manager")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show everyone" }));
    listbox = await screen.findByRole("listbox", { name: "Attendees" });
    await within(listbox).findByText("BGI");
    const text = listbox.textContent ?? "";
    expect(text.indexOf("Fosun Pharma")).toBeLessThan(text.indexOf("BGI"));

    fireEvent.click(within(listbox).getByRole("option", { name: /Liu Huanhuan/ }));
    const box = screen.getByRole("textbox", { name: "Attendees" });
    fireEvent.change(box, { target: { value: "New Person" } });
    fireEvent.click(screen.getByRole("button", { name: "Add “New Person”" }));
    // Skipping the inline editor still files the bare name on commit.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() =>
      expect(api.updateCockpitMeeting).toHaveBeenCalledWith("meet-1", {
        attendees: "Liu Huanhuan、New Person",
      }),
    );
    // A page is not the full book. The server receives candidate names and
    // alone decides which are new; known positions are never cleared.
    await waitFor(() =>
      expect(api.upsertCockpitDirectoryCompact).toHaveBeenCalledWith("ws-1", { only_unknown_names: true, entries: [
        { party: "Fosun Pharma", name: "Liu Huanhuan", position: "" },
        { party: "Fosun Pharma", name: "New Person", position: "" },
      ] }),
    );
  });

  it("deletes a hand-filed contact behind a confirm, and never the roster", async () => {
    directoryEntries = [
        { party: "Fosun Pharma", name: "Liu Huanhuan", position: "", source: "user" },
        { party: "Fosun Pharma", name: "Preset Person", position: "Lead", source: "seed" },
      ];
    await openRegister();
    fireEvent.click(await screen.findByLabelText("Open Working group weekly"));
    fireEvent.click(await screen.findByRole("button", { name: "Attendees" }));

    // Scoped to the meeting's units, both contacts show; only the hand-filed
    // one carries a trash affordance.
    expect(await screen.findByRole("option", { name: /Preset Person/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete Preset Person" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Delete Liu Huanhuan" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(api.deleteCockpitDirectoryCompact).toHaveBeenCalledWith("ws-1", {
        party: "Fosun Pharma",
        name: "Liu Huanhuan",
      }),
    );
    // The row is gone from the refreshed book the server handed back.
    await waitFor(() =>
      expect(screen.queryByRole("option", { name: /Liu Huanhuan/ })).toBeNull(),
    );
  });

  it("starts the meeting type from the programme's own words", async () => {
    await openRegister();
    fireEvent.click(await screen.findByLabelText("Open Working group weekly"));

    fireEvent.click(await screen.findByRole("button", { name: "Type" }));
    // An empty board still opens on a vocabulary rather than on a blank box.
    expect(screen.getByRole("option", { name: "例会" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "对接会" }));

    await waitFor(() =>
      expect(api.updateCockpitMeeting).toHaveBeenCalledWith("meet-1", { kind: "对接会" }),
    );
  });
});

describe("finding meetings", () => {
  it("narrows the register as you type, across what a meeting says", async () => {
    await openRegister();
    await screen.findByText(`${codeDay()}-01`);

    const box = screen.getByRole("textbox", { name: "Search meetings" });
    fireEvent.change(box, { target: { value: "kickoff" } });
    await waitFor(() => expect(screen.queryByLabelText("Open Working group weekly")).toBeNull());
    expect(await screen.findByLabelText("Open Kickoff")).toBeInTheDocument();
    // The toolbar count and the chip row say the same thing.
    expect(api.getCockpitMeetingRegister).toHaveBeenLastCalledWith("ws-1", expect.anything(), expect.objectContaining({ q: "kickoff", page_size: 25 }), expect.any(AbortSignal));
    expect(screen.getAllByText("1 of 1 meetings").length).toBeGreaterThan(0);

    // The search reads decisions too, not just the title.
    fireEvent.change(box, { target: { value: "v3 data" } });
    expect(await screen.findByLabelText("Open Working group weekly")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByLabelText("Open Kickoff")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(await screen.findByLabelText("Open Kickoff")).toBeInTheDocument();
  });

  it("filters from the popover and states every active group as a removable chip", async () => {
    await openRegister();
    await screen.findByText(`${codeDay()}-01`);

    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    // Status vocabulary = the programme's seeded words plus what the board
    // has used ("Held").
    fireEvent.click(await screen.findByRole("button", { name: "Held" }));

    expect(screen.queryByLabelText("Open Working group weekly")).toBeNull();
    expect(await screen.findByText("Status: Held")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Remove filter Status: Held" }));
    expect(await screen.findByLabelText("Open Working group weekly")).toBeInTheDocument();

    // The track filter, and "no track" as a thing to ask for.
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.click(await screen.findByRole("button", { name: "项目管理" }));
    expect(await screen.findByText("Track: 项目管理")).toBeInTheDocument();
    expect(screen.queryByLabelText("Open Kickoff")).toBeNull();

    // Clear everything from the chip row. The popover offers the same action
    // under the same name; dismiss it first so the row's is the one left.
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Clear all filters" }));
    expect(await screen.findByLabelText("Open Kickoff")).toBeInTheDocument();
  });

  it("reads the only-switches off the meeting, not off its title", async () => {
    await openRegister();
    await screen.findByText(`${codeDay()}-01`);
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.click(await screen.findByRole("button", { name: "Has decisions" }));

    // meet-1 recorded a decision; the other two did not.
    expect(await screen.findByLabelText("Open Working group weekly")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByLabelText("Open Kickoff")).toBeNull());
    expect(screen.queryByLabelText("Open Compliance review TBD")).toBeNull();
  });
});

describe("the timeline", () => {
  it("lanes the register by line, cards reading date, parties and consensus", async () => {
    await openRegister();
    await screen.findByText(`${codeDay()}-01`);
    fireEvent.click(screen.getByRole("button", { name: "Timeline", pressed: false }));

    // One lane per line in use, the unfiled meetings in their own lane.
    expect(await screen.findByText("项目管理")).toBeInTheDocument();
    expect(screen.getByText("No track")).toBeInTheDocument();

    // The card says what a review asks: when, who sat down, what was agreed.
    const card = await screen.findByLabelText("Open Working group weekly");
    expect(within(card).getByText("Fosun Pharma、BGI")).toBeInTheDocument();
    expect(within(card).getByText("Adopt the v3 data schema")).toBeInTheDocument();

    // The undated draft is held back, and the view says how many.
    expect(screen.queryByLabelText("Open Compliance review TBD")).toBeNull();
    expect(screen.getByText(/1 unscheduled/)).toBeInTheDocument();

    // A card opens the same panel the list would.
    fireEvent.click(card);
    expect(await screen.findByText("BIO-42")).toBeInTheDocument();
  });

  it("honours the shared filters: a searched timeline hides the rest", async () => {
    await openRegister();
    await screen.findByText(`${codeDay()}-01`);
    fireEvent.change(screen.getByRole("textbox", { name: "Search meetings" }), {
      target: { value: "kickoff" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Timeline", pressed: false }));

    expect(await screen.findByLabelText("Open Kickoff")).toBeInTheDocument();
    expect(screen.queryByLabelText("Open Working group weekly")).toBeNull();
    // meet-2 has no track, so only the unfiled lane remains.
    expect(screen.queryByText("项目管理")).toBeNull();
    expect(screen.getByText("No track")).toBeInTheDocument();
  });

  it("folds a busy day into one card that opens the day's meetings", async () => {
    const day = todayString(-2);
    fixtureBoard = {
      ...structuredClone(board),
      meetings: [
        meeting({ id: "meet-a", meet_date: day, start_time: "09:00", title: "Alpha review", track: "项目管理", parties: "Fosun Pharma" }),
        meeting({ id: "meet-b", meet_date: day, start_time: "14:00", title: "Beta acceptance", track: "项目管理", code: `${day.replaceAll("-", "")}-02` }),
      ],
    };
    await openRegister();
    fireEvent.click(screen.getByRole("button", { name: "Timeline", pressed: false }));

    // One card for the day, not one per meeting — that is what keeps a busy
    // acceptance day one tier tall.
    const card = await screen.findByRole("button", { name: `2 meetings on ${day}` });
    expect(within(card).getByText("Alpha review")).toBeInTheDocument();
    expect(within(card).getByText("Beta acceptance")).toBeInTheDocument();
    expect(screen.queryByLabelText("Open Alpha review")).toBeNull();

    // The card opens the day's roster; a row opens the meeting itself.
    fireEvent.click(card);
    const row = await screen.findByRole("button", { name: /Beta acceptance/ });
    fireEvent.click(row);
    expect(await screen.findByText(`${day.replaceAll("-", "")}-02`)).toBeInTheDocument();
  });

  it("zooms the free-scroll scale from the toolbar and resets", async () => {
    await openRegister();
    await screen.findByText(`${codeDay()}-01`);
    fireEvent.click(screen.getByRole("button", { name: "Timeline", pressed: false }));
    await screen.findByLabelText("Open Working group weekly");

    // Fit mode zooms with the window, so the zoom group only exists in free
    // scroll; switching seeds the density from fit's own (jsdom lays nothing
    // out, so assert the delta, not an absolute percent).
    expect(screen.queryByRole("group", { name: "Zoom" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Free scroll" }));
    const reset = await screen.findByRole("button", { name: "Reset zoom" });
    const pct = () => Number.parseInt(reset.textContent ?? "0", 10);
    const seeded = pct();

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    const zoomed = pct();
    expect(zoomed).toBeGreaterThan(seeded);
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(pct()).toBeLessThan(zoomed);
    fireEvent.click(reset);
    expect(pct()).toBe(100);
  });
});
