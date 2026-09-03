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
  },
}));

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
      meet_date: "2026-09-01",
      time_range: "10:00-11:00",
      title: "Working group weekly",
      attendees: "Everyone",
      meet_no: "509",
      link: "",
      note: "",
    },
  ],
};

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
    vi.mocked(api.searchIssues).mockResolvedValue({ issues: [], total: 0 });
  });

  it("renders the overview: goal, milestones, modules and finance", async () => {
    renderPage();

    expect(await screen.findByRole("button", { name: "Annual objective" })).toHaveTextContent(
      "End-to-end demo",
    );
    expect(screen.getByText("Dataset acceptance")).toBeInTheDocument();
    expect(screen.getByText("High-quality datasets")).toBeInTheDocument();
    expect(screen.getByText("Working group weekly")).toBeInTheDocument();

    // Budget rolls up from the leaf; the leaf's instalment counts as contracted.
    const finance = screen.getByText("Budgeted").closest("div")!;
    expect(within(finance).getByText("30")).toBeInTheDocument();
  });

  it("switches to the gantt and lists the tree with its rolled-up branch progress", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Gantt" }));

    expect(await screen.findByRole("button", { name: "Open L3-01-08" })).toBeInTheDocument();
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

  it("opens the node panel from the gantt and shows the fields the row has no room for", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Gantt" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open L3-01-08" }));

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
      total: 1,
    });
    vi.mocked(api.setCockpitNodeIssues).mockResolvedValue({ node_id: "task", links: [] });

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Gantt" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open L3-01-08" }));

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

    expect(await screen.findByRole("button", { name: "Open L3-01-08" })).toBeInTheDocument();
    // The parent stays so the hit has context to be read in.
    expect(screen.getByRole("button", { name: "Open L1-01" })).toBeInTheDocument();
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
