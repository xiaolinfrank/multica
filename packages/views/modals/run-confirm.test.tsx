import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { buildIssueStatusCatalog } from "@multica/core/issue-statuses";
import {
  configureShortcutPlatform,
  createShortcutChord,
  useShortcutStore,
} from "@multica/core/shortcuts";
import { RunConfirmModal } from "./run-confirm";
import { ApiError } from "@multica/core/api";
import type { IssueBatchReceipt, IssueOperationBasis } from "@multica/core/types";
import { issueOperationFixture } from "../issues/operation-basis-test-fixture";

const policyState = vi.hoisted(() => ({
  wsId: "ws-test", overrides: new Map<string, Partial<IssueOperationBasis>>(),
  pending: new Set<string>(), errors: new Set<string>(), read: vi.fn(), refetch: vi.fn(), summary: vi.fn(),
}));
vi.mock("@multica/core/issues", async (original) => ({
  ...await original<typeof import("@multica/core/issues")>(),
  useIssueOperationBasis: (wsId: string, ids: string[]) => {
    policyState.read(wsId, ids);
    return {
      byIssue: new Map(ids.filter((id) => !policyState.pending.has(id) && !policyState.errors.has(id)).map((id) => [id, issueOperationFixture(id, policyState.overrides.get(id))])),
      pendingIds: policyState.pending, errorIds: policyState.errors,
      isPending: policyState.pending.size > 0, isError: policyState.errors.size > 0, refetch: policyState.refetch,
    };
  },
}));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ issueDetail: (id: string) => `/${policyState.wsId}/issues/${id}` }) }));
vi.mock("../navigation", () => ({ AppLink: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a> }));
vi.mock("../issues/components/issue-operation-restriction", () => ({
  IssueOperationRestriction: ({ operation, observation }: { operation: string; observation: { basis?: IssueOperationBasis; pending: boolean; error: boolean } }) =>
    <p role="note" aria-label={`${operation} restriction`}>{observation.basis?.issue_id ?? (observation.pending ? "Checking" : "Unavailable")}</p>,
}));
vi.mock("../issues/components/issue-batch-outcome-summary", () => ({
  IssueBatchOutcomeSummary: (props: { wsId: string; submittedIds: string[]; receipt: IssueBatchReceipt | null; operation: string }) => {
    policyState.summary(props);
    return <section aria-label="Batch result">{props.receipt?.transaction_outcome ?? "unknown"}</section>;
  },
}));

function receipt(ids: string[], overrides: Partial<IssueBatchReceipt> = {}): IssueBatchReceipt {
  return { workspace_id: policyState.wsId, requested_ids: ids, transaction_mode: "per_item", transaction_outcome: "committed",
    results: ids.map((id) => ({ issue_id: id, outcome: "applied", revision: (policyState.overrides.get(id)?.issue_revision ?? 1) + 1, changed: true })), unconfirmed_ids: [], updated: ids.length, ...overrides };
}

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => policyState.wsId }));
vi.mock("@multica/core/issue-statuses/hooks", () => ({
  useIssueStatuses: () =>
    buildIssueStatusCatalog([
      {
        id: "rework",
        workspace_id: "ws-test",
        key: "rework",
        name: "Rework",
        description: "",
        category: "unstarted",
        color: "#22c55e",
        is_system: false,
        position: 0,
        archived_at: null,
        created_at: "",
        updated_at: "",
      },
    ]),
}));

const mockUpdate = vi.fn().mockResolvedValue({ id: "issue-1" });
const mockBatch = vi.fn();
vi.mock("@multica/core/issues/mutations", async (original) => ({
  ...await original<typeof import("@multica/core/issues/mutations")>(),
  useUpdateIssue: () => ({ mutateAsync: mockUpdate }),
  useBatchUpdateIssues: () => ({ mutateAsync: mockBatch }),
}));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: () => "Walt" }),
}));

vi.mock("../i18n", () => ({
  useT: () => ({
    t: (
      sel: (x: Record<string, Record<string, string>>) => string,
      vars?: Record<string, unknown>,
    ) => {
      // Resolve the accessor against a flat label map so assertions can target
      // text, then interpolate {{name}} / {{count}} the way i18next would — the
      // headline substitutes the assignee name and the batch count.
      const labels = {
        run_confirm: {
          title_assign: "Confirm assignment?",
          assign_single: "assign to {{name}}",
          assign_batch: "assign {{count}} to {{name}}",
          confirm_assign: "Confirm assignment",
          dont_start: "Don't start yet",
          toast_failed: "failed",
          title_promote: "Start work now?",
          promote_single: "move to {{status}}, {{name}} starts",
          confirm_promote: "Move and start",
        },
        // useStatusLabel resolves BUILT-IN keys through i18n and custom ones
        // through the catalog, so the promote headline needs both sources.
        status: { todo: "Todo" },
        revision: { conflict: "Revision changed" },
        operation_basis: { dismiss: "Close", batch_counts: "{{allowed}} allowed, {{blocked}} blocked of {{total}}", open_record: "Open issue", new_tab: "(new tab)" },
      };
      return sel(labels).replace(/\{\{(\w+)\}\}/g, (_m, k) => String(vars?.[k] ?? ""));
    },
  }),
}));

// Keep the ui primitives as light DOM so the logic is what's under test.
vi.mock("@multica/ui/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  // Keeps the real Popup's prop passthrough, which the send chord binds to.
  DialogContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div data-testid="dialog-content" {...props}>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@multica/ui/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("@multica/ui/components/ui/spinner", () => ({
  Spinner: () => <span data-testid="spinner" />,
}));
// vi.hoisted: vi.mock factories run before module-level consts initialize.
// Only error is used now — completion is silent (no result toast).
const mockToast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: mockToast }));

beforeEach(() => {
  mockUpdate.mockClear().mockResolvedValue({ id: "issue-1" });
  mockBatch.mockReset().mockImplementation(async ({ ids }: { ids: string[] }) => receipt(ids));
  policyState.wsId = "ws-test"; policyState.overrides.clear(); policyState.pending.clear(); policyState.errors.clear();
  policyState.read.mockClear(); policyState.refetch.mockReset().mockResolvedValue([]); policyState.summary.mockClear();
  mockToast.error.mockClear();
  mockToast.success.mockClear();
  // The real shortcut store drives both the submit chord and the keycap hint,
  // and jsdom's platform follows the host OS — pin it so the chord is ⌘+Enter
  // everywhere, not Ctrl+Enter on a Linux CI runner.
  configureShortcutPlatform("macos");
  useShortcutStore.setState({ overrides: {} });
});

afterEach(() => {
  configureShortcutPlatform(null);
  useShortcutStore.setState({ overrides: {} });
});

const confirmButton = () => screen.getByRole("button", { name: "Confirm assignment" });
const dialog = () => screen.getByTestId("dialog-content");

const single = {
  issueIds: ["issue-1"],
  mode: "assign" as const,
  assigneeType: "agent" as const,
  assigneeId: "agent-1",
};

// Promoting a parked issue out of backlog starts the run on its own, so it
// confirms through this same dialog — one behaviour for built-in `todo` and
// every custom Todo-category status alike (MUL-6463).
const promote = {
  issueIds: ["issue-1"],
  mode: "promote" as const,
  status: "rework",
  assigneeType: "agent" as const,
  assigneeId: "agent-1",
};

describe("RunConfirmModal", () => {
  it("shows confirmed allowed operation facts on the first frame without a run preview or spinner", () => {
    // An already confirmed basis does not require a separate run prediction.
    const { container } = render(<RunConfirmModal onClose={vi.fn()} data={single} />);
    expect(screen.queryByTestId("spinner")).not.toBeInTheDocument();
    expect(confirmButton()).not.toBeDisabled();
    // Headline reads across elements — the assignee name is bolded in place.
    expect(container.textContent).toContain("assign to Walt");
  });

  it("single assign sends the assignee change and nothing else", async () => {
    render(<RunConfirmModal onClose={vi.fn()} data={single} />);
    fireEvent.click(confirmButton());
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate).toHaveBeenCalledWith({
      id: "issue-1",
      expected_revision: 1,
      assignee_type: "agent",
      assignee_id: "agent-1",
    });
    expect(mockBatch).not.toHaveBeenCalled();
  });

  it("completes silently on success — closes with no result toast", async () => {
    // Final scope: the dialog only confirms the assignment. The assignee and any
    // run surface through the issue's normal updates, so submit adds no toast.
    const onClose = vi.fn();
    render(<RunConfirmModal onClose={onClose} data={single} />);
    fireEvent.click(confirmButton());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mockToast.success).not.toHaveBeenCalled();
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it("'暂不开始' sends suppress_run alongside the assignee change", async () => {
    render(<RunConfirmModal onClose={vi.fn()} data={single} />);
    fireEvent.click(screen.getByText("Don't start yet"));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate).toHaveBeenCalledWith({
      id: "issue-1",
      expected_revision: 1,
      assignee_type: "agent",
      assignee_id: "agent-1",
      suppress_run: true,
    });
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it("promote sends the status change with no assignee fields", async () => {
    // The owner is already on the issue: re-sending it would turn a status
    // write into an assignee write on the server's side of the predicate.
    render(<RunConfirmModal onClose={vi.fn()} data={promote} />);
    fireEvent.click(screen.getByRole("button", { name: "Move and start" }));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate).toHaveBeenCalledWith({
      id: "issue-1",
      expected_revision: 1,
      status: "rework",
    });
  });

  it("promote's 'don't start yet' still moves the issue, without the run", async () => {
    // The status change is the point; suppress_run is the only difference. This
    // is the one way to leave backlog WITHOUT waking the agent.
    render(<RunConfirmModal onClose={vi.fn()} data={promote} />);
    fireEvent.click(screen.getByText("Don't start yet"));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate).toHaveBeenCalledWith({
      id: "issue-1",
      expected_revision: 1,
      status: "rework",
      suppress_run: true,
    });
  });

  it("promote names the target status the way the workspace named it", () => {
    // A custom status is only recognisable by its catalog name; built-ins keep
    // resolving through i18n so a zh workspace never reads "In Progress".
    const { container, rerender } = render(<RunConfirmModal onClose={vi.fn()} data={promote} />);
    expect(screen.getByText("Start work now?")).toBeInTheDocument();
    expect(container.textContent).toContain("move to Rework, Walt starts");

    rerender(<RunConfirmModal onClose={vi.fn()} data={{ ...promote, status: "todo" }} />);
    expect(container.textContent).toContain("move to Todo, Walt starts");
  });

  it("batch assign (N ids) applies via batchUpdate", async () => {
    const { container } = render(
      <RunConfirmModal onClose={vi.fn()} data={{ ...single, issueIds: ["i1", "i2"] }} />,
    );
    expect(container.textContent).toContain("assign 2 to Walt");
    fireEvent.click(confirmButton());
    await waitFor(() => expect(mockBatch).toHaveBeenCalledTimes(1));
    expect(mockBatch).toHaveBeenCalledWith({
      ids: ["i1", "i2"],
      expected_revisions: { i1: 1, i2: 1 },
      updates: { assignee_type: "agent", assignee_id: "agent-1" },
    });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  // --- Send chord (MUL-5694) ------------------------------------------------
  // The chord is bound on the dialog, not on a single control, so it confirms
  // wherever focus happens to be.

  it("confirms on the send chord typed anywhere in the dialog", async () => {
    const onClose = vi.fn();
    render(<RunConfirmModal onClose={onClose} data={single} />);
    fireEvent.keyDown(dialog(), { key: "Enter", metaKey: true });
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate).toHaveBeenCalledWith({
      id: "issue-1",
      expected_revision: 1,
      assignee_type: "agent",
      assignee_id: "agent-1",
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("confirms from a focused footer button, which the chord cannot activate", async () => {
    // Chromium fires no click for ⌘/Ctrl+Enter on a focused button, so without
    // the dialog handling it there the chord is simply dead. The dialog focuses
    // its first tabbable child, which is now a footer button.
    render(<RunConfirmModal onClose={vi.fn()} data={single} />);
    fireEvent.keyDown(screen.getByText("Don't start yet"), { key: "Enter", metaKey: true });
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    // The primary action, not the button the caret happened to sit on.
    expect(mockUpdate.mock.calls[0]![0].suppress_run).toBeUndefined();
  });

  it("yields to a focused button when send is remapped to plain Enter", () => {
    // A bare Enter DOES activate a focused button, so confirming here as well
    // would double-write — and on "Don't start yet" the two would disagree.
    useShortcutStore.setState({ overrides: { send: createShortcutChord("Enter") } });
    render(<RunConfirmModal onClose={vi.fn()} data={single} />);
    fireEvent.keyDown(screen.getByText("Don't start yet"), { key: "Enter" });
    fireEvent.keyDown(confirmButton(), { key: "Enter" });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("submits once for a held chord, and never for an IME's committing Enter", async () => {
    render(<RunConfirmModal onClose={vi.fn()} data={single} />);
    fireEvent.keyDown(dialog(), { key: "Enter", metaKey: true, isComposing: true });
    fireEvent.keyDown(dialog(), { key: "Enter", metaKey: true, repeat: true });
    expect(mockUpdate).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog(), { key: "Enter", metaKey: true });
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
  });

  it("follows a remapped send chord instead of hardcoding ⌘+Enter", async () => {
    useShortcutStore.setState({ overrides: { send: createShortcutChord("Enter") } });
    render(<RunConfirmModal onClose={vi.fn()} data={single} />);
    fireEvent.keyDown(dialog(), { key: "Enter", metaKey: true });
    expect(mockUpdate).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog(), { key: "Enter" });
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
  });

  it("shows the chord on the confirm button without renaming it", () => {
    render(<RunConfirmModal onClose={vi.fn()} data={single} />);
    // Decorative: discoverable next to the label, absent from the a11y name —
    // `confirmButton()` resolving by that exact name is the assertion.
    expect(
      confirmButton().querySelector('[data-slot="shortcut-keycaps"]'),
    ).toBeInTheDocument();
  });

  it("keeps the dialog open and surfaces the error when the write fails", async () => {
    const onClose = vi.fn();
    mockUpdate.mockRejectedValue(new Error("boom"));
    render(<RunConfirmModal onClose={onClose} data={single} />);
    fireEvent.click(confirmButton());
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("boom"));
    expect(onClose).not.toHaveBeenCalled();
    expect(mockToast.success).not.toHaveBeenCalled();
  });
});


describe("RunConfirmModal operation basis and receipts", () => {
  it("waits for every selected issue and exposes a blocked assignment without writing a subset", () => {
    const data = { ...single, issueIds: ["i1", "i2"] };
    policyState.pending.add("i2");
    const view = render(<RunConfirmModal onClose={vi.fn()} data={data} />);
    expect(policyState.read).toHaveBeenCalledWith("ws-test", ["i1", "i2"]);
    expect(confirmButton()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Don't start yet" })).toBeDisabled();
    expect(screen.getByRole("note", { name: "assignee restriction" })).toHaveTextContent("Checking");
    policyState.pending.clear();
    policyState.overrides.set("i2", { assignee: { state: "blocked", reason_codes: ["formal_review_required"] } });
    view.rerender(<RunConfirmModal onClose={vi.fn()} data={data} />);
    expect(screen.getByRole("note", { name: "assignee restriction" })).toHaveTextContent("i2");
    fireEvent.click(confirmButton()); fireEvent.keyDown(dialog(), { key: "Enter", metaKey: true });
    expect(mockUpdate).not.toHaveBeenCalled(); expect(mockBatch).not.toHaveBeenCalled();
  });

  it("permits assignment with Suppress when execution is blocked, without bypassing field policy", async () => {
    policyState.overrides.set("issue-1", { execution: { state: "blocked", reason_codes: ["meeting_not_released"] } });
    render(<RunConfirmModal onClose={vi.fn()} data={single} />);
    expect(confirmButton()).toBeDisabled();
    expect(screen.getByRole("note", { name: "execution restriction" })).toHaveTextContent("issue-1");
    fireEvent.keyDown(dialog(), { key: "Enter", metaKey: true }); expect(mockUpdate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Don't start yet" }));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith({ id: "issue-1", expected_revision: 1, assignee_type: "agent", assignee_id: "agent-1", suppress_run: true }));
  });

  it("keeps a captured single revision instead of silently adopting a changed issue", () => {
    policyState.overrides.set("issue-1", { issue_revision: 8 });
    render(<RunConfirmModal onClose={vi.fn()} data={{ ...single, issueRevision: 7 }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Revision changed");
    expect(screen.getByRole("link", { name: "Open issue (new tab)" })).toHaveAttribute("href", "/ws-test/issues/issue-1");
    expect(confirmButton()).toBeDisabled(); expect(screen.getByRole("button", { name: "Don't start yet" })).toBeDisabled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("passes captured batch revisions and the exact confirmed receipt to the selection owner", async () => {
    policyState.overrides.set("i1", { issue_revision: 11 }); policyState.overrides.set("i2", { issue_revision: 13 });
    const onClose = vi.fn(), onBatchResult = vi.fn(), confirmed = receipt(["i1", "i2"]);
    mockBatch.mockResolvedValue(confirmed);
    render(<RunConfirmModal onClose={onClose} data={{ ...single, issueIds: ["i1", "i2"], expectedRevisions: { i1: 11, i2: 13 }, onBatchResult }} />);
    fireEvent.click(confirmButton());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(mockBatch).toHaveBeenCalledWith({ ids: ["i1", "i2"], updates: { assignee_type: "agent", assignee_id: "agent-1" }, expected_revisions: { i1: 11, i2: 13 } });
    expect(onBatchResult).toHaveBeenCalledExactlyOnceWith(confirmed, ["i1", "i2"]);
  });

  it("keeps a partial receipt visible and never replays the remaining selection in the same dialog", async () => {
    const onClose = vi.fn(), onBatchResult = vi.fn();
    const partial = receipt(["i1", "i2"], { transaction_outcome: "partial", updated: 1, results: [{ issue_id: "i1", outcome: "applied", revision: 2, changed: true }, { issue_id: "i2", outcome: "rejected", code: "formal_review_required" }] });
    mockBatch.mockRejectedValue(new ApiError("Review required", 409, "Conflict", partial));
    render(<RunConfirmModal onClose={onClose} data={{ ...single, issueIds: ["i1", "i2"], onBatchResult }} />);
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.getByRole("region", { name: "Batch result" })).toHaveTextContent("partial"));
    expect(policyState.summary).toHaveBeenLastCalledWith(expect.objectContaining({ wsId: "ws-test", submittedIds: ["i1", "i2"], receipt: partial, operation: "assignee" }));
    expect(onBatchResult).toHaveBeenCalledExactlyOnceWith(partial, ["i1", "i2"]);
    expect(onClose).not.toHaveBeenCalled(); expect(confirmButton()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Don't start yet" })).toBeDisabled();
    fireEvent.keyDown(dialog(), { key: "Enter", metaKey: true }); expect(mockBatch).toHaveBeenCalledTimes(1);
    expect(policyState.refetch).toHaveBeenCalledTimes(1);
  });

  it("preserves an unknown result for inspection without clearing selection or replaying", async () => {
    const onClose = vi.fn(), onBatchResult = vi.fn(); mockBatch.mockRejectedValue(new Error("Connection lost after send"));
    render(<RunConfirmModal onClose={onClose} data={{ ...single, issueIds: ["i1", "i2"], onBatchResult }} />);
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.getByRole("region", { name: "Batch result" })).toHaveTextContent("unknown"));
    expect(onBatchResult).toHaveBeenCalledExactlyOnceWith(null, ["i1", "i2"]);
    expect(onClose).not.toHaveBeenCalled(); expect(confirmButton()).toBeDisabled();
    fireEvent.keyDown(dialog(), { key: "Enter", metaKey: true }); expect(mockBatch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
  });

  it.each(["intent", "workspace", "instance"] as const)("ignores a late batch result after the %s changes", async (transition) => {
    let finish!: (value: IssueBatchReceipt) => void;
    const confirmed = receipt(["i1", "i2"]), oldClose = vi.fn(), newClose = vi.fn(), oldResult = vi.fn(), newResult = vi.fn();
    mockBatch.mockReturnValueOnce(new Promise<IssueBatchReceipt>((resolve) => { finish = resolve; }));
    const data = { ...single, issueIds: ["i1", "i2"], onBatchResult: oldResult };
    const view = render(<RunConfirmModal onClose={oldClose} data={data} />);
    fireEvent.click(confirmButton()); await waitFor(() => expect(mockBatch).toHaveBeenCalledTimes(1));
    const next = { ...data, onBatchResult: newResult, ...(transition === "intent" ? { assigneeId: "agent-2" } : {}) };
    if (transition === "workspace") policyState.wsId = "ws-next";
    if (transition === "instance") { view.unmount(); render(<RunConfirmModal onClose={newClose} data={next} />); }
    else view.rerender(<RunConfirmModal onClose={newClose} data={next} />);
    await act(async () => { finish(confirmed); });
    expect(oldClose).not.toHaveBeenCalled(); expect(newClose).not.toHaveBeenCalled();
    expect(oldResult).not.toHaveBeenCalled(); expect(newResult).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Batch result" })).not.toBeInTheDocument();
    expect(confirmButton()).toBeEnabled();
  });

  it("does not revive an old completion after leaving and returning to the same intent", async () => {
    let finish!: (value: IssueBatchReceipt) => void;
    const confirmed = receipt(["i1", "i2"]), oldClose = vi.fn(), newClose = vi.fn(), oldResult = vi.fn(), newResult = vi.fn();
    mockBatch.mockReturnValueOnce(new Promise<IssueBatchReceipt>((resolve) => { finish = resolve; }));
    const data = { ...single, issueIds: ["i1", "i2"], onBatchResult: oldResult };
    const view = render(<RunConfirmModal onClose={oldClose} data={data} />);
    fireEvent.click(confirmButton());
    view.rerender(<RunConfirmModal onClose={newClose} data={{ ...data, assigneeId: "agent-2", onBatchResult: newResult }} />);
    view.rerender(<RunConfirmModal onClose={newClose} data={{ ...data, onBatchResult: newResult }} />);
    await act(async () => { finish(confirmed); });
    expect(oldClose).not.toHaveBeenCalled(); expect(newClose).not.toHaveBeenCalled();
    expect(oldResult).not.toHaveBeenCalled(); expect(newResult).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Batch result" })).not.toBeInTheDocument();
  });
});
