import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import enOffice from "../../locales/en/office.json";
import type { Agent, MemberWithUser, Squad } from "@multica/core/types";
// The zone matrix, timeline ordering and chatter pairing are pinned in
// packages/core/office/*.test.ts (node suites); this file keeps the happy
// path: the page composes data into zones, rails and the leaderboard.

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ agentDetail: (id: string) => `/ws/agents/${id}` }),
}));

// Zustand callable-store shape per the testing rules: selectorFn + getState.
const authState = { user: { id: "user-self", name: "Self", email: "self@fosunpharma.com" } };
vi.mock("@multica/core/auth", () => ({
  useAuthStore: (selector: (s: typeof authState) => unknown) => selector(authState),
}));

// Same shape as settings-page.test.tsx: the page navigates to the agent
// detail on click, the adapter is platform plumbing we do not exercise here.
vi.mock("../../navigation", () => ({
  useNavigation: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname: "/ws/office",
    searchParams: new URLSearchParams(),
  }),
}));

vi.mock("@multica/core/api", () => ({
  api: {
    listAgents: vi.fn().mockResolvedValue([]),
    listRuntimes: vi.fn().mockResolvedValue([]),
    getAgentTaskSnapshot: vi.fn().mockResolvedValue([]),
    listSquads: vi.fn().mockResolvedValue([]),
    listSquadMembers: vi.fn().mockResolvedValue([]),
    getDashboardUsageByAgent: vi.fn().mockResolvedValue([]),
    listMembers: vi.fn().mockResolvedValue([]),
    updateMe: vi.fn().mockResolvedValue({}),
      listIssues: vi.fn().mockResolvedValue([]),
    getBaseUrl: vi.fn().mockReturnValue("https://api.example.test"),
  },
}));

import { api } from "@multica/core/api";
import { OfficePage } from "./office-page";

const agent = (id: string, name: string, runtimeId: string): Agent =>
  ({
    id,
    name,
    runtime_id: runtimeId,
    archived_at: null,
    runtime_bound: true,
    avatar_url: null,
    max_concurrent_tasks: 2,
  } as unknown as Agent);

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en" resources={{ en: { office: enOffice } }}>
        <OfficePage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  // clearAllMocks keeps implementations, and test 1 sets non-empty
  // responses — reset to the empty office so each test starts clean.
  const mockedApi = api as unknown as {
    listAgents: ReturnType<typeof vi.fn>;
    listRuntimes: ReturnType<typeof vi.fn>;
    getAgentTaskSnapshot: ReturnType<typeof vi.fn>;
    listSquads: ReturnType<typeof vi.fn>;
    listSquadMembers: ReturnType<typeof vi.fn>;
    getDashboardUsageByAgent: ReturnType<typeof vi.fn>;
    listMembers: ReturnType<typeof vi.fn>;
    updateMe: ReturnType<typeof vi.fn>;
    listIssues: ReturnType<typeof vi.fn>;
  };
  mockedApi.listAgents.mockResolvedValue([]);
  mockedApi.listRuntimes.mockResolvedValue([]);
  mockedApi.getAgentTaskSnapshot.mockResolvedValue([]);
  mockedApi.listSquads.mockResolvedValue([]);
  mockedApi.listSquadMembers.mockResolvedValue([]);
  mockedApi.getDashboardUsageByAgent.mockResolvedValue([]);
  mockedApi.listMembers.mockResolvedValue([]);
  mockedApi.updateMe.mockResolvedValue({});
mockedApi.listIssues.mockResolvedValue([]);
});

describe("OfficePage", () => {
  it("renders the floor plan with working and idle agents in their zones", async () => {
    const mocked = api as unknown as {
      listAgents: ReturnType<typeof vi.fn>;
      listRuntimes: ReturnType<typeof vi.fn>;
      getAgentTaskSnapshot: ReturnType<typeof vi.fn>;
      getDashboardUsageByAgent: ReturnType<typeof vi.fn>;
    };
    mocked.listAgents.mockResolvedValue([
      agent("a1", "Alpha", "rt-1"),
      agent("a2", "Beta", "rt-2"),
    ]);
    // Presence resolves online through agent.runtime_id -> runtime.status,
    // so the floor plan seats agents instead of listing them as absent.
    mocked.listRuntimes.mockResolvedValue([
      { id: "rt-1", status: "online", last_seen_at: new Date().toISOString() },
      { id: "rt-2", status: "online", last_seen_at: new Date().toISOString() },
    ]);
    mocked.getAgentTaskSnapshot.mockResolvedValue([
      {
        id: "t1",
        agent_id: "a1",
        status: "running",
        issue_id: "i1",
        started_at: "2026-01-01T00:00:00Z",
        completed_at: null,
        dispatched_at: "2026-01-01T00:00:00Z",
        created_at: "2026-01-01T00:00:00Z",
      },
    ]);
    mocked.getDashboardUsageByAgent.mockResolvedValue([
      {
        agent_id: "a1",
        provider: "anthropic",
        model: "claude",
        input_tokens: 900,
        output_tokens: 100,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        task_count: 3,
      },
    ]);

    renderPage();

    // Header + zone names + both agents' names settle once queries resolve.
    // Agent names appear in more than one place (floor figure + token row),
    // so query the plural form.
    expect(await screen.findAllByText("Alpha")).not.toHaveLength(0);
    expect(await screen.findAllByText("Beta")).not.toHaveLength(0);
    expect(screen.getByText("Desks")).toBeInTheDocument();
    expect(screen.getByText("Token leaderboard")).toBeInTheDocument();
    expect(screen.getByText("1K")).toBeInTheDocument(); // 900 + 100 compact
    // Alpha runs a task so the desk caption reads "Running 1/...".
    expect(screen.getByText(/Running/)).toBeInTheDocument();
  });

  it("lists absent agents in the rail, not on the floor", async () => {
    // An absent agent is the one part of the cast the scene cannot draw. It
    // used to be a bare strip of chips under the room; this pins it to the
    // rail so it cannot drift back.
    const mocked = api as unknown as {
      listAgents: ReturnType<typeof vi.fn>;
      listRuntimes: ReturnType<typeof vi.fn>;
    };
    mocked.listAgents.mockResolvedValue([agent("a9", "Omega", "rt-9")]);
    mocked.listRuntimes.mockResolvedValue([
      { id: "rt-9", status: "offline", last_seen_at: new Date().toISOString() },
    ]);

    renderPage();

    expect(await screen.findByText("Omega")).toBeInTheDocument();
    expect(screen.getByText(enOffice.zones.absent.name)).toBeInTheDocument();
    expect(document.querySelector("svg")?.textContent ?? "").not.toContain("Omega");
  });

  it("shows zone empty states when the office is empty", async () => {
    renderPage();
    expect(await screen.findByText(/Every desk is free/)).toBeInTheDocument();
    expect(screen.getByText(/The sofa is free/)).toBeInTheDocument();
  });

  it("renders member figures with their statuses, scoped to the office domain", async () => {
    const mocked = api as unknown as {
    listMembers: ReturnType<typeof vi.fn>;
    listIssues: ReturnType<typeof vi.fn>;
  };
    mocked.listMembers.mockResolvedValue([
      {
        id: "mem-1",
        workspace_id: "ws-1",
        user_id: "user-self",
        role: "member",
        created_at: "2026-01-01T00:00:00Z",
        name: "Self",
        email: "self@fosunpharma.com",
        avatar_url: null,
        custom_status: "🎧 focusing",
      },
      {
        id: "mem-2",
        workspace_id: "ws-1",
        user_id: "user-lin",
        role: "member",
        created_at: "2026-01-02T00:00:00Z",
        name: "Lin",
        email: "lin@fosunpharma.com",
        avatar_url: null,
        custom_status: "",
      },
      {
        id: "mem-3",
        workspace_id: "ws-1",
        user_id: "user-bot",
        role: "member",
        created_at: "2026-01-03T00:00:00Z",
        name: "Service Bot",
        email: "bot@example.com",
        avatar_url: null,
        custom_status: "should not appear",
      },
    ] satisfies MemberWithUser[]);
    // Self has work in progress (desk), Lin has queued work (waiting): the
    // issue counts decide where each human stands, not a dedicated corner.
    mocked.listIssues.mockResolvedValue({
      total: 2,
      issues: [
      {
        id: "issue-1",
        assignee_type: "member",
        assignee_id: "user-self",
        status: "Doing",
        status_category: "in_progress",
      },
      {
        id: "issue-2",
        assignee_type: "member",
        assignee_id: "user-lin",
        status: "Todo",
        status_category: "todo",
      },
      ],
    });

    renderPage();

    // Employees get figures with a status pill (title + drawn text); the
    // non-office account does not appear on the floor at all.
    expect(await screen.findAllByText("🎧 focusing")).not.toHaveLength(0);
    expect(document.querySelector('[data-member="user-self"]')).not.toBeNull();
    expect(document.querySelector('[data-member="user-lin"]')).not.toBeNull();
    expect(document.querySelector('[data-member="user-bot"]')).toBeNull();
    expect(screen.queryByText("should not appear")).not.toBeInTheDocument();
    // A self with a status has no "set status" pill, but Lin (empty status,
    // not self) has no pill at all.
    expect(screen.queryByText("Set status")).not.toBeInTheDocument();
  });

  it("opens the status editor above the viewer's own head and saves a custom status", async () => {
    const mockedApi = api as unknown as {
      listMembers: ReturnType<typeof vi.fn>;
      updateMe: ReturnType<typeof vi.fn>;
    };
    mockedApi.listMembers.mockResolvedValue([
      {
        id: "mem-1",
        workspace_id: "ws-1",
        user_id: "user-self",
        role: "member",
        created_at: "2026-01-01T00:00:00Z",
        name: "Self",
        email: "self@fosunpharma.com",
        avatar_url: null,
        custom_status: "",
      },
    ] satisfies MemberWithUser[]);

    renderPage();

    // Empty own status → a "Set status" pill above the own head.
    const setPill = await screen.findByText("Set status");
    fireEvent.click(setPill);

    const input = await screen.findByPlaceholderText("Type a custom status...");
    fireEvent.change(input, { target: { value: "reviewing PRs" } });
    fireEvent.click(screen.getByText("Save"));

    await vi.waitFor(() => {
      expect(mockedApi.updateMe).toHaveBeenCalledWith({ custom_status: "reviewing PRs", custom_status_key: "" });
    });
    // The editor closes after saving.
    expect(screen.queryByPlaceholderText("Type a custom status...")).not.toBeInTheDocument();
  });

  // Wiring only: preset buttons must send the KEY (which routes the floor
  // zone server-side), not just the localized label. The key→zone matrix
  // itself is pinned in packages/core/office/humans.test.ts.
  it("saves a preset status with its key so the floor zone follows it", async () => {
    const mockedApi = api as unknown as {
      listMembers: ReturnType<typeof vi.fn>;
      updateMe: ReturnType<typeof vi.fn>;
    };
    mockedApi.listMembers.mockResolvedValue([
      {
        id: "mem-1",
        workspace_id: "ws-1",
        user_id: "user-self",
        role: "member",
        created_at: "2026-01-01T00:00:00Z",
        name: "Self",
        email: "self@fosunpharma.com",
        avatar_url: null,
        custom_status: "",
        custom_status_key: "",
      },
    ] satisfies MemberWithUser[]);

    renderPage();

    fireEvent.click(await screen.findByText("Set status"));
    fireEvent.click(await screen.findByText("🗣 In a meeting"));

    await vi.waitFor(() => {
      expect(mockedApi.updateMe).toHaveBeenCalledWith({
        custom_status: "🗣 In a meeting",
        custom_status_key: "meeting",
      });
    });
  });

  it("counts the PMO squad's full roster in the project office as present and working", async () => {
    const mocked = api as unknown as {
      listAgents: ReturnType<typeof vi.fn>;
      listRuntimes: ReturnType<typeof vi.fn>;
      listSquads: ReturnType<typeof vi.fn>;
      listSquadMembers: ReturnType<typeof vi.fn>;
    };
    mocked.listAgents.mockResolvedValue([
      agent("a1", "Planner", "rt-1"),
      agent("a2", "Scheduler", "rt-2"),
    ]);
    mocked.listRuntimes.mockResolvedValue([
      { id: "rt-1", status: "online", last_seen_at: new Date().toISOString() },
      { id: "rt-2", status: "online", last_seen_at: new Date().toISOString() },
    ]);
    // Idle members of a squad whose name claims the project office: zones.ts
    // keeps them in their own room, and the header stats count them on duty.
    mocked.listSquads.mockResolvedValue([
      {
        id: "sq-1",
        workspace_id: "ws-1",
        name: "PMO",
        description: "",
        instructions: "",
        avatar_url: null,
        leader_id: "a1",
        creator_id: "u1",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        archived_at: null,
        archived_by: null,
        // Deliberately short of the roster below: `member_preview` stops at
        // three entries, so the room has to come from listSquadMembers.
        member_preview: [],
      } satisfies Squad,
    ]);
    mocked.listSquadMembers.mockResolvedValue([
      { member_type: "agent", member_id: "a1", role: "lead" },
      { member_type: "agent", member_id: "a2", role: "member" },
    ]);

    renderPage();

    const stat = (label: string) =>
      screen.getByText(label).parentElement?.querySelector("dd")?.textContent;
    await vi.waitFor(() => {
      expect(stat(enOffice.stats.working)).toBe("2");
    });
    expect(stat(enOffice.stats.present)).toBe("2");
    // Not absent: being in the project office is being on duty.
    expect(stat(enOffice.stats.absent)).toBe("0");
    // The roster came from the squad's own endpoint, not `member_preview`.
    expect(mocked.listSquadMembers).toHaveBeenCalledWith("sq-1");
  });
});
