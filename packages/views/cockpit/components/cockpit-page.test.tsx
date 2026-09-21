import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import enCockpit from "../../locales/en/cockpit.json";
import type { CockpitBoard } from "@multica/core/types";

// The derivation matrix (tree building, roll-ups, finance, the monthly strip,
// the digest, the timeline axis) is pinned in
// packages/core/cockpit/model.test.ts (node suite). This file keeps the wiring:
// the page reads the board, both views render it, an inline edit reaches the
// API with the right patch, and issue linking searches and links.

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({
    issueDetail: (id: string) => `/ws/issues/${id}`,
  }),
}));

vi.mock("../../navigation", () => ({
  useNavigation: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname: "/ws/cockpit",
    searchParams: new URLSearchParams(),
  }),
  AppLink: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@multica/core/api", () => ({
  api: {
    getCockpit: vi.fn(),
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
import { CockpitPage } from "./cockpit-page";

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
    },
  ],
  meeting_issues: [],
  meeting_nodes: [],
};

// Detailed fields belong to a genuine depth-two task; keep its fixture index.
function useDetailedBoard() {
  const detailed = structuredClone(board);
  detailed.nodes[1]!.parent_id = "module";
  detailed.nodes.push(node({ id: "module", code: "L2-01-01", parent_id: "root", name: "Governance" }));
  vi.mocked(api.getCockpit).mockResolvedValue(detailed);
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}>
        <CockpitPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("CockpitPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getCockpit).mockResolvedValue(structuredClone(board));
    vi.mocked(api.searchIssues).mockResolvedValue({ issues: [] });
    vi.mocked(api.listCockpitSnapshots).mockResolvedValue([]);
    vi.mocked(api.listCockpitChanges).mockResolvedValue([]);
    vi.mocked(api.listMembers).mockResolvedValue([
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

  it("renders the overview: goal, milestones, modules and finance", async () => {
    renderPage();

    expect(await screen.findByRole("button", { name: "Annual objective" })).toHaveTextContent(
      "End-to-end demo",
    );
    expect(screen.getByText("Dataset acceptance")).toBeInTheDocument();
    // The module name is printed twice on purpose: once on the module card and
    // once in the spend-by-module table.
    expect(screen.getAllByText("High-quality datasets").length).toBeGreaterThan(0);
    expect(screen.getByText("Working group weekly")).toBeInTheDocument();

    // Budget rolls up from the leaf, quoted in the board's 万元 unit.
    const finance = screen.getByText("2026 budget total (per master sheet)").closest("div")!;
    expect(within(finance).getByText("30万")).toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole("button", { name: "Gantt" }));

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
    fireEvent.click(await screen.findByRole("button", { name: "Gantt" }));

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
    fireEvent.click(await screen.findByRole("button", { name: "Gantt" }));

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
    vi.mocked(api.getCockpit).mockResolvedValue(twoOwners);
    vi.mocked(api.updateCockpitNode).mockResolvedValue({ ...twoOwners.nodes[1]!, owner: "Li" });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Gantt" }));

    const ownerButtons = await screen.findAllByRole("button", { name: "Owner" });
    fireEvent.click(ownerButtons[1]!);
    // The dropdown lists the owners the board already uses; one click sets one.
    fireEvent.click(await screen.findByRole("option", { name: "Li" }));

    await waitFor(() => expect(api.updateCockpitNode).toHaveBeenCalledWith("task", { owner: "Li" }));
  });

  it("opens the node panel from the gantt and shows the fields the row has no room for", async () => {
    useDetailedBoard();
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Gantt" }));
    fireEvent.click(await screen.findByRole("button", { name: "Expand Governance" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open 01.01.01" }));

    expect(await screen.findByText("Instalments")).toBeInTheDocument();
    expect(screen.getByText("Deliverable")).toBeInTheDocument();
    expect(screen.getByText("Budget status")).toBeInTheDocument();
    // The linked issue renders as the live issue, not as free text.
    expect(screen.getAllByText("BIO-314").length).toBeGreaterThan(0);
  });

  it("searches issues and links the picked one alongside the existing links", async () => {
    vi.mocked(api.searchIssues).mockResolvedValue({
      issues: [
        {
          id: "issue-2",
          identifier: "BIO-320",
          title: "Cohort protocol",
          status: "todo",
        } as never,
      ],
    });
    vi.mocked(api.setCockpitNodeIssues).mockResolvedValue({ node_id: "task", links: [] });

    useDetailedBoard();
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Gantt" }));
    fireEvent.click(await screen.findByRole("button", { name: "Expand Governance" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open 01.01.01" }));

    fireEvent.click(await screen.findByRole("button", { name: "Link issue" }));
    const search = await screen.findByPlaceholderText("Search issues by title or identifier…");
    fireEvent.change(search, { target: { value: "cohort" } });

    fireEvent.click(await screen.findByText("Cohort protocol"));

    await waitFor(() => {
      // The existing link survives: linking is additive, not a replacement.
      expect(api.setCockpitNodeIssues).toHaveBeenCalledWith(
        "task",
        ["issue-1", "issue-2"],
        { replace: true },
      );
    });
  });

  it("filters the tree by search while keeping a matched row's ancestors visible", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Gantt" }));

    fireEvent.change(await screen.findByLabelText("Search the board"), {
      target: { value: "governance" },
    });

    expect(await screen.findByRole("button", { name: "Open 01.01" })).toBeInTheDocument();
    // The parent stays so the hit has context to be read in.
    expect(screen.getByRole("button", { name: "Open 01" })).toBeInTheDocument();
  });

  it("shows an empty board as an invitation to add work, not as an error", async () => {
    vi.mocked(api.getCockpit).mockResolvedValue({
      ...structuredClone(board),
      nodes: [],
      payments: [],
      issue_links: [],
      milestones: [],
      meetings: [],
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Gantt" }));

    expect(await screen.findByText(/no work breakdown yet/)).toBeInTheDocument();
  });
});

describe("CockpitPage detail tables", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getCockpit).mockResolvedValue(structuredClone(board));
    vi.mocked(api.searchIssues).mockResolvedValue({ issues: [] });
    vi.mocked(api.listCockpitSnapshots).mockResolvedValue([]);
    vi.mocked(api.listCockpitChanges).mockResolvedValue([]);
    vi.mocked(api.listMembers).mockResolvedValue([
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
    fireEvent.click(await screen.findByRole("button", { name: "Spend" }));

    const rows = await screen.findAllByRole("row");
    // Header plus the one budgeted node; the branch carries no money of its own.
    expect(rows).toHaveLength(2);
    // Contracted, not paid: the planned date shows and the actual one does not.
    expect(within(rows[1]!).getAllByText("2026-09-05")).toHaveLength(1);
  });

  it("offers vendor names, not owners, as vendor picks and keeps linked issues read-only", async () => {
    const vendored = structuredClone(board);
    vendored.nodes[1]!.vendor = "Acme Cloud";
    vi.mocked(api.getCockpit).mockResolvedValue(vendored);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Spend" }));

    fireEvent.click(await screen.findByRole("button", { name: "Vendor" }));
    // The vendor dropdown draws from the board's vendor values; owners never
    // leak into it through a mis-wired suggestion list.
    expect(await screen.findByRole("option", { name: "Acme Cloud" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Li" })).not.toBeInTheDocument();

    // Linked issues on the spend table are reference chips, not an editable
    // field: the association is maintained from the node panel, never here.
    expect(screen.getByText("BIO-314")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Linked issues" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Linked issues" })).not.toBeInTheDocument();
  });

  it("shows budget and instalment badges on the gantt only once money is turned on", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Gantt" }));
    expect(screen.queryByRole("columnheader", { name: "Budget / paid" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show money" }));
    expect(await screen.findByText("Budget / paid")).toBeInTheDocument();
    expect(screen.getAllByText("30万").length).toBeGreaterThan(0);
  });
});

describe("CockpitPage versions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getCockpit).mockResolvedValue(structuredClone(board));
    vi.mocked(api.searchIssues).mockResolvedValue({ issues: [] });
    vi.mocked(api.listCockpitSnapshots).mockResolvedValue([
      {
        id: "snap-1",
        trigger_kind: "import",
        label: "",
        node_count: 217,
        created_by_type: "member",
        created_by_label: "Owner",
        created_at: "2026-09-07T05:00:00Z",
      },
    ]);
    vi.mocked(api.listMembers).mockResolvedValue([
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
    vi.mocked(api.listCockpitSnapshots).mockResolvedValue([
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
    ]);

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
    vi.mocked(api.listCockpitChanges).mockResolvedValue([
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
        updated_at: "2026-09-08T02:00:00Z",
      },
    ]);

    renderPage();

    // The badge is the tab's whole pitch: an unread count, before the click.
    const tab = await screen.findByRole("button", { name: /Changes/ });
    expect(tab).toHaveTextContent("1");

    fireEvent.click(tab);
    expect(await screen.findByText("Sign the governance agreement")).toBeInTheDocument();
    expect(screen.getByText("80")).toBeInTheDocument();
    expect(screen.getByText("agent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reject/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Withdraw/ })).toBeInTheDocument();
  });

  it("applies a queued change through the API and settles the node it returns", async () => {
    vi.mocked(api.listCockpitChanges).mockResolvedValue([
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
        updated_at: "2026-09-08T02:00:00Z",
      },
    ]);
    vi.mocked(api.applyCockpitChange).mockResolvedValue({
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
        updated_at: "2026-09-08T03:00:00Z",
      },
      node: { ...board.nodes[1]!, progress: 80 },
    });

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Changes/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Apply" }));

    await waitFor(() => expect(api.applyCockpitChange).toHaveBeenCalledWith("chg-2"));
  });

  it("offers the filing form and keeps it inert until a task is picked", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Changes/ }));

    expect(await screen.findByText("File a change for review")).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "File change" });
    // No task chosen yet: the one required choice the form cannot guess.
    expect(submit).toBeDisabled();
  });

  it("hides the restore affordance from a plain member, who the server would refuse anyway", async () => {
    vi.mocked(api.listMembers).mockResolvedValue([
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
  });
});
