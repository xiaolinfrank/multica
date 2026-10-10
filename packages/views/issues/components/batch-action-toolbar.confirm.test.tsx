import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { buildIssueStatusCatalog } from "@multica/core/issue-statuses";
import type { Issue, IssueBatchReceipt, UpdateIssueRequest } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { issueOperationFixture } from "../operation-basis-test-fixture";
import { BatchActionToolbar } from "./batch-action-toolbar";

// MUL-4155: batch status changes must apply directly (no run-confirm modal),
// while agent/squad assignment still confirms and delete still confirms. These
// tests drive the pickers' onUpdate callbacks and assert which path is taken.
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ issueDetail: (id: string) => `/ws/issues/${id}` }) }));
vi.mock("../../navigation", () => ({ AppLink: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a> }));
vi.mock("@multica/core/issue-statuses/hooks", () => ({ useIssueStatuses: () => buildIssueStatusCatalog(undefined) }));
vi.mock("@multica/core/issues", async (original) => ({
  ...await original<typeof import("@multica/core/issues")>(),
  useIssueOperationBasis: (_wsId: string, ids: string[]) => ({
    byIssue: new Map(ids.map((id) => [id, issueOperationFixture(id)])),
    pendingIds: new Set(), errorIds: new Set(), isPending: false, isError: false, refetch: vi.fn(),
  }),
}));

function render(issues: Issue[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return renderWithI18n(<QueryClientProvider client={client}><BatchActionToolbar issues={issues} /></QueryClientProvider>);
}

function receipt(ids: string[]): IssueBatchReceipt {
  return { workspace_id: "ws-1", requested_ids: ids, transaction_mode: "per_item", transaction_outcome: "committed",
    results: ids.map((id) => ({ issue_id: id, outcome: "applied", revision: 2, changed: true })), unconfirmed_ids: [], updated: ids.length };
}

const selection = vi.hoisted(() => ({
  selectedIds: new Set<string>(),
  clear: vi.fn(),
  toggle: vi.fn(),
  select: vi.fn(),
  deselect: vi.fn(),
}));
vi.mock("@multica/core/issues/stores/selection-store", () => ({
  useIssueSelectionStore: (selector: (s: typeof selection) => unknown) => selector(selection),
}));

const batchUpdate = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const batchDelete = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@multica/core/issues/mutations", () => ({
  useBatchUpdateIssues: () => ({ mutateAsync: batchUpdate, isPending: false }),
  useBatchDeleteIssues: () => ({ mutateAsync: batchDelete, isPending: false }),
}));

const openModal = vi.hoisted(() => vi.fn());
vi.mock("@multica/core/modals", () => ({
  useModalStore: (selector: (s: { open: typeof openModal }) => unknown) => selector({ open: openModal }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Interactive picker stubs: each renders buttons that fire the real onUpdate the
// toolbar passes in, so we exercise handleBatchStatus / handleBatchAssignee.
const ACTIVE_STATUSES = ["todo", "in_progress", "in_review", "blocked"] as const;
const TERMINAL_STATUSES = ["done", "cancelled"] as const;
vi.mock("./pickers", () => ({
  StatusPicker: ({ onUpdate }: { onUpdate: (u: Partial<UpdateIssueRequest>) => void }) => (
    <div>
      {[...ACTIVE_STATUSES, ...TERMINAL_STATUSES, "backlog"].map((s) => (
        <button
          key={s}
          data-testid={`status-${s}`}
          onClick={() => onUpdate({ status: s as UpdateIssueRequest["status"] })}
        />
      ))}
    </div>
  ),
  PriorityPicker: () => <div data-testid="priority-picker" />,
  AssigneePicker: ({ onUpdate }: { onUpdate: (u: Partial<UpdateIssueRequest>) => void }) => (
    <div>
      <button
        data-testid="assign-agent"
        onClick={() => onUpdate({ assignee_type: "agent", assignee_id: "agent-1" })}
      />
      <button
        data-testid="assign-member"
        onClick={() => onUpdate({ assignee_type: "member", assignee_id: "user-1" })}
      />
    </div>
  ),
}));

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "a",
    workspace_id: "ws-1",
    number: 1,
    identifier: "MUL-1",
    title: "Issue",
    description: null,
    status: "todo",
    priority: "none",
    assignee_type: null,
    assignee_id: null,
    creator_type: "member",
    creator_id: "user-1",
    parent_issue_id: null,
    project_id: null,
    position: 1,
    stage: null,
    start_date: null,
    due_date: null,
    metadata: {},
    properties: {},
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  selection.selectedIds = new Set(["a"]);
  selection.deselect.mockClear();
  batchUpdate.mockReset().mockImplementation(async ({ ids }: { ids: string[] }) => receipt(ids));
  batchDelete.mockClear();
  openModal.mockClear();
});

describe("BatchActionToolbar status routing (MUL-4155)", () => {
  it("applies every allowed status target directly, never opening the run-confirm modal", async () => {
    for (const status of [...ACTIVE_STATUSES, ...TERMINAL_STATUSES, "backlog"]) {
      batchUpdate.mockClear();
      openModal.mockClear();
      // A backlog issue in the selection is the case that historically could
      // start a run — it still must not pop the confirm modal now.
      const { unmount } = render([makeIssue({ status: "backlog" })]);
      fireEvent.click(screen.getByTestId(`status-${status}`));
      expect(openModal).not.toHaveBeenCalled();
      expect(batchUpdate).toHaveBeenCalledWith({ ids: ["a"], updates: { status }, expected_revisions: { a: 1 } });
      await waitFor(() => expect(selection.deselect).toHaveBeenCalledWith(["a"]));
      selection.deselect.mockClear();
      unmount();
    }
  });

  it("still routes agent assignment through the run-confirm modal", () => {
    render([makeIssue({ status: "todo" })]);
    fireEvent.click(screen.getByTestId("assign-agent"));
    expect(openModal).toHaveBeenCalledWith(
      "issue-run-confirm",
      expect.objectContaining({ issueIds: ["a"], mode: "assign", assigneeType: "agent", assigneeId: "agent-1", expectedRevisions: { a: 1 }, onBatchResult: expect.any(Function) }),
    );
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it("applies member assignment directly (never starts a run)", async () => {
    render([makeIssue({ status: "todo" })]);
    fireEvent.click(screen.getByTestId("assign-member"));
    expect(openModal).not.toHaveBeenCalled();
    expect(batchUpdate).toHaveBeenCalledWith({
      ids: ["a"],
      updates: { assignee_type: "member", assignee_id: "user-1" },
      expected_revisions: { a: 1 },
    });
    await waitFor(() => expect(selection.deselect).toHaveBeenCalledWith(["a"]));
  });

  it("opens the dedicated delete confirmation, not the run-confirm modal", () => {
    render([makeIssue({ status: "todo" })]);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("dialog", { name: "Review selected issues" })).toBeInTheDocument();
    expect(openModal).not.toHaveBeenCalled();
    expect(batchDelete).not.toHaveBeenCalled();
  });
});
