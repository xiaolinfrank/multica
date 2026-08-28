import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import enOffice from "../../locales/en/office.json";
import type { Agent, MemberWithUser } from "@multica/core/types";
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
    getDashboardUsageByAgent: vi.fn().mockResolvedValue([]),
    listMembers: vi.fn().mockResolvedValue([]),
    updateMe: vi.fn().mockResolvedValue({}),
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
    getDashboardUsageByAgent: ReturnType<typeof vi.fn>;
    listMembers: ReturnType<typeof vi.fn>;
    updateMe: ReturnType<typeof vi.fn>;
  };
  mockedApi.listAgents.mockResolvedValue([]);
  mockedApi.listRuntimes.mockResolvedValue([]);
  mockedApi.getAgentTaskSnapshot.mockResolvedValue([]);
  mockedApi.listSquads.mockResolvedValue([]);
  mockedApi.getDashboardUsageByAgent.mockResolvedValue([]);
  mockedApi.listMembers.mockResolvedValue([]);
  mockedApi.updateMe.mockResolvedValue({});
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
    // Alpha runs a task so the desk caption reads "Running 1/…".
    expect(screen.getByText(/Running/)).toBeInTheDocument();
  });

  it("shows zone empty states when the office is empty", async () => {
    renderPage();
    expect(await screen.findByText(/Every desk is free/)).toBeInTheDocument();
    expect(screen.getByText(/The sofa is free/)).toBeInTheDocument();
  });

  it("renders member figures with their statuses, scoped to the office domain", async () => {
    const mocked = api as unknown as { listMembers: ReturnType<typeof vi.fn> };
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

    renderPage();

    // Employees get figures with a status pill (title + drawn text); the
    // non-office account does not appear on the floor at all.
    expect(await screen.findAllByText("🎧 focusing")).not.toHaveLength(0);
    expect(screen.getByText("Members")).toBeInTheDocument();
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

    const input = await screen.findByPlaceholderText("Type a custom status…");
    fireEvent.change(input, { target: { value: "reviewing PRs" } });
    fireEvent.click(screen.getByText("Save"));

    await vi.waitFor(() => {
      expect(mockedApi.updateMe).toHaveBeenCalledWith({ custom_status: "reviewing PRs" });
    });
    // The editor closes after saving.
    expect(screen.queryByPlaceholderText("Type a custom status…")).not.toBeInTheDocument();
  });
});
