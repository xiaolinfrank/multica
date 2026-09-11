import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTask } from "@multica/core/types";

// The state matrix (queued / behind / offline / working / failed / unconfirmed,
// the link grace and the reconciliation gate) is canonically covered in
// packages/core/issues/pending-creations.test.ts. This file keeps the happy
// path, the wiring, accessibility and the named regressions.

const mockState = vi.hoisted(() => ({
  snapshot: [] as unknown[],
  agents: [] as unknown[],
  userId: "user-me" as string | null,
}));

const mocks = vi.hoisted(() => ({
  cancelTaskById: vi.fn(),
  setAgent: vi.fn(),
  openModal: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

vi.mock("@multica/core/api", () => ({
  api: { cancelTaskById: mocks.cancelTaskById },
}));

vi.mock("@multica/core/auth", () => ({
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({ user: mockState.userId ? { id: mockState.userId } : null }),
}));

vi.mock("@multica/core/agents", () => ({
  agentTaskSnapshotOptions: (wsId: string) => ({
    queryKey: ["agents", "task-snapshot", wsId],
  }),
  agentTaskSnapshotKeys: { list: (wsId: string) => ["agents", "task-snapshot", wsId] },
}));

vi.mock("@multica/core/workspace/queries", () => ({
  agentListOptions: (wsId: string) => ({ queryKey: ["agents", "list", wsId] }),
}));

vi.mock("@multica/core/modals", () => ({
  useModalStore: { getState: () => ({ open: mocks.openModal }) },
}));

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ actorId }: { actorId: string }) => (
    <span data-testid="actor-avatar">{actorId}</span>
  ),
}));

vi.mock("../../i18n", () => ({
  // Return the leaf key so assertions read as behaviour, not as copy.
  useT: () => ({
    t: (selector: (r: Record<string, Record<string, string>>) => string) => {
      const proxy = new Proxy(
        {},
        {
          get: (_t, ns: string) =>
            new Proxy({}, { get: (_t2, key: string) => `${ns}.${key}` }),
        },
      ) as Record<string, Record<string, string>>;
      return selector(proxy);
    },
  }),
  useTimeAgo: () => () => "just now",
}));

vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));

vi.mock("@tanstack/react-query", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
    useQuery: (opts: { queryKey?: readonly unknown[] }) => {
      if (opts.queryKey?.[1] === "task-snapshot") return { data: mockState.snapshot };
      if (opts.queryKey?.[1] === "list") return { data: mockState.agents };
      return { data: undefined };
    },
  };
});

import { usePendingCreationStore } from "@multica/core/issues/stores";
import { useIssueDraftStore } from "@multica/core/issues/stores";
import { PendingCreationsStrip } from "./pending-creations-strip";

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task-1",
    agent_id: "agent-1",
    runtime_id: "runtime-1",
    issue_id: "",
    status: "queued",
    priority: 0,
    dispatched_at: null,
    started_at: null,
    completed_at: null,
    result: null,
    error: null,
    created_at: new Date().toISOString(),
    kind: "quick_create",
    attribution: { source: "direct_human", precise: true, originator: { id: "user-me" } },
    quick_create_prompt: "Draft the Q4 rollout plan",
    ...overrides,
  } as AgentTask;
}

beforeEach(() => {
  cleanup();
  mocks.cancelTaskById.mockReset().mockResolvedValue({});
  mocks.setAgent.mockReset();
  mocks.openModal.mockReset();
  mocks.toastError.mockReset();
  mockState.userId = "user-me";
  mockState.snapshot = [makeTask()];
  mockState.agents = [{ id: "agent-1", name: "Mika", runtime_availability: "online" }];
  usePendingCreationStore.getState().reset();
  vi.spyOn(useIssueDraftStore.getState(), "setAgent").mockImplementation(mocks.setAgent);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PendingCreationsStrip", () => {
  it("renders nothing when no creation is pending", () => {
    mockState.snapshot = [];
    const { container } = render(<PendingCreationsStrip />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the pending creation with its agent and the prompt the user typed", () => {
    render(<PendingCreationsStrip />);
    expect(screen.getByText("quick_create_pending.state_queued")).toBeTruthy();
    expect(screen.getByText("Draft the Q4 rollout plan")).toBeTruthy();
    expect(screen.getByTestId("actor-avatar").textContent).toBe("agent-1");
  });

  it("announces itself as a live region without re-announcing every second", () => {
    // The elapsed time is decorative: leaving it inside the live region would
    // make a screen reader re-read the row on every re-render.
    render(<PendingCreationsStrip />);
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByText("just now").getAttribute("aria-hidden")).toBe("true");
  });

  it("cancels the queued creation through the task id", async () => {
    const user = userEvent.setup();
    render(<PendingCreationsStrip />);
    await user.click(screen.getByRole("button", { name: "quick_create_pending.action_cancel" }));
    expect(mocks.cancelTaskById).toHaveBeenCalledWith("task-1");
    expect(screen.queryByText("Draft the Q4 rollout plan")).toBeNull();
  });

  it("keeps the row and explains itself when cancelling fails", async () => {
    mocks.cancelTaskById.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    render(<PendingCreationsStrip />);
    await user.click(screen.getByRole("button", { name: "quick_create_pending.action_cancel" }));
    expect(mocks.toastError).toHaveBeenCalled();
    expect(screen.getByText("Draft the Q4 rollout plan")).toBeTruthy();
  });

  it("reopens the modal with the prompt the server still holds", async () => {
    // Named regression: a retry that drops the prompt makes the user retype
    // text the server never lost.
    mockState.snapshot = [makeTask({ status: "failed" })];
    const user = userEvent.setup();
    render(<PendingCreationsStrip />);
    await user.click(screen.getByRole("button", { name: /action_retry/ }));
    expect(mocks.setAgent).toHaveBeenCalledWith({ prompt: "Draft the Q4 rollout plan" });
    expect(mocks.openModal).toHaveBeenCalledWith("quick-create-issue", { agent_id: "agent-1" });
  });

  it("retries a squad run as the squad, not as the leader it resolved to", async () => {
    mockState.snapshot = [makeTask({ status: "failed", squad_id: "squad-3", project_id: "proj-a" })];
    const user = userEvent.setup();
    render(<PendingCreationsStrip />);
    await user.click(screen.getByRole("button", { name: /action_retry/ }));
    expect(mocks.openModal).toHaveBeenCalledWith("quick-create-issue", {
      squad_id: "squad-3",
      project_id: "proj-a",
    });
  });

  it("sends a captured-source-context failure to the inbox instead of offering retry", () => {
    // A fresh quick-create would silently drop the capture and its cloned
    // attachments; only the source-context retry endpoint preserves them.
    mockState.snapshot = [
      makeTask({ status: "failed", quick_create_source_context_id: "ctx-7" }),
    ];
    render(<PendingCreationsStrip />);
    expect(screen.getByText("quick_create_pending.check_inbox")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /action_retry/ })).toBeNull();
  });

  it("does not offer a retry that would reopen the modal empty", () => {
    mockState.snapshot = [
      makeTask({ status: "failed", quick_create_prompt: undefined }),
    ];
    render(<PendingCreationsStrip />);
    expect(screen.queryByRole("button", { name: /action_retry/ })).toBeNull();
    expect(screen.getByText("quick_create_pending.check_inbox")).toBeTruthy();
  });

  it("keeps a dismissal across a remount of the strip", async () => {
    // Named regression: the strip's host is keyed by surface, so dismissal held
    // in component state would resurrect on every view or scope change.
    const user = userEvent.setup();
    const { unmount } = render(<PendingCreationsStrip />);
    await user.click(screen.getByRole("button", { name: "quick_create_pending.action_dismiss" }));
    expect(screen.queryByText("Draft the Q4 rollout plan")).toBeNull();
    unmount();
    const { container } = render(<PendingCreationsStrip />);
    expect(container).toBeEmptyDOMElement();
  });

  it("collapses the tail behind a control rather than growing without bound", async () => {
    mockState.snapshot = [
      makeTask({ id: "t1", created_at: "2026-09-11T12:00:03Z" }),
      makeTask({ id: "t2", created_at: "2026-09-11T12:00:02Z" }),
      makeTask({ id: "t3", created_at: "2026-09-11T12:00:01Z" }),
      makeTask({ id: "t4", created_at: "2026-09-11T12:00:00Z" }),
    ];
    const user = userEvent.setup();
    render(<PendingCreationsStrip />);
    expect(screen.getAllByTestId("actor-avatar")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: /more_count/ }));
    expect(screen.getAllByTestId("actor-avatar")).toHaveLength(4);
  });

  it("shows nobody else's pending creations", () => {
    mockState.snapshot = [
      makeTask({
        attribution: { source: "direct_human", precise: true, originator: { id: "user-other" } },
      }),
    ];
    const { container } = render(<PendingCreationsStrip />);
    expect(container).toBeEmptyDOMElement();
  });
});
