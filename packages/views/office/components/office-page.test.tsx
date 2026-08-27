import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import enOffice from "../../locales/en/office.json";
import type { Agent } from "@multica/core/types";
// The zone matrix, timeline ordering and chatter pairing are pinned in
// packages/core/office/*.test.ts (node suites); this file keeps the happy
// path: the page composes data into zones, rails and the leaderboard.

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ agentDetail: (id: string) => `/ws/agents/${id}` }),
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
  };
  mockedApi.listAgents.mockResolvedValue([]);
  mockedApi.listRuntimes.mockResolvedValue([]);
  mockedApi.getAgentTaskSnapshot.mockResolvedValue([]);
  mockedApi.listSquads.mockResolvedValue([]);
  mockedApi.getDashboardUsageByAgent.mockResolvedValue([]);
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
});
