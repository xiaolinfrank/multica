// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { ApiError, setApiInstance } from "@multica/core/api";
import type { ApiClient } from "../api/client";
import { agentTaskSnapshotKeys, agentTasksKeys } from "@multica/core/agents/queries";
import { useBatchDeleteIssues, useDeleteIssue } from "@multica/core/issues/mutations";
import { issueKeys } from "@multica/core/issues/queries";
import { labelKeys } from "@multica/core/labels/queries";
import { WorkspaceSlugProvider } from "@multica/core/paths";
import { workspaceKeys } from "@multica/core/workspace/queries";
import type {
  AgentTask,
  Attachment,
  Issue,
  IssueLabelsResponse,
  IssueUsageSummary,
  IssueBatchReceipt,
  Label,
  ListIssuesCache,
  TimelineEntry,
  Workspace,
} from "@multica/core/types";

const WS_ID = "ws-1";
const SLUG = "test";
const ISSUE_ID = "issue-1";
const OTHER_ISSUE_ID = "issue-2";
const PARENT_ISSUE_ID = "parent-1";
const AGENT_ID = "agent-1";

const workspace: Workspace = {
  id: WS_ID,
  name: "Test",
  slug: SLUG,
  description: null,
  context: null,
  settings: {},
  repos: [],
  issue_prefix: "TST",
  avatar_url: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const baseIssue: Issue = {
  id: ISSUE_ID,
  workspace_id: WS_ID,
  number: 1,
  identifier: "TST-1",
  title: "Deleted issue",
  description: null,
  status: "todo",
  priority: "none",
  assignee_type: null,
  assignee_id: null,
  creator_type: "member",
  creator_id: "member-1",
  parent_issue_id: PARENT_ISSUE_ID,
  project_id: null,
  position: 0,
  stage: null,
  start_date: null,
  due_date: null,
  metadata: {},
  properties: {},
  labels: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const otherIssue: Issue = {
  ...baseIssue,
  id: OTHER_ISSUE_ID,
  number: 2,
  identifier: "TST-2",
  title: "Other issue",
  parent_issue_id: null,
};

const usage: IssueUsageSummary = {
  total_input_tokens: 10,
  total_output_tokens: 20,
  total_cache_read_tokens: 1,
  total_cache_write_tokens: 2,
  task_count: 1,
};

const attachment: Attachment = {
  id: "attachment-1",
  workspace_id: WS_ID,
  issue_id: ISSUE_ID,
  comment_id: null,
  chat_session_id: null,
  chat_message_id: null,
  uploader_type: "member",
  uploader_id: "member-1",
  filename: "evidence.png",
  url: "s3://bucket/evidence.png",
  download_url: "https://example.test/evidence.png",
  markdown_url: "https://example.test/api/attachments/attachment-1/download",
  content_type: "image/png",
  size_bytes: 1,
  created_at: "2026-01-01T00:00:00Z",
};

const timeline: TimelineEntry[] = [
  {
    type: "activity",
    id: "activity-1",
    actor_type: "member",
    actor_id: "member-1",
    action: "created",
    created_at: "2026-01-01T00:00:00Z",
  },
];

const label: Label = {
  id: "label-1",
  workspace_id: WS_ID,
  name: "bug",
  color: "#ef4444",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const issueLabels: IssueLabelsResponse = {
  labels: [label],
};

function makeListCache(...issues: Issue[]): ListIssuesCache {
  return {
    byStatus: {
      unstarted: { issues, total: issues.length },
    },
  };
}

function makeTask(issueId = ISSUE_ID): AgentTask {
  return {
    id: `task-${issueId}`,
    agent_id: AGENT_ID,
    runtime_id: "runtime-1",
    issue_id: issueId,
    status: "completed",
    priority: 0,
    dispatched_at: null,
    started_at: "2026-01-01T00:00:00Z",
    completed_at: "2026-01-01T00:01:00Z",
    result: null,
    error: null,
    created_at: "2026-01-01T00:00:00Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(
  deleteIssue = vi.fn().mockResolvedValue(undefined),
  batchDeleteIssues = vi.fn().mockResolvedValue({ deleted: 0 }),
) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  qc.setQueryData(workspaceKeys.list(), [workspace]);
  setApiInstance({
    listWorkspaces: vi.fn().mockResolvedValue([workspace]),
    deleteIssue,
    batchDeleteIssues,
  } as unknown as ApiClient);

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>
      <WorkspaceSlugProvider slug={SLUG}>{children}</WorkspaceSlugProvider>
    </QueryClientProvider>
  );

  return { qc, deleteIssue, batchDeleteIssues, wrapper };
}

function ids(cache: ListIssuesCache | undefined) {
  return cache?.byStatus.unstarted?.issues.map((issue) => issue.id);
}

function expectInvalidated(qc: QueryClient, queryKey: readonly unknown[]) {
  expect(qc.getQueryState(queryKey)?.isInvalidated).toBe(true);
}

function deletionReceipt(requested: string[], applied: string[]): IssueBatchReceipt {
  return { workspace_id: WS_ID, requested_ids: requested, transaction_mode: "atomic",
    transaction_outcome: applied.length === requested.length ? "committed" : applied.length ? "partial" : "not_started",
    deleted: applied.length, unconfirmed_ids: [], results: requested.map((issue_id) => applied.includes(issue_id)
      ? { issue_id, outcome: "applied" } : { issue_id, outcome: "rejected", code: "not_found" }) };
}

beforeEach(() => vi.clearAllMocks());

describe("confirmed issue deletion", () => {
  it("retains the visible issue and its parent until the scoped delete is confirmed", async () => {
    const pending = deferred<void>();
    const { qc, wrapper, deleteIssue } = setup(vi.fn(() => pending.promise));
    qc.setQueryData(issueKeys.list(WS_ID), makeListCache(baseIssue, otherIssue));
    qc.setQueryData(issueKeys.detail(WS_ID, ISSUE_ID), baseIssue);
    qc.setQueryData(issueKeys.children(WS_ID, PARENT_ISSUE_ID), [baseIssue, otherIssue]);
    qc.setQueryData(agentTaskSnapshotKeys.list(WS_ID), [makeTask()]);
    qc.setQueryData(agentTasksKeys.detail(WS_ID, AGENT_ID), [makeTask()]);
    const { result } = renderHook(() => useDeleteIssue(), { wrapper });
    let mutation!: Promise<void>;
    await act(async () => { mutation = result.current.mutateAsync(ISSUE_ID); await Promise.resolve(); });
    expect(deleteIssue).toHaveBeenCalledWith(WS_ID, ISSUE_ID);
    expect(ids(qc.getQueryData(issueKeys.list(WS_ID)))).toEqual([ISSUE_ID, OTHER_ISSUE_ID]);
    expect(qc.getQueryData(issueKeys.detail(WS_ID, ISSUE_ID))).toEqual(baseIssue);
    expect(qc.getQueryData(issueKeys.children(WS_ID, PARENT_ISSUE_ID))).toEqual([baseIssue, otherIssue]);
    await act(async () => { pending.resolve(); await mutation; });
    expect(ids(qc.getQueryData(issueKeys.list(WS_ID)))).toEqual([OTHER_ISSUE_ID]);
    expect(qc.getQueryData(issueKeys.detail(WS_ID, ISSUE_ID))).toBeUndefined();
    expect(qc.getQueryData(issueKeys.children(WS_ID, PARENT_ISSUE_ID))).toEqual([otherIssue]);
    expectInvalidated(qc, agentTaskSnapshotKeys.list(WS_ID));
    expectInvalidated(qc, agentTasksKeys.detail(WS_ID, AGENT_ID));
    qc.clear();
  });

  it("does not restore an old snapshot over a concurrent edit when deletion is rejected", async () => {
    const pending = deferred<void>();
    const { qc, wrapper } = setup(vi.fn(() => pending.promise));
    qc.setQueryData(issueKeys.list(WS_ID), makeListCache(baseIssue, otherIssue));
    const { result } = renderHook(() => useDeleteIssue(), { wrapper });
    let mutation!: Promise<unknown>;
    await act(async () => { mutation = result.current.mutateAsync(ISSUE_ID).catch((error) => error); await Promise.resolve(); });
    const newer = makeListCache({ ...baseIssue, title: "A teammate's newer title" }, otherIssue);
    qc.setQueryData(issueKeys.list(WS_ID), newer);
    await act(async () => { pending.reject(new Error("retained history")); await mutation; });
    expect(qc.getQueryData(issueKeys.list(WS_ID))).toEqual(newer);
    qc.clear();
  });

  it("cleans only confirmed batch deletions, retaining the other issue and its evidence", async () => {
    const selected = [ISSUE_ID, OTHER_ISSUE_ID];
    const pending = deferred<IssueBatchReceipt>();
    const { qc, wrapper, batchDeleteIssues } = setup(undefined, vi.fn(() => pending.promise));
    const myKey = issueKeys.myList(WS_ID, "assigned", { assignee_id: AGENT_ID });
    for (const key of [issueKeys.list(WS_ID), myKey]) qc.setQueryData(key, makeListCache(baseIssue, otherIssue));
    qc.setQueryData(issueKeys.children(WS_ID, PARENT_ISSUE_ID), [baseIssue, otherIssue]);
    for (const issue of [baseIssue, otherIssue]) {
      qc.setQueryData(issueKeys.detail(WS_ID, issue.id), issue);
      qc.setQueryData(issueKeys.usage(issue.id), usage);
      qc.setQueryData(issueKeys.attachments(issue.id), [attachment]);
      qc.setQueryData(issueKeys.timeline(issue.id), timeline);
      qc.setQueryData(labelKeys.byIssue(WS_ID, issue.id), issueLabels);
    }
    const { result } = renderHook(() => useBatchDeleteIssues(), { wrapper });
    let mutation!: Promise<IssueBatchReceipt>;
    await act(async () => { mutation = result.current.mutateAsync({ ids: selected }); await Promise.resolve(); });
    expect(ids(qc.getQueryData(issueKeys.list(WS_ID)))).toEqual(selected);
    await act(async () => { pending.resolve(deletionReceipt(selected, [ISSUE_ID])); await mutation; });
    expect(batchDeleteIssues).toHaveBeenCalledWith(WS_ID, selected, { expected_revisions: undefined });
    for (const key of [issueKeys.list(WS_ID), myKey]) expect(ids(qc.getQueryData(key))).toEqual([OTHER_ISSUE_ID]);
    expect(qc.getQueryData(issueKeys.detail(WS_ID, ISSUE_ID))).toBeUndefined();
    expect(qc.getQueryData(issueKeys.attachments(ISSUE_ID))).toBeUndefined();
    expect(qc.getQueryData(issueKeys.timeline(ISSUE_ID))).toBeUndefined();
    expect(qc.getQueryData(labelKeys.byIssue(WS_ID, ISSUE_ID))).toBeUndefined();
    expect(qc.getQueryData(issueKeys.detail(WS_ID, OTHER_ISSUE_ID))).toEqual(otherIssue);
    expect(qc.getQueryData(issueKeys.attachments(OTHER_ISSUE_ID))).toEqual([attachment]);
    expect(qc.getQueryData(issueKeys.timeline(OTHER_ISSUE_ID))).toEqual(timeline);
    expect(qc.getQueryData(labelKeys.byIssue(WS_ID, OTHER_ISSUE_ID))).toEqual(issueLabels);
    expect(qc.getQueryData(issueKeys.children(WS_ID, PARENT_ISSUE_ID))).toEqual([otherIssue]);
    qc.clear();
  });

  it("keeps all rows when the atomic transaction rolls back or the response is lost", async () => {
    const selected = [ISSUE_ID, OTHER_ISSUE_ID];
    const rollback = { ...deletionReceipt(selected, []), transaction_outcome: "rolled_back",
      results: selected.map((issue_id) => ({ issue_id, outcome: "not_applied", code: "batch_rolled_back" })) };
    for (const error of [new ApiError("transaction rolled back", 409, "Conflict", rollback), new Error("connection lost")]) {
      const { qc, wrapper } = setup(undefined, vi.fn().mockRejectedValue(error));
      const list = makeListCache(baseIssue, otherIssue);
      qc.setQueryData(issueKeys.list(WS_ID), list);
      const { result } = renderHook(() => useBatchDeleteIssues(), { wrapper });
      await act(async () => { await result.current.mutateAsync({ ids: selected }).catch(() => {}); });
      expect(qc.getQueryData(issueKeys.list(WS_ID))).toEqual(list);
      expectInvalidated(qc, issueKeys.list(WS_ID));
      qc.clear();
    }
  });

  it("invalidates progress and removes loaded child detail only after deleting its parent", async () => {
    const { qc, wrapper } = setup(undefined, vi.fn().mockResolvedValue(deletionReceipt([ISSUE_ID], [ISSUE_ID])));
    qc.setQueryData(issueKeys.detail(WS_ID, ISSUE_ID), { ...baseIssue, parent_issue_id: null });
    qc.setQueryData(issueKeys.children(WS_ID, ISSUE_ID), [{ ...otherIssue, parent_issue_id: ISSUE_ID }]);
    qc.setQueryData(issueKeys.childProgress(WS_ID), new Map([[ISSUE_ID, { done: 0, total: 1 }]]));
    const { result } = renderHook(() => useBatchDeleteIssues(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ ids: [ISSUE_ID] }); });
    expect(qc.getQueryData(issueKeys.children(WS_ID, ISSUE_ID))).toBeUndefined();
    expectInvalidated(qc, issueKeys.childProgress(WS_ID));
    qc.clear();
  });
});
