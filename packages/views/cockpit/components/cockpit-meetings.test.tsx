import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import enCockpit from "../../locales/en/cockpit.json";
import enCommon from "../../locales/en/common.json";
import type { CockpitBoard, CockpitMeeting } from "@multica/core/types";

// The register's wiring: the tab renders the board's meetings, the four views
// are reachable, selecting one opens its panel, and filing one shows the name
// and the destination BEFORE it creates anything.
//
// The calendar maths, the generated name and the link grouping are pinned in
// packages/core/cockpit/meetings.test.ts (node suite); this file does not
// re-test them.

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ issueDetail: (id: string) => `/ws/issues/${id}` }),
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
import { CockpitPage } from "./cockpit-page";

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
    nas_dir: "", detected: false, ...over,
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
    meeting_project_id: "project-06",
    meeting_module_id: "module-0606",
    meeting_node_id: "node-060603",
    meeting_dir: "",
    created_at: "",
    updated_at: "",
  },
  nodes: [
    {
      id: "root", cockpit_id: "cp", parent_id: null, code: "L1-06", name: "Programme management",
      position: 0, color: "#2563eb", owner: "", collaborators: "", start_date: null, end_date: null,
      status: "", progress: 0, deliverable: "", dependencies: "", note: "", current_progress: "",
      vendor: "", budget_category: "", budget_amount: null, exec_status: "", contract: "",
      source: "", updated_by_type: "", updated_by_id: null, created_at: "", updated_at: "",
    },
    {
      id: "n0606", cockpit_id: "cp", parent_id: "root", code: "06.06", name: "Joint working and meetings",
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
  ],
  meeting_issues: [
    {
      meeting_id: "meet-1", issue_id: "issue-1", role: "task", issue_number: 42,
      issue_identifier: "BIO-42", issue_title: "Working group weekly", issue_status: "todo",
      position: -1,
    },
  ],
  meeting_nodes: [{ meeting_id: "meet-1", node_id: "n0606", position: 0 }],
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

async function openRegister() {
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Meetings" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getCockpit).mockResolvedValue(structuredClone(board));
  vi.mocked(api.listCockpitSnapshots).mockResolvedValue([]);
  vi.mocked(api.listCockpitChanges).mockResolvedValue([]);
  vi.mocked(api.listMembers).mockResolvedValue([
    { user_id: "user-1", role: "owner", name: "Yang Tao", email: "yangtao@example.com", avatar_url: null },
    { user_id: "user-2", role: "member", name: "Wang Gong", email: "wanggong@example.com", avatar_url: null },
  ] as unknown as Awaited<ReturnType<typeof api.listMembers>>);
  vi.mocked(api.listProjects).mockResolvedValue([
    { id: "project-06", title: "06 Programme management" },
  ] as unknown as Awaited<ReturnType<typeof api.listProjects>>);
  vi.mocked(api.listModules).mockResolvedValue([
    { id: "module-0606", project_id: "project-06", title: "06.06 Joint working and meetings" },
  ] as unknown as Awaited<ReturnType<typeof api.listModules>>);
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

    const row = (await screen.findByText(`${codeDay()}-01`)).closest("tr")!;
    expect(within(row).getByText(/10:00–11:00/)).toBeInTheDocument();
    expect(within(row).getByText("Fosun Pharma、BGI")).toBeInTheDocument();
    // One issue and one work item are two links, counted together.
    expect(within(row).getByText("2")).toBeInTheDocument();
    expect(screen.getByText("Kickoff")).toBeInTheDocument();
  });

  it("switches between the four views without losing the board", async () => {
    await openRegister();
    await screen.findByText(`${codeDay()}-01`);

    for (const view of ["Month", "Week", "Agenda"]) {
      fireEvent.click(screen.getByRole("button", { name: view, pressed: false }));
      expect(screen.getByRole("button", { name: view, pressed: true })).toBeInTheDocument();
      expect(screen.getAllByLabelText(/Open Working group weekly/).length).toBeGreaterThan(0);
    }
  });

  // The confirmation names the record. It used to be handed the delete
  // button's own accessible name, so it offered to permanently remove
  // "Delete meeting Working group weekly".
  it("names the meeting, not the button, when it asks before deleting", async () => {
    await openRegister();
    fireEvent.click(await screen.findByRole("button", { name: "Open Working group weekly" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete meeting Working group weekly" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText("Working group weekly will be permanently removed. This cannot be undone."),
    ).toBeInTheDocument();
  });

  it("opens one meeting in a panel, with its task, its work item and its folder", async () => {
    await openRegister();
    fireEvent.click(await screen.findByRole("button", { name: "Open Working group weekly" }));

    // The meeting's own task reads as an ordinary issue.
    expect(await screen.findByText("BIO-42")).toBeInTheDocument();
    // The linked work item is addressed by the code the gantt uses.
    expect(screen.getByRole("button", { name: /Show .*Joint working and meetings/ })).toBeInTheDocument();
    expect(
      screen.getByText("/Volumes/share/06.06/20260921-01 Working group weekly"),
    ).toBeInTheDocument();
  });

  it("writes a field edit from the panel as a patch of just that field", async () => {
    await openRegister();
    fireEvent.click(await screen.findByRole("button", { name: "Open Working group weekly" }));

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

  it("shows the generated name and the exact folder before anything is created", async () => {
    await openRegister();
    fireEvent.click(await screen.findByRole("button", { name: "New meeting" }));

    const dialog = await screen.findByRole("dialog");
    // Parties is a list, edited as a list: the organisations the board has
    // already met with are ticked rather than retyped, and the search box
    // narrows a long list down to one of them.
    fireEvent.click(within(dialog).getByRole("button", { name: "Parties" }));
    const partyBox = screen.getByRole("textbox", { name: "Parties" });
    fireEvent.click(screen.getByRole("option", { name: "Fosun Pharma" }));
    fireEvent.change(partyBox, { target: { value: "bg" } });
    expect(screen.queryByRole("option", { name: "Fosun Pharma" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "BGI" }));
    // A name nobody has used yet is offered as something to add.
    fireEvent.change(partyBox, { target: { value: "Unicom" } });
    expect(screen.getByRole("button", { name: 'Add “Unicom”' })).toBeInTheDocument();
    fireEvent.change(partyBox, { target: { value: "" } });
    fireEvent.keyDown(partyBox, { key: "Enter" });

    fireEvent.change(within(dialog).getByLabelText("Subject"), {
      target: { value: "Data handover" },
    });

    const code = `${codeDay()}-02`;
    const name = within(dialog).getByLabelText("Name") as HTMLInputElement;
    expect(name.value).toBe(`${code} Fosun Pharma×BGI Data handover`);
    // The destination is named, not implied: the project, the module, the
    // archive sub-item and the absolute path the folder will be created at —
    // one level below the module, where the programme keeps its material.
    expect(within(dialog).getByText(/06 Programme management/)).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(dialog).getByText(new RegExp(`/Volumes/share/06\\.06/06\\.06\\.03/${code}`)),
      ).toBeInTheDocument(),
    );
    // And the number the task will open with, because the sub-item is what
    // gives it one.
    expect(within(dialog).getByText(/as 06\.06\.03, assigned to you/)).toBeInTheDocument();
  });

  it("files the meeting first and provisions it second, reporting what each did", async () => {
    const created = meeting({ id: "meet-new", code: "20260921-02", title: "New one" });
    vi.mocked(api.createCockpitMeeting).mockResolvedValue(created);
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
    fireEvent.click(await screen.findByRole("button", { name: "New meeting" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(api.getCockpitMeetingDestination).toHaveBeenCalled());
    fireEvent.click(within(dialog).getByRole("button", { name: "Create meeting" }));

    await waitFor(() => expect(api.createCockpitMeeting).toHaveBeenCalled());
    // The row is written on its own, then the side effects are asked for —
    // an unmounted share must never cost the record of a meeting.
    expect(vi.mocked(api.createCockpitMeeting).mock.calls[0]![0]).toMatchObject({
      code: `${codeDay()}-02`,
    });
    await waitFor(() =>
      expect(api.provisionCockpitMeeting).toHaveBeenCalledWith(
        "meet-new",
        expect.objectContaining({ project_id: "project-06", module_id: "module-0606" }),
      ),
    );
  });

  it("offers the register from the overview card", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Open the meeting register" }));
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
      meetings: [meeting({ id: "meet-2", title: "Trusted connector review", detected: true })],
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
      }),
    );
  });

  it("says a row was read off the share until someone has checked it", async () => {
    vi.mocked(api.getCockpit).mockResolvedValue({
      ...structuredClone(board),
      meetings: [meeting({ id: "meet-1", title: "Guessed meeting", meet_date: todayString(), detected: true })],
    });
    await openRegister();

    fireEvent.click(await screen.findByRole("button", { name: "Open Guessed meeting" }));
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
    fireEvent.click(await screen.findByRole("button", { name: "Open Working group weekly" }));

    fireEvent.click(await screen.findByRole("button", { name: "Attendees" }));
    const box = screen.getByRole("textbox", { name: "Attendees" });
    // The workspace's own people are the list, and the address is there to
    // tell two of the same name apart.
    expect(screen.getByRole("option", { name: /Yang Tao/ })).toBeInTheDocument();
    expect(screen.getByText("wanggong@example.com")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /Yang Tao/ }));

    // Half the room at a joint meeting has no account here.
    fireEvent.change(box, { target: { value: "Zhang from BGI" } });
    fireEvent.click(screen.getByRole("button", { name: 'Add “Zhang from BGI”' }));
    // The list is shorter now and a different row sits under the cursor.
    // Enter must still mean "done" rather than "tick whatever moved there".
    fireEvent.mouseEnter(screen.getByRole("option", { name: /Wang Gong/ }));
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() =>
      expect(api.updateCockpitMeeting).toHaveBeenCalledWith("meet-1", {
        attendees: "Yang Tao、Zhang from BGI",
      }),
    );
  });

  it("starts the meeting type from the programme's own words", async () => {
    await openRegister();
    fireEvent.click(await screen.findByRole("button", { name: "Open Working group weekly" }));

    fireEvent.click(await screen.findByRole("button", { name: "Type" }));
    // An empty board still opens on a vocabulary rather than on a blank box.
    expect(screen.getByRole("option", { name: "例会" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "对接会" }));

    await waitFor(() =>
      expect(api.updateCockpitMeeting).toHaveBeenCalledWith("meet-1", { kind: "对接会" }),
    );
  });
});
