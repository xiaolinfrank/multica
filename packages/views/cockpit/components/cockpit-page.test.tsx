import { installCockpitTestLayout } from "./test/cockpit-layout-test-fixture";
import { beforeEach as beforeLayout, afterEach as afterLayout } from "vitest";
let restoreLayout = () => {};
beforeLayout(() => { restoreLayout = installCockpitTestLayout(); });
afterLayout(() => restoreLayout());
import { useCockpitScopeViewStore, cockpitContextOptions, EMPTY_COCKPIT_SCOPE } from "@multica/core/cockpit";
import { readCockpitFixture, readCockpitMembersFixture } from "./test/cockpit-read-mocks-fixture";
import { resetCockpitTestNavigation } from "./cockpit-navigation-test-fixture";
import { workflowSummary } from "./workflow-test-fixtures";
import { EMPTY_COCKPIT_MEETING_WORKFLOW } from "@multica/core/api/schemas";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import enCockpit from "../../locales/en/cockpit.json";
import type { SearchIssueResult, CockpitBoard, CockpitSnapshot, CockpitPendingChange } from "@multica/core/types";

// The derivation matrix (tree building, roll-ups, finance, the monthly strip,
// the digest, the timeline axis) is pinned in
// packages/core/cockpit/model.test.ts (node suite). This file keeps the wiring:
// the page reads the board, both views render it, an inline edit reaches the
// API with the right patch, and issue linking searches and links.

vi.mock("../../common/actor-avatar", () => ({ ActorAvatar: () => <span /> }));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({
    cockpit: () => "/ws/cockpit", projects: () => "/ws/projects", projectDetail: (id: string) => `/ws/projects/${id}`, settings: () => "/ws/settings", issueDetail: (id: string) => `/ws/issues/${id}`, memberDetail: (id: string) => `/ws/members/${id}`, agentDetail: (id: string) => `/ws/agents/${id}`, squadDetail: (id: string) => `/ws/squads/${id}`,
  }),
}));

// Mutable so a test can arm a `?meeting=` deep link before rendering.
const navSearch = vi.hoisted(() => ({ params: new URLSearchParams(), push: vi.fn() }));

vi.mock("../../navigation", async () => {
  const fixture = await import("./cockpit-navigation-test-fixture");
  return { useNavigation: () => { const navigation = fixture.useCockpitTestNavigation();
    return { ...navigation, push: (href: string) => { navSearch.push(href); navigation.push(href); } }; }, AppLink: fixture.CockpitTestLink };
});

vi.mock("@multica/core/api", async () => ({
  api: {
    ...(await import("./test/cockpit-read-mocks-fixture")).makeCockpitReadApiMocks(),
    getBaseUrl: () => "https://example.test",
    getCockpit: vi.fn(),
    getCockpitMeetingWorkflowSummary: vi.fn(),
    commandCockpitMeetingWorkflow: vi.fn(),
    updateCockpit: vi.fn(),
    createCockpitNode: vi.fn(),
    getCockpitNextNodeCode: vi.fn(),
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
    listCockpitDirectory: vi.fn(),
    upsertCockpitDirectory: vi.fn(),
    deleteCockpitDirectoryEntry: vi.fn(),
    updateCockpitMeeting: vi.fn(),
    deleteCockpitMeeting: vi.fn(),
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
    listModules: vi.fn(),
    listProjects: vi.fn(),
  },
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  }),
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

function node(over: Partial<CockpitBoard["nodes"][number]> & { id: string; code: string }) {
  return {
    cockpit_id: "cp",
    parent_id: null,
    name: over.code,
    position: 0,
    color: "",
    owner: "",
    collaborators: "",
    start_date: null,
    end_date: null,
    status: "",
    progress: 0,
    deliverable: "",
    dependencies: "",
    note: "",
    current_progress: "",
    vendor: "",
    budget_category: "",
    budget_amount: null,
    exec_status: "",
    contract: "",
    source: "",
    updated_by_type: "",
    updated_by_id: null,
    created_at: "",
    updated_at: "",
    ...over,
  };
}

// The overview only lists meetings that are current or upcoming, so the
// fixture meeting rides two days ahead of the real clock.
function upcomingDate(days = 2): string {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
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
    basis: "Source: the programme master sheet",
    meeting_assignee_type: "",
    meeting_assignee_id: null,
    meeting_project_id: null,
    meeting_module_id: null, meeting_node_id: null,
    meeting_dir: "",
    created_at: "",
    updated_at: "",
  },
  nodes: [
    node({ id: "root", code: "L1-01", name: "High-quality datasets", owner: "Li", color: "#2563eb" }),
    node({
      id: "task",
      code: "L3-01-08",
      name: "Sign the governance agreement",
      parent_id: "root",
      owner: "Li",
      status: "In progress",
      progress: 40,
      start_date: "2026-09-05",
      end_date: "2026-09-20",
      budget_amount: 30,
      exec_status: "Contracted",
      deliverable: "Signed governance agreement",
    }),
  ],
  payments: [
    { id: "pay-1", node_id: "task", label: "#1", pay_date: "2026-09-05", amount: 15, position: 0 },
  ],
  issue_links: [
    {
      id: "link-1",
      node_id: "task",
      issue_id: "issue-1",
      issue_number: 314,
      issue_identifier: "BIO-314",
      issue_title: "Programme master sheet",
      issue_status: "in_progress",
      position: 0,
    },
  ],
  milestones: [
    {
      id: "ms-1",
      name: "Dataset acceptance",
      plan_date: "2026-11-30",
      actual_date: null,
      status: "On track",
      node_id: "root",
      condition: "Three cohorts governed",
      guard: "",
      position: 0,
    },
  ],
  meetings: [
    {
      id: "meet-1",
      meet_date: upcomingDate(),
      time_range: "10:00-11:00",
      title: "Working group weekly",
      attendees: "Everyone",
      meet_no: "509",
      link: "",
      note: "",
      start_time: null,
      end_time: null,
      code: "",
      kind: "",
      status: "",
      parties: "",
      organizer: "",
      location: "",
      minutes: "",
      decisions: "",
      actions: "",
      nas_dir: "",
      detected: false,
      track: "",
    },
  ],
  meeting_issues: [],
  meeting_nodes: [],
};

// Keep the selected fixture index; legacy reference controls belong to grouping rows.
function useDetailedBoard(legacyGroup = false) {
  const detailed = structuredClone(board);
  detailed.nodes[1]!.parent_id = "module";
  detailed.nodes.push(node({ id: "module", code: "L2-01-01", parent_id: "root", name: "Governance" }));
  if (legacyGroup) detailed.nodes.push(node({ id: "agreement-detail", code: "detail", parent_id: "task", name: "Agreement detail" }));
  readCockpitFixture.mockResolvedValue(detailed);
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { client: qc, ...render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}>
        <CockpitPage />
      </I18nProvider>
    </QueryClientProvider>,
  ) };
}

describe("CockpitPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCockpitScopeViewStore.getState().reset();
    navSearch.params = new URLSearchParams();
    resetCockpitTestNavigation(`/ws/cockpit?${navSearch.params.size ? navSearch.params : "view=operations"}`);
    readCockpitFixture.mockResolvedValue(structuredClone(board));
    vi.mocked(api.getCockpitMeetingWorkflowSummary).mockImplementation(async (_wsId, meetingId) => workflowSummary({ ...EMPTY_COCKPIT_MEETING_WORKFLOW, meeting_id: meetingId }));
    vi.mocked(api.getCockpitNextNodeCode).mockResolvedValue({ code: "01.02.01" });
    vi.mocked(api.listCockpitDirectory).mockResolvedValue({ entries: [] });
    vi.mocked(api.searchIssues).mockResolvedValue({ issues: [] });
    vi.mocked(api.listCockpitSnapshots).mockResolvedValue([]);
    vi.mocked(api.listCockpitChanges).mockResolvedValue([]);
    vi.mocked(api.listModules).mockResolvedValue({ modules: [], total: 0 });
    vi.mocked(api.listProjects).mockResolvedValue({ projects: [], total: 0 });
    readCockpitMembersFixture.mockResolvedValue([
      {
        id: "m1",
        workspace_id: "ws-1",
        user_id: "user-1",
        role: "owner" as const,
        created_at: "",
        name: "Owner",
        email: "owner@example.com",
        avatar_url: null,
      },
    ]);
  });

  it("offers a retry when the board request fails instead of keeping the loading skeleton forever", async () => {
    readCockpitFixture.mockRejectedValueOnce(new Error("Offline"));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent(enCockpit.shell.invalid_scope);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(await screen.findByRole("link", { name: "Gantt" })).toBeInTheDocument();
  });

  it("opens the meeting panel from the ?meeting= deep link", async () => {
    // The graph's meeting nodes and the issue sidebar's linked-meetings rows
    // land here: meetings tab + this meeting's panel, once per URL value.
    navSearch.params = new URLSearchParams("meeting=meet-1");
    resetCockpitTestNavigation(`/ws/cockpit?${navSearch.params}`);
    const { findAllByText, findByRole } = renderPage();
    // The title shows in the register row AND the opened panel.
    await waitFor(async () => expect((await findAllByText("Working group weekly")).length).toBeGreaterThan(1));
    expect(await findByRole("button", { name: "Close panel" })).toBeInTheDocument();
  });

  it("keeps a meeting destination in the URL when leaving the routed business view", async () => {
    navSearch.params = new URLSearchParams("view=operations"); resetCockpitTestNavigation(`/ws/cockpit?${navSearch.params}`); renderPage();
    const register = await screen.findByRole("link", { name: enCockpit.meetings.open_register }); expect(register).toHaveAttribute("href", "/ws/cockpit?tab=meetings");
    fireEvent.click(register); expect(await screen.findByRole("button", { name: "List", pressed: true })).toBeInTheDocument();
    fireEvent.click(await screen.findByLabelText("Open Working group weekly"));
    expect(await screen.findByRole("button", { name: "Close panel" })).toBeInTheDocument();
    expect(api.getCockpitMeetingDetail).toHaveBeenCalledWith("ws-1", "meet-1", { projectId: null, moduleId: null }, expect.any(AbortSignal));
  });

  it("keeps one register create action and version history inside the meeting surface", async () => {
    navSearch.params = new URLSearchParams("tab=meetings");
    resetCockpitTestNavigation(`/ws/cockpit?${navSearch.params}`);
    renderPage();
    await screen.findByLabelText("Open Working group weekly");
    const register = screen.getByRole("region", { name: enCockpit.shell.meetings });
    const create = within(register).getByRole("button", { name: enCockpit.meeting.new });
    expect(screen.getAllByRole("button", { name: enCockpit.meeting.new })).toHaveLength(1);
    expect(within(register).getByRole("button", { name: enCockpit.versions.button })).toBeInTheDocument();
    fireEvent.click(create);
    expect(await screen.findByRole("dialog", { name: enCockpit.meetings.create_title })).toBeInTheDocument();
    expect(api.createCockpitMeeting).not.toHaveBeenCalled();
  });

  it("lands on the folded gantt row from the ?node= deep link", async () => {
    // The graph's execution nodes land here: gantt tab with the row actually
    // revealed — first paint folds every branch with children, so selecting
    // without unfolding never shows the row (the pre-fix behavior).
    navSearch.params = new URLSearchParams("node=task");
    resetCockpitTestNavigation(`/ws/cockpit?${navSearch.params}`);
    renderPage();
    await waitFor(() =>
      expect(document.querySelector('[data-cockpit-node="task"]')).not.toBeNull(),
    );
    expect(await screen.findByRole("button", { name: "Close panel" })).toBeInTheDocument();
  });

  it("renders the overview: goal, milestones, modules and finance", async () => {
    renderPage();

    expect(await screen.findByRole("button", { name: "Annual objective" })).toHaveTextContent(
      "End-to-end demo",
    );
    expect(screen.getByText("Dataset acceptance")).toBeInTheDocument();
    // The module name is printed twice on purpose: once on the module card and
    // once in the spend-by-module table.
    expect(screen.getAllByText("High-quality datasets").length).toBeGreaterThan(0);
    expect(await screen.findByText("Working group weekly")).toBeInTheDocument();

    // Budget rolls up from the leaf, quoted in the board's 万元 unit.
    const finance = screen.getByText("2026 budget total (per master sheet)").closest("div")!;
    expect(within(finance).getByText("30万")).toBeInTheDocument();
  });

  // Regression: the module card's progress used to be the done ratio (0% here
  // with the one task at 40%), disagreeing with the gantt row for the same
  // branch. Both views now quote the same subtree average.
  it("quotes the gantt's subtree average on the module cards", async () => {
    renderPage();
    await screen.findAllByText("High-quality datasets");
    const tile = screen.getByText("Progress").closest("div")!;
    expect(within(tile).getByText("40%")).toBeInTheDocument();
    // The completion count stays a count.
    const doneTile = screen.getByText("Done/total").closest("div")!;
    expect(within(doneTile).getByText("0/1")).toBeInTheDocument();
  });

  it("quotes the same average on the small module cards", async () => {
    readCockpitFixture.mockResolvedValue(
      structuredClone({
        ...board,
        nodes: [
          ...board.nodes,
          node({ id: "root-b", code: "L1-02", name: "Platform", color: "#0891b2" }),
          node({ id: "root-c", code: "L1-03", name: "Agents", color: "#7c3aed" }),
          node({
            id: "task-c",
            code: "L3-03-01",
            name: "Pilot",
            parent_id: "root-c",
            status: "In progress",
            progress: 40,
          }),
        ],
      }),
    );
    renderPage();
    // The third module falls past MODULE_BIG_COUNT into the small grid; its
    // summary line carries the same subtree average, not the done ratio (0%).
    expect(await screen.findByText(/0\/1 items · 40%/)).toBeInTheDocument();
  });

  // The v1.2 summary merge folds 02.02-09 into one "02.02" row and displays
  // stored 02.10 as "02.03"; every surface outside the gantt must quote those
  // shipped numbers rather than the stored history.
  function mergedAreaNodes() {
    return [
      node({ id: "l2", code: "L1-02", name: "Platform", color: "#0891b2" }),
      node({ id: "dir1", code: "02.01", parent_id: "l2", name: "Infra" }),
      node({ id: "dir2", code: "02.02", parent_id: "l2", name: "Arch" }),
      node({ id: "dir3", code: "02.03", parent_id: "l2", name: "Data" }),
      node({ id: "dir10", code: "02.10", parent_id: "l2", name: "院端节点与部署" }),
      node({ id: "t2", code: "L3-02-02", parent_id: "dir2", name: "Design" }),
      node({
        id: "t3", code: "L3-02-08", parent_id: "dir3", name: "Ship",
        status: "In progress", progress: 60,
        start_date: "2026-09-01", end_date: "2026-10-10",
      }),
      node({ id: "t16", code: "L3-02-16", parent_id: "dir10", name: "Box" }),
    ];
  }

  it("numbers digest tasks with the shipped row codes, not the pre-merge outline", async () => {
    readCockpitFixture.mockResolvedValue(
      structuredClone({
        ...board,
        nodes: [
          ...board.nodes,
          // No dir10 here: with the merged area alone, "02.03.01" would only
          // ever come from the base tree's pre-merge numbering of t3.
          ...mergedAreaNodes().filter((n) => n.id !== "dir10" && n.id !== "t16"),
        ],
      }),
    );
    renderPage();
    // Stored-02.03's active task ships as 02.02.02 in the digest card.
    expect((await screen.findAllByText("02.02.02")).length).toBeGreaterThan(0);
    expect(screen.queryByText("02.03.01")).not.toBeInTheDocument();
  });

  it("shows the shipped row code beside the stored code in the node panel", async () => {
    readCockpitFixture.mockResolvedValue(
      structuredClone({ ...board, nodes: [...board.nodes, ...mergedAreaNodes()] }),
    );
    renderPage();
    fireEvent.click(await screen.findByRole("link", { name: "Gantt" }));
    // The renamed direction ships as "02.03 院端一体机与部署" (stored 02.10).
    fireEvent.click(await screen.findByRole("button", { name: "Open 02.03" }));
    await screen.findByRole("button", { name: enCockpit.node.stored_code });
    const panel = screen.getByRole("complementary");
    expect(within(panel).getByText("02.03")).toBeInTheDocument();
    expect(within(panel).getByText("02.10")).toBeInTheDocument();
  });

  it("numbers change rows with the shipped row codes", async () => {
    readCockpitFixture.mockResolvedValue(
      structuredClone({ ...board, nodes: [...board.nodes, ...mergedAreaNodes()] }),
    );
    vi.mocked(api.listCockpitChangePage).mockResolvedValue({ workspace_id: "ws-1", scope: { project_id: null, module_id: null, project_title: "", module_title: "" }, q: "", status: "pending", total: 1, next_cursor: null, counts: { pending: 1, decided: 0 }, items: [
      {
        id: "ch1", cockpit_id: "cp", node_id: "t3",
        node_code: "02.03", node_name: "Ship",
        field: "progress", old_value: "50", new_value: "60",
        source: "manual", reason: "", status: "pending",
        created_by_type: "member", created_by_label: "Li",
        decided_by_type: "", decided_by_label: "", decided_at: null,
        created_at: "", updated_at: "", source_task_id: "", source_issue: null, decision_note: "",
      }
    ] });
    renderPage();
    fireEvent.click(await screen.findByRole("link", { name: "Governance" }));
    expect(
      await screen.findByRole("button", { name: "Locate 02.02.02 in the gantt" }),
    ).toBeInTheDocument();
  });

  it("stretches the stacked spend column to the fixed-height track", async () => {
    const { container } = renderPage();
    await screen.findByText("Monthly task progress × spend budget");

    // The segments carry percentage heights, which only resolve if the column
    // itself fills the fixed-height track. Regression: with no height class
    // the items-end track let the column collapse to 0px, so the chart
    // rendered as blank space under every month card.
    const column = container.querySelector(".flex-col-reverse");
    expect(column).not.toBeNull();
    expect(column).toHaveClass("h-full");
    expect(column!.firstElementChild).toHaveStyle({ height: "100%" });
  });

  it("records the completion date when an open milestone is marked done", async () => {
    renderPage();
    const markDone = await screen.findByRole("button", { name: "Mark done" });
    fireEvent.click(markDone);
    await waitFor(() =>
      expect(api.updateCockpitMilestone).toHaveBeenCalledWith(
        "ms-1",
        expect.objectContaining({ actual_date: expect.any(String) }),
      ),
    );
  });

  it("switches to the gantt and lists the tree with its rolled-up branch progress", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("link", { name: "Gantt" }));

    expect(await screen.findByRole("button", { name: "Open 01.01" })).toBeInTheDocument();
    // The branch has one leaf at 40%, so it reports 40% and is not editable.
    const progressFields = screen.getAllByRole("button", { name: "Progress" });
    expect(progressFields.length).toBeGreaterThan(0);
  });

  it("sends only the edited field when an inline value is committed", async () => {
    vi.mocked(api.updateCockpitNode).mockResolvedValue({
      ...board.nodes[1]!,
      owner: "Wang",
    });
    renderPage();
    fireEvent.click(await screen.findByRole("link", { name: "Gantt" }));

    // Two rows carry an owner; the leaf is the second.
    const ownerButtons = await screen.findAllByRole("button", { name: "Owner" });
    fireEvent.click(ownerButtons[1]!);
    const input = screen.getByRole("textbox", { name: "Owner" });
    fireEvent.change(input, { target: { value: "Wang" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(api.updateCockpitNode).toHaveBeenCalledWith("task", { owner: "Wang" });
    });
  });

  it("reverts an inline edit on Escape without calling the API", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("link", { name: "Gantt" }));

    const ownerButtons = await screen.findAllByRole("button", { name: "Owner" });
    fireEvent.click(ownerButtons[1]!);
    const input = screen.getByRole("textbox", { name: "Owner" });
    fireEvent.change(input, { target: { value: "Wang" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(api.updateCockpitNode).not.toHaveBeenCalled();
  });

  it("picks an owner from the board's existing owners in the gantt dropdown", async () => {
    const twoOwners = structuredClone(board);
    twoOwners.nodes[1]!.owner = "Wang";
    readCockpitFixture.mockResolvedValue(twoOwners);
    vi.mocked(api.updateCockpitNode).mockResolvedValue({ ...twoOwners.nodes[1]!, owner: "Li" });
    renderPage();
    fireEvent.click(await screen.findByRole("link", { name: "Gantt" }));

    const ownerButtons = await screen.findAllByRole("button", { name: "Owner" });
    fireEvent.click(ownerButtons[1]!);
    // The dropdown lists the owners the board already uses; one click sets one.
    fireEvent.click(await screen.findByRole("option", { name: "Li" }));

    await waitFor(() => expect(api.updateCockpitNode).toHaveBeenCalledWith("task", { owner: "Li" }));
  });

  it("opens a grouping panel and preserves its detailed fields and legacy reference chips", async () => {
    useDetailedBoard(true);
    renderPage();
    fireEvent.click(await screen.findByRole("link", { name: "Gantt" }));
    fireEvent.click(await screen.findByRole("button", { name: "Expand Governance" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open 01.01.01" }));

    expect(await screen.findByText("Instalments")).toBeInTheDocument();
    expect(screen.getByText("Deliverable")).toBeInTheDocument();
    expect(screen.getByText("Payment status")).toBeInTheDocument();
    // The linked issue renders as the live issue, not as free text.
    expect((await screen.findAllByText("BIO-314")).length).toBeGreaterThan(0);
  });

  it("searches and appends a legacy reference on a grouping without replacing its existing links", async () => {
    const result: SearchIssueResult = {
      id: "issue-2", workspace_id: "ws-1", number: 320, identifier: "BIO-320", title: "Cohort protocol", description: null,
      status: "todo", status_category: "unstarted", priority: "none", assignee_type: null, assignee_id: null,
      creator_type: "member", creator_id: "user-1", parent_issue_id: null, project_id: null, module_id: null,
      position: 1, stage: null, start_date: null, due_date: null, metadata: {}, properties: {}, created_at: "", updated_at: "", match_source: "title",
    };
    vi.mocked(api.searchIssues).mockResolvedValue({ issues: [result] });
    vi.mocked(api.appendCockpitNodeIssue).mockResolvedValue({ id: "reference-2", issue_number: 320, node_id: "task", issue_id: "issue-2", issue_identifier: "BIO-320", issue_title: "Cohort protocol", issue_status: "todo", position: 1 });

    useDetailedBoard(true);
    renderPage();
    fireEvent.click(await screen.findByRole("link", { name: "Gantt" }));
    fireEvent.click(await screen.findByRole("button", { name: "Expand Governance" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open 01.01.01" }));

    fireEvent.click(await screen.findByRole("button", { name: "Link reference issue" }));
    const dialog = await screen.findByRole("dialog"); const search = within(dialog).getByRole("textbox", { name: enCockpit.task_flow.issue_search }); fireEvent.change(search, { target: { value: "cohort" } });
    fireEvent.click(await within(dialog).findByRole("button", { name: "BIO-320 Cohort protocol" })); fireEvent.click(within(dialog).getByRole("button", { name: "Link reference issue" }));
    await waitFor(() => expect(api.appendCockpitNodeIssue).toHaveBeenCalledExactlyOnceWith("ws-1", "task", "issue-2"));
    expect(api.setCockpitNodeIssues).not.toHaveBeenCalled();

  });

  it("filters the tree by search while keeping a matched row's ancestors visible", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("link", { name: "Gantt" }));

    fireEvent.change(await screen.findByLabelText("Search the board"), {
      target: { value: "governance" },
    });

    expect(await screen.findByRole("button", { name: "Open 01.01" })).toBeInTheDocument();
    // The parent stays so the hit has context to be read in.
    expect(screen.getByRole("button", { name: "Open 01" })).toBeInTheDocument();
  });

  it("shows an empty board as an invitation to add work, not as an error", async () => {
    readCockpitFixture.mockResolvedValue({
      ...structuredClone(board),
      nodes: [],
      payments: [],
      issue_links: [],
      milestones: [],
      meetings: [],
    });
    renderPage();
    fireEvent.click(await screen.findByRole("link", { name: "Gantt" }));

    expect(await screen.findByText(/no work breakdown yet/)).toBeInTheDocument();
    expect(screen.queryByText(enCockpit.plan_structure.empty)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add plan item" })).toBeEnabled();
  });

  // Parent binding, observed code, retry identity and late receipts have their
  // canonical component regressions in cockpit-plan-structure-create.test.tsx.
  it("opens explicit plan structure creation from the toolbar without guessing a parent from the selected row", async () => {
    renderPage(); fireEvent.click(await screen.findByRole("link", { name: "Gantt" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open 01" }));
    fireEvent.click(screen.getByRole("button", { name: "Add plan item" })); const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveValue("");
    expect(within(dialog).getByRole("button", { name: "Create plan item" })).toBeDisabled(); expect(api.createCockpitNode).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" })); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.createCockpitNode).not.toHaveBeenCalled(); expect(api.getCockpitNextNodeCode).not.toHaveBeenCalled();
  });

});

describe("CockpitPage detail tables", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCockpitScopeViewStore.getState().reset();
    navSearch.params = new URLSearchParams();
    resetCockpitTestNavigation(`/ws/cockpit?${navSearch.params.size ? navSearch.params : "view=operations"}`);
    readCockpitFixture.mockResolvedValue(structuredClone(board));
    vi.mocked(api.getCockpitMeetingWorkflowSummary).mockImplementation(async (_wsId, meetingId) => workflowSummary({ ...EMPTY_COCKPIT_MEETING_WORKFLOW, meeting_id: meetingId }));
    vi.mocked(api.getCockpitNextNodeCode).mockResolvedValue({ code: "01.02.01" });
    vi.mocked(api.searchIssues).mockResolvedValue({ issues: [] });
    vi.mocked(api.listCockpitSnapshots).mockResolvedValue([]);
    vi.mocked(api.listCockpitChanges).mockResolvedValue([]);
    vi.mocked(api.listModules).mockResolvedValue({ modules: [], total: 0 });
    vi.mocked(api.listProjects).mockResolvedValue({ projects: [], total: 0 });
    readCockpitMembersFixture.mockResolvedValue([
      {
        id: "m1",
        workspace_id: "ws-1",
        user_id: "user-1",
        role: "owner" as const,
        created_at: "",
        name: "Owner",
        email: "owner@example.com",
        avatar_url: null,
      },
    ]);
  });

  it("lists only the rows that carry money on the spend table, with derived dates", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("link", { name: enCockpit.plan_views.finance }));

    const rows = await screen.findAllByRole("row");
    // Header plus the one budgeted node; the branch carries no money of its own.
    expect(rows).toHaveLength(2);
    // Contracted, not paid: the planned date shows and the actual one does not.
    expect(within(rows[1]!).getAllByText("2026-09-05")).toHaveLength(1);
  });

  it("offers vendor names, not owners, as vendor picks and keeps linked issues read-only", async () => {
    const vendored = structuredClone(board);
    vendored.nodes[1]!.vendor = "Acme Cloud";
    readCockpitFixture.mockResolvedValue(vendored);
    renderPage();
    fireEvent.click(await screen.findByRole("link", { name: enCockpit.plan_views.finance }));

    fireEvent.click(await screen.findByRole("button", { name: "Vendor" }));
    // The vendor dropdown draws from the board's vendor values; owners never
    // leak into it through a mis-wired suggestion list.
    expect(await screen.findByRole("option", { name: "Acme Cloud" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Li" })).not.toBeInTheDocument();

    // Linked issues on the spend table are reference chips, not an editable
    // field: the association is maintained from the node panel, never here.
    expect(screen.getByText(/1 reference/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Linked issues" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Linked issues" })).not.toBeInTheDocument();
  });

  it("shows budget and instalment badges on the gantt only once money is turned on", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("link", { name: "Gantt" }));
    expect(screen.queryByRole("columnheader", { name: "Budget / paid" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show money" }));
    expect(await screen.findByText("Budget / paid")).toBeInTheDocument();
    expect(screen.getAllByText("30万").length).toBeGreaterThan(0);
  });
});

describe("CockpitPage versions", () => {
  let snapshots: CockpitSnapshot[] = [];
  let changes: CockpitPendingChange[] = [];
  const scope = { project_id: null, module_id: null, project_title: "", module_title: "" };
  const observation = (change: CockpitPendingChange) => ({ workspace_id: "ws-1", context: scope, change, current_value: change.old_value, conflict: false, review_token: `"${"a".repeat(64)}"` });
  beforeEach(() => {
    vi.clearAllMocks();
    changes = [];
    vi.mocked(api.listCockpitSnapshotPage).mockImplementation(async (_ws, query = {}) => ({ workspace_id: "ws-1", scope: "workspace", q: query.q ?? "", items: snapshots, total: snapshots.length, next_cursor: null }));
    vi.mocked(api.listCockpitChangePage).mockImplementation(async (_ws, _scope, query = {}) => {
      const matched = changes.filter((row) => query.status === "all" || (query.status === "decided" ? row.status !== "pending" : row.status === "pending"));
      return { workspace_id: "ws-1", scope, q: query.q ?? "", status: query.status ?? "all", items: matched.slice(0, query.page_size ?? 25), total: matched.length, next_cursor: null, counts: { pending: changes.filter((row) => row.status === "pending").length, decided: changes.filter((row) => row.status !== "pending").length } };
    });
    vi.mocked(api.getCockpitChangePreview).mockImplementation(async (_ws, id) => observation(changes.find((change) => change.id === id)!));
    useCockpitScopeViewStore.getState().reset();
    navSearch.params = new URLSearchParams();
    resetCockpitTestNavigation(`/ws/cockpit?${navSearch.params.size ? navSearch.params : "view=operations"}`);
    readCockpitFixture.mockResolvedValue(structuredClone(board));
    vi.mocked(api.getCockpitMeetingWorkflowSummary).mockImplementation(async (_wsId, meetingId) => workflowSummary({ ...EMPTY_COCKPIT_MEETING_WORKFLOW, meeting_id: meetingId }));
    vi.mocked(api.getCockpitNextNodeCode).mockResolvedValue({ code: "01.02.01" });
    vi.mocked(api.searchIssues).mockResolvedValue({ issues: [] });
    snapshots = [
      {
        id: "snap-1",
        trigger_kind: "import",
        label: "",
        node_count: 217,
        created_by_type: "member",
        created_by_label: "Owner",
        created_at: "2026-09-07T05:00:00Z",
      },
    ];
    readCockpitMembersFixture.mockResolvedValue([
      {
        id: "m1",
        workspace_id: "ws-1",
        user_id: "user-1",
        role: "owner" as const,
        created_at: "",
        name: "Owner",
        email: "owner@example.com",
        avatar_url: null,
      },
    ]);
  });

  it("explains protected restore on a UUID-bound board while preserving snapshot save and delete permissions", async () => {
    const bound = structuredClone(board);
    bound.nodes[0]!.project_id = "project-1";
    readCockpitFixture.mockResolvedValue(bound);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Versions" }));
    const row = await screen.findByText("217 nodes · Owner");
    expect(screen.getByText("Stable bindings protect this board from full restore. Edit the plan directly.")).toBeInTheDocument();
    const restore = within(row.closest("li")!).getByRole("button", { name: "Restore" });
    expect(restore).toBeDisabled();
    fireEvent.click(restore);
    expect(api.restoreCockpitSnapshot).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save current" })).toBeEnabled();
    expect(within(row.closest("li")!).getByRole("button", { name: "Delete version" })).toBeEnabled();
    expect(screen.queryByText("Only workspace owners and admins can restore or delete versions.")).toBeNull();
  });

  it("protects a board with meeting workflows without querying every meeting", async () => {
    readCockpitFixture.mockResolvedValue({ ...structuredClone(board), has_meeting_workflows: true });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Versions" }));
    const row = await screen.findByText("217 nodes · Owner");
    expect(screen.getByText("Meeting work packages protect this board from full restore. Edit the plan directly.")).toBeTruthy();
    expect(within(row.closest("li")!).getByRole("button", { name: "Restore" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save current" })).toBeEnabled();
    expect(api.getCockpitMeetingWorkflowSummary).not.toHaveBeenCalled();
  });

  it("stops whole-board restore when a refreshed protection read fails while old owner metadata remains cached", async () => {
    const view = renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Versions" }));
    const row = await screen.findByText("217 nodes · Owner");
    expect(within(row.closest("li")!).getByRole("button", { name: "Restore" })).toBeEnabled();
    vi.mocked(api.getCockpitContext).mockRejectedValueOnce(new Error("Directory protection facts unavailable"));
    await act(async () => { await view.client.invalidateQueries({ queryKey: cockpitContextOptions("ws-1", EMPTY_COCKPIT_SCOPE).queryKey }); });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Restore" })).toBeNull());
    expect(screen.getAllByRole("button", { name: enCockpit.snapshot_diff.compare }).every((button) => !button.hasAttribute("disabled"))).toBe(true);
    expect(api.restoreCockpitSnapshot).not.toHaveBeenCalled();
  });

  it("lists the version history and restores on a confirmed second click", async () => {
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Versions" }));
    const row = await screen.findByText("217 nodes · Owner");

    // First click arms the confirm; the board must not be touched yet.
    const restore = within(row.closest("li")!).getByRole("button", { name: "Restore" });
    fireEvent.click(restore);
    expect(api.restoreCockpitSnapshot).not.toHaveBeenCalled();

    vi.mocked(api.restoreCockpitSnapshot).mockResolvedValue({
      nodes: 217, payments: 0, issue_links: 0, milestones: 0, meetings: 0,
      unresolved_issues: [],
    });
    fireEvent.click(within(row.closest("li")!).getByRole("button", { name: "Confirm restore" }));
    await waitFor(() => expect(api.restoreCockpitSnapshot).toHaveBeenCalledWith("snap-1"));
  });

  it("collapses a dense run of auto checkpoints by one actor until expanded", async () => {
    const auto = (id: string, minutesAgo: number) => ({
      id,
      trigger_kind: "auto",
      label: "",
      node_count: 217,
      created_by_type: "agent",
      created_by_label: "Mika",
      created_at: new Date(Date.UTC(2026, 8, 7, 5) - minutesAgo * 60_000).toISOString(),
    });
    snapshots = [
      auto("a3", 6),
      auto("a2", 12),
      auto("a1", 18),
      {
        id: "snap-1",
        trigger_kind: "import",
        label: "",
        node_count: 217,
        created_by_type: "member",
        created_by_label: "Owner",
        created_at: "2026-09-07T04:00:00Z",
      },
    ];

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Versions" }));

    // Three checkpoints by the same agent render as one collapsed row; the
    // per-checkpoint metadata appears only after expanding.
    const group = await screen.findByRole("button", { name: /Auto saves ×3/ });
    expect(screen.queryByText("217 nodes · Mika")).not.toBeInTheDocument();

    fireEvent.click(group);
    expect(await screen.findAllByText("217 nodes · Mika")).toHaveLength(3);
  });

  it("badges the changes tab with the open count and renders the queue", async () => {
    changes = [
      {
        id: "chg-1",
        cockpit_id: "cp",
        node_id: "task",
        node_code: "L3-01-08",
        node_name: "Sign the governance agreement",
        field: "progress",
        old_value: "40",
        new_value: "80",
        source: "agent",
        reason: "Weekly report",
        status: "pending",
        created_by_type: "agent",
        created_by_label: "Mika",
        decided_by_type: "",
        decided_by_label: "",
        decided_at: null,
        created_at: "2026-09-08T02:00:00Z",
        updated_at: "2026-09-08T02:00:00Z", source_task_id: "", source_issue: null, decision_note: "",
      },
    ];

    renderPage();

    // The badge is the tab's whole pitch: an unread count, before the click.
    const tab = await screen.findByRole("link", { name: /^Governance/ });
    await waitFor(() => expect(tab).toHaveTextContent("1"));
    expect(api.listCockpitChanges).not.toHaveBeenCalled();

    fireEvent.click(tab);
    expect(await screen.findByText("Sign the governance agreement")).toBeInTheDocument();
    expect(screen.getByText("80")).toBeInTheDocument();
    expect(screen.getByText("agent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: enCockpit.governance.review_single })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reject/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Withdraw/ })).toBeInTheDocument();
  });

  it("applies a queued change through the API and settles the node it returns", async () => {
    changes = [
      {
        id: "chg-2",
        cockpit_id: "cp",
        node_id: "task",
        node_code: "L3-01-08",
        node_name: "Sign the governance agreement",
        field: "progress",
        old_value: "40",
        new_value: "80",
        source: "manual",
        reason: "",
        status: "pending",
        created_by_type: "member",
        created_by_label: "Owner",
        decided_by_type: "",
        decided_by_label: "",
        decided_at: null,
        created_at: "2026-09-08T02:00:00Z",
        updated_at: "2026-09-08T02:00:00Z", source_task_id: "", source_issue: null, decision_note: "",
      },
    ];
    vi.mocked(api.applyReviewedCockpitChange).mockResolvedValue({
      change: {
        id: "chg-2",
        cockpit_id: "cp",
        node_id: "task",
        node_code: "L3-01-08",
        node_name: "Sign the governance agreement",
        field: "progress",
        old_value: "40",
        new_value: "80",
        source: "manual",
        reason: "",
        status: "applied",
        created_by_type: "member",
        created_by_label: "Owner",
        decided_by_type: "member",
        decided_by_label: "Owner",
        decided_at: "2026-09-08T03:00:00Z",
        created_at: "2026-09-08T02:00:00Z",
        updated_at: "2026-09-08T03:00:00Z", source_task_id: "", source_issue: null, decision_note: "",
      },
      node: { ...board.nodes[1]!, progress: 80 },
    });

    renderPage();
    fireEvent.click(await screen.findByRole("link", { name: /^Governance/ }));
    fireEvent.click(await screen.findByRole("button", { name: enCockpit.governance.review_single }));

    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: enCockpit.governance.confirm_reviewed });
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(api.applyReviewedCockpitChange).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    await waitFor(() => expect(api.applyReviewedCockpitChange).toHaveBeenCalledWith("ws-1", observation(changes[0]!)));
    expect(api.applyCockpitChange).not.toHaveBeenCalled();
  });

  it("offers the filing form and keeps it inert until a task is picked", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("link", { name: /^Governance/ }));

    expect(await screen.findByText("File a change for review")).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "File change" });
    // No task chosen yet: the one required choice the form cannot guess.
    expect(submit).toBeDisabled();
  });

  it("hides the restore affordance from a plain member, who the server would refuse anyway", async () => {
    readCockpitMembersFixture.mockResolvedValue([
      {
        id: "m1",
        workspace_id: "ws-1",
        user_id: "user-1",
        role: "member" as const,
        created_at: "",
        name: "Owner",
        email: "owner@example.com",
        avatar_url: null,
      },
    ]);

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Versions" }));
    await screen.findByText("217 nodes · Owner");
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
    expect(screen.getByText("Only workspace owners and admins can restore or delete versions.")).toBeInTheDocument();
  });
});
