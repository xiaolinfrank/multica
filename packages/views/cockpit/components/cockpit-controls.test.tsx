import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enCockpit from "../../locales/en/cockpit.json";
import type { CockpitBoard } from "@multica/core/types";

// Dedicated regressions for confirmations, weekly timeline inspection and export.

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
      meet_date: "2026-09-01",
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
      series: "",
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

describe("Cockpit controls regressions", () => {
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

  it("requires confirmation before deleting a milestone and waits for the server", async () => {
    let resolve!: (value: void) => void;
    vi.mocked(api.deleteCockpitMilestone).mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Delete milestone Dataset acceptance" }));
    expect(api.deleteCockpitMilestone).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deleteCockpitMilestone).toHaveBeenCalled());
    expect(within(dialog).getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(dialog).toBeInTheDocument();
    resolve();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("keeps the confirmation open after a failed deletion for retry", async () => {
    vi.mocked(api.deleteCockpitMilestone).mockRejectedValue(new Error("offline"));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Delete milestone Dataset acceptance" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deleteCockpitMilestone).toHaveBeenCalled());
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Delete" })).not.toBeDisabled());
    expect(dialog).toBeInTheDocument();
  });

  it("opens week details with tasks even when the root branch is collapsed", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Gantt" }));
    fireEvent.click(screen.getByRole("button", { name: "Collapse High-quality datasets" }));
    await userEvent.click(screen.getByRole("combobox", { name: "Timeline density" }));
    await userEvent.click(await screen.findByRole("option", { name: "Week" }));
    fireEvent.click(await screen.findByRole("button", { name: "Week · 2026-09-14 – 2026-09-20" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Sign the governance agreement/)).toBeInTheDocument();
    expect(within(dialog).getByText("2026-09-20")).toBeInTheDocument();
  });
  it("collapses only secondary controls, leaving search available", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Gantt" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide timeline controls" }));
    expect(screen.queryByRole("combobox", { name: "Timeline density" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Search the board" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show timeline controls" }));
    expect(screen.getByRole("combobox", { name: "Timeline density" })).toBeInTheDocument();
  });



});
