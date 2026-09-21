import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import { CockpitGantt, cockpitWeekTasks } from "./cockpit-gantt";
import enCockpit from "../../locales/en/cockpit.json";
import type { CockpitBoard } from "@multica/core/types";

// Dedicated interaction regressions.
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
import { captureCockpitGantt, printCockpitGantt } from "./cockpit-export";
vi.mock("./cockpit-export", () => ({ captureCockpitGantt: vi.fn(), printCockpitGantt: vi.fn(), downloadCockpitPng: vi.fn() }));

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
    meeting_module_id: null,
    meeting_node_id: null,
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
      meet_date: new Date().toLocaleDateString("en-CA"),
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
      nas_dir: "", detected: false,
    },
  ],
  meeting_issues: [],
  meeting_nodes: [],
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, common: enCommon } }}>
        <CockpitPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("Cockpit secondary interactions", () => {
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


  it("requires confirmation and keeps a failed milestone deletion open for retry", async () => {
    vi.mocked(api.deleteCockpitMilestone).mockRejectedValue(new Error("Server rejected deletion"));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Delete milestone Dataset acceptance" }));
    expect(api.deleteCockpitMilestone).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deleteCockpitMilestone).toHaveBeenCalled());
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Delete" })).not.toBeDisabled());
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("waits for a meeting deletion before closing and prevents repeat submissions", async () => {
    let finish!: () => void;
    vi.mocked(api.deleteCockpitMeeting).mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    renderPage();
    // The meeting row opens a read-only detail dialog; deletion lives behind
    // its Edit entry, one hop from reading.
    fireEvent.click(
      await screen.findByRole("button", { name: "Meeting details: Working group weekly" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete meeting Working group weekly" }));
    const dialog = await screen.findByRole("alertdialog");
    const remove = within(dialog).getByRole("button", { name: "Delete" });
    fireEvent.click(remove);
    fireEvent.click(remove);
    expect(remove).toBeDisabled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    await waitFor(() => expect(api.deleteCockpitMeeting).toHaveBeenCalledTimes(1));
    finish();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("collapses only the secondary controls, retaining search and exports", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Gantt" }));
    const toggle = screen.getAllByRole("button", { name: enCockpit.toolbar.collapse_controls })
      .find((el) => el.getAttribute("aria-controls") === "cockpit-secondary-toolbar")!;
    fireEvent.click(toggle);
    expect(screen.queryByRole("combobox", { name: "Timeline density" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Search the board" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export" })).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByRole("combobox", { name: "Timeline density" })).toBeInTheDocument();
  });

  it("confirms payment deletion rather than immediately deleting from the node panel", async () => {
    vi.mocked(api.deleteCockpitPayment).mockResolvedValue(undefined);
    const paymentBoard = structuredClone(board);
    paymentBoard.nodes.push(node({ id: "module", code: "L2-01-01", parent_id: "root" }));
    paymentBoard.nodes[1]!.parent_id = "module";
    vi.mocked(api.getCockpit).mockResolvedValue(paymentBoard);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Gantt" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Expand all" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open 01.01.01" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete instalment" }));
    expect(api.deleteCockpitPayment).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deleteCockpitPayment).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("exports the actual Gantt in an isolated popup rather than a substitute task report", async () => {
    const canvas = document.createElement("canvas");
    vi.mocked(captureCockpitGantt).mockResolvedValue(canvas);
    vi.mocked(printCockpitGantt).mockResolvedValue(undefined);
    const doc = document.implementation.createHTMLDocument();
    const popup = { document: doc, print: vi.fn(), focus: vi.fn(), close: vi.fn(), opener: window };
    const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    try {
      renderPage();
      fireEvent.click(await screen.findByRole("button", { name: "Gantt" }));
      fireEvent.click(screen.getByRole("button", { name: "Export" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: enCockpit.toolbar.export_pdf }));
      await waitFor(() => expect(printCockpitGantt).toHaveBeenCalledWith(canvas, popup, expect.stringMatching(/^Programme board-/)));
      expect(captureCockpitGantt).toHaveBeenCalledWith(expect.objectContaining({ dataset: expect.objectContaining({ cockpitGantt: "true" }) }), true);
      expect(popup.opener).toBeNull();
    } finally { open.mockRestore(); }
  });

  it("opens week details for tasks inside a collapsed branch without obsolete core markers", async () => {
    const select = vi.fn();
    render(<I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}>
      <CockpitGantt board={board} today="2026-09-18" zoom="week" query=""
        rootIds={new Set()} collapsed={new Set(["root"])} onToggleCollapse={vi.fn()}
        onSelect={select} selectedId={null} onPatchNode={vi.fn()} statusSuggestions={[]}
        ownerSuggestions={[]} showFinance={false} toolbarOpen scrollToTodayNonce={0} focusTarget={null} />
    </I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Week · 2026-09-14 – 2026-09-20" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "01.01 Sign the governance agreement" }));
    expect(select).toHaveBeenCalledWith("task");
    expect(screen.queryByRole("button", { name: /coming due/ })).not.toBeInTheDocument();
  });

  it("includes boundary deadlines and running tasks but excludes undated and reversed ranges", () => {
    const base = board.nodes[1]!;
    const tasks = [
      { ...base, id: "running", start_date: "2026-09-01", end_date: "2026-09-30" },
      { ...base, id: "deadline", start_date: null, end_date: "2026-09-20" },
      { ...base, id: "next", start_date: null, end_date: "2026-09-21" },
      { ...base, id: "undated", start_date: null, end_date: null },
      { ...base, id: "reversed", start_date: "2026-09-20", end_date: "2026-09-14" },
    ];
    expect(cockpitWeekTasks(tasks, "2026-09-14", "2026-09-20").map((n) => n.id))
      .toEqual(["running", "deadline"]);
  });
});
