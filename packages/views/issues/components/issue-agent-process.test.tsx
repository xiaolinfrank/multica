// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@multica/core/api";
import { WorkspaceSlugProvider } from "@multica/core/paths";
import { chatKeys } from "@multica/core/chat/queries";
import { useAgentProcessFoldStore } from "@multica/core/issues/stores";
import type { AgentTask } from "@multica/core/types";
import type { TaskMessagePayload } from "@multica/core/types/events";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";
import { renderWithI18n } from "../../test/i18n";

// The override matrix itself is canonical in
// packages/core/issues/stores/agent-process-fold-store.test.ts. What this file
// owns is the wiring: which runs get a panel, when a transcript is fetched,
// and that the live panel bounds its own height instead of growing the page.

const mockState = vi.hoisted(() => ({
  tasks: [] as unknown[],
}));

vi.mock("@multica/core/api", () => ({
  api: {
    listTaskMessages: vi.fn(),
  },
}));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: (_type: string, id: string) =>
      ({ "agent-1": "Walt", "agent-2": "Gus" })[id] ?? "",
    getActorInitials: () => "WA",
    getActorAvatarUrl: () => null,
  }),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-query")>(
      "@tanstack/react-query",
    );
  return {
    ...actual,
    useQuery: (opts: { queryKey?: readonly unknown[] }) => {
      // issueKeys.tasks(issueId) === ["issues","tasks",id]
      if (opts.queryKey?.[0] === "issues" && opts.queryKey?.[1] === "tasks") {
        return { data: mockState.tasks };
      }
      return actual.useQuery(opts as Parameters<typeof actual.useQuery>[0]);
    },
  };
});

import { IssueAgentProcessFold, IssueLiveAgentProcess } from "./issue-agent-process";

const listTaskMessages = vi.mocked(api.listTaskMessages);

const TASK_ID = "4a2e8d1c-7f9b-4e2a-9c1d-123456789abc";
const OTHER_TASK_ID = "5b3f9e2d-8a0c-4f3b-ad2e-23456789abcd";

function msg(seq: number, tool = `Tool${seq}`): TaskMessagePayload {
  return {
    task_id: TASK_ID,
    issue_id: "issue-1",
    seq,
    type: "tool_use",
    tool,
    input: { file_path: `/repo/src/file-${seq}.ts` },
  };
}

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: TASK_ID,
    agent_id: "agent-1",
    runtime_id: "runtime-1",
    issue_id: "issue-1",
    status: "running",
    priority: 0,
    dispatched_at: null,
    started_at: "2026-09-10T08:00:00Z",
    completed_at: null,
    result: null,
    error: null,
    created_at: "2026-09-10T08:00:00Z",
    ...overrides,
  };
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

const navAdapter: NavigationAdapter = {
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  pathname: "/acme/issues/issue-1",
  searchParams: new URLSearchParams(),
  hash: "",
  getShareableUrl: (p) => p,
};

// ActorAvatar links each agent to its profile, which needs both a
// workspace-scoped route and the navigation adapter.
function wrap(ui: React.ReactNode, qc: QueryClient) {
  return (
    <WorkspaceSlugProvider slug="acme">
      <NavigationProvider value={navAdapter}>
        <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
      </NavigationProvider>
    </WorkspaceSlugProvider>
  );
}

function renderLive(qc: QueryClient) {
  return renderWithI18n(wrap(<IssueLiveAgentProcess issueId="issue-1" />, qc));
}

function renderFold(qc: QueryClient, taskId = TASK_ID) {
  return renderWithI18n(wrap(<IssueAgentProcessFold taskId={taskId} />, qc));
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockState.tasks = [];
  useAgentProcessFoldStore.setState({ overrides: new Map() });
  listTaskMessages.mockReset();
  listTaskMessages.mockResolvedValue([]);
});

describe("IssueLiveAgentProcess", () => {
  it("renders nothing when no run is in flight", () => {
    mockState.tasks = [
      makeTask({ status: "completed", completed_at: "2026-09-10T08:05:00Z" }),
    ];

    const { container } = renderLive(newClient());

    expect(container).toBeEmptyDOMElement();
  });

  it("streams the running agent's process, expanded, without a click", async () => {
    const qc = newClient();
    qc.setQueryData(chatKeys.taskMessages(TASK_ID), [msg(1, "Read"), msg(2, "Bash")]);
    listTaskMessages.mockResolvedValue([msg(1, "Read"), msg(2, "Bash")]);
    mockState.tasks = [makeTask({ trigger_summary: "Fix the login bug" })];

    renderLive(qc);

    // The point of the whole feature: an untouched issue page shows what the
    // agent is doing, not just that something is happening.
    expect(screen.getByText("Walt")).toBeInTheDocument();
    expect(screen.getByText("Working")).toBeInTheDocument();
    expect(screen.getByText("Fix the login bug")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("Read")).toBeInTheDocument();
    });
    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText("2 steps")).toBeInTheDocument();
  });

  it("bounds and scrolls the live process instead of growing the page", async () => {
    const qc = newClient();
    qc.setQueryData(chatKeys.taskMessages(TASK_ID), [msg(1, "Read")]);
    mockState.tasks = [makeTask({})];

    renderLive(qc);

    // The comment timeline above this panel is virtualized. An unbounded panel
    // would force it to re-measure on every 500ms daemon flush.
    const box = await screen.findByText("Read");
    const scroller = box.closest("[data-slot='collapsible-content'] > div");
    expect(scroller).not.toBeNull();
    expect(scroller).toHaveClass("overflow-y-auto");
    expect((scroller as HTMLElement).style.maxHeight).toBe("22rem");
  });

  it("shows a queued run without pretending it has produced output", () => {
    mockState.tasks = [makeTask({ status: "queued", started_at: null })];

    renderLive(newClient());

    expect(screen.getByText("Queued")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(listTaskMessages).not.toHaveBeenCalled();
  });

  it("names an unknown agent rather than rendering a blank row", () => {
    mockState.tasks = [makeTask({ agent_id: "agent-missing" })];

    renderLive(newClient());

    expect(screen.getByText("Agent")).toBeInTheDocument();
  });

  it("gives every in-flight run its own card", () => {
    mockState.tasks = [
      makeTask({ id: TASK_ID, agent_id: "agent-1", status: "queued" }),
      makeTask({ id: OTHER_TASK_ID, agent_id: "agent-2", status: "queued" }),
    ];

    renderLive(newClient());

    expect(screen.getByText("Walt")).toBeInTheDocument();
    expect(screen.getByText("Gus")).toBeInTheDocument();
  });
});

describe("IssueAgentProcessFold", () => {
  it("stays collapsed and fetches nothing until the reader opens it", () => {
    renderFold(newClient());

    expect(screen.getByRole("button", { name: "View process" })).toBeInTheDocument();
    expect(screen.queryByText("Read")).not.toBeInTheDocument();
    // An issue with 40 agent comments must not fire 40 transcript requests.
    expect(listTaskMessages).not.toHaveBeenCalled();
  });

  it("fetches once on open and shows the run's steps", async () => {
    listTaskMessages.mockResolvedValue([msg(1, "Read"), msg(2, "Edit")]);

    renderFold(newClient());
    fireEvent.click(screen.getByRole("button", { name: "View process" }));

    await waitFor(() => {
      expect(screen.getByText("Read")).toBeInTheDocument();
    });
    expect(screen.getByText("Edit")).toBeInTheDocument();
    expect(screen.getByText("2 steps")).toBeInTheDocument();
    expect(listTaskMessages).toHaveBeenCalledTimes(1);
    expect(listTaskMessages).toHaveBeenCalledWith(TASK_ID);
  });

  it("remembers the reader's choice across an unmount", async () => {
    listTaskMessages.mockResolvedValue([msg(1, "Read")]);
    const qc = newClient();

    const first = renderFold(qc);
    fireEvent.click(screen.getByRole("button", { name: "View process" }));
    await waitFor(() => {
      expect(screen.getByText("Read")).toBeInTheDocument();
    });

    // react-virtuoso unmounts a comment the moment it scrolls out of view;
    // component state would forget the fold was open by the time it came back.
    first.unmount();
    renderFold(qc);

    expect(screen.getByText("Read")).toBeInTheDocument();
  });

  it("says a run recorded nothing instead of vanishing when clicked", async () => {
    listTaskMessages.mockResolvedValue([]);

    renderFold(newClient());
    fireEvent.click(screen.getByRole("button", { name: "View process" }));

    await waitFor(() => {
      expect(
        screen.getByText("No process was recorded for this run."),
      ).toBeInTheDocument();
    });
    // The trigger is still there — a control that disappears on click reads as
    // a broken one.
    expect(screen.getByRole("button", { name: "View process" })).toBeInTheDocument();
  });

  it("uses the Chinese process copy", () => {
    renderWithI18n(wrap(<IssueAgentProcessFold taskId={TASK_ID} />, newClient()), {
      locale: "zh-Hans",
    });

    expect(screen.getByRole("button", { name: "查看运行过程" })).toBeInTheDocument();
  });
});
