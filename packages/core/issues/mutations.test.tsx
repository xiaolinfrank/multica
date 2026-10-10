/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { setApiInstance } from "../api";
import { configStore } from "../config";
import type { ApiClient } from "../api/client";
import { createQueryClient } from "../query-client";
import { cockpitArtifactKeys } from "../cockpit/artifact-queries";
import {
  useBatchUpdateIssues,
  useCreateComment,
  useCreateCommentSubIssue,
  useDeleteComment,
  useResolveComment,
  useUpdateComment,
  useUpdateIssue,
} from "./mutations";
import {
  issueKeys,
  type IssueSortParam,
} from "./queries";
import { onIssueUpdated, onIssueAuxiliaryRevision } from "./ws-updaters";
import { inboxKeys, inboxListOptions } from "../inbox/queries";
import {
  onInboxInvalidate,
  onInboxIssueStatusChanged,
} from "../inbox/ws-updaters";
import type {
  InboxItem,
  Issue,
  ListIssuesCache,
  TimelineEntry,
  UpdateIssueRequest,
} from "../types";

vi.mock("../hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

const WS_ID = "ws-1";

function makeIssue(idx: number, overrides: Partial<Issue> = {}): Issue {
  return {
    id: `issue-${idx}`,
    workspace_id: WS_ID,
    number: idx,
    identifier: `MUL-${idx}`,
    title: `Issue ${idx}`,
    description: null,
    status: "todo",
    priority: "none",
    assignee_type: null,
    assignee_id: null,
    creator_type: "member",
    creator_id: "user-1",
    parent_issue_id: null,
    project_id: null,
    position: idx,
    stage: null,
    start_date: null,
    due_date: null,
    labels: [],
    metadata: {},
  properties: {},
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeInboxItem(
  id: string,
  issueId: string,
  overrides: Partial<InboxItem> = {},
): InboxItem {
  return {
    id,
    workspace_id: WS_ID,
    recipient_type: "member",
    recipient_id: "user-1",
    actor_type: "member",
    actor_id: "user-2",
    type: "status_changed",
    severity: "info",
    issue_id: issueId,
    title: `Inbox ${id}`,
    body: null,
    issue_status: "todo",
    read: false,
    archived: false,
    created_at: "2025-01-01T00:00:00Z",
    details: null,
    ...overrides,
  };
}

function createWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe("useCreateCommentSubIssue", () => {
  it("applies the normal issue-create cache coordination", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const listKey = issueKeys.list(WS_ID);
    qc.setQueryData<ListIssuesCache>(listKey, {
      byStatus: { unstarted: { issues: [], total: 0 } },
    });
    const child = makeIssue(2, { parent_issue_id: "issue-1" });
    const createCommentSubIssue = vi.fn().mockResolvedValue(child);
    setApiInstance({ createCommentSubIssue } as unknown as ApiClient);
    const { result } = renderHook(() => useCreateCommentSubIssue(), {
      wrapper: createWrapper(qc),
    });

    await act(async () => {
      await result.current.mutateAsync({
        anchorCommentId: "comment-1",
        data: {
          mode: "manual",
          capture_token: "sha256:capture",
          issue: { title: "Child" },
        },
      });
    });

    expect(createCommentSubIssue).toHaveBeenCalledWith("comment-1", {
      mode: "manual",
      capture_token: "sha256:capture",
      issue: { title: "Child" },
    });
    expect(
      qc.getQueryData<ListIssuesCache>(listKey)?.byStatus.unstarted?.issues,
    ).toContainEqual(child);
    expect(qc.getQueryState(listKey)?.isInvalidated).toBe(true);
    qc.clear();
  });
});

describe("useUpdateIssue — optimistic move keeps every bucketed board in sync", () => {
  const sort: IssueSortParam = { sort_by: "position", sort_direction: undefined };
  const myScope = "assigned";
  const myFilter = { assignee_id: "user-1" };
  const projectScope = "project:p1";
  const projectFilter = { project_id: "p1" };
  const wsKey = issueKeys.listSorted(WS_ID, sort);
  const inboxKey = inboxKeys.list(WS_ID);
  // My-Issues AND the Project board both ride this myList cache; a move that
  // only patched the workspace cache snaps back on those boards.
  const myKey = issueKeys.myListSorted(WS_ID, myScope, myFilter, sort);
  const projectKey = issueKeys.myListSorted(WS_ID, projectScope, projectFilter, sort);

  let qc: QueryClient;
  let updateIssue: ReturnType<typeof vi.fn<(id: string, data: unknown) => Promise<Issue>>>;
  let moveIssue: ReturnType<typeof vi.fn<(id: string, data: unknown) => Promise<Issue>>>;

  function makeBucketed(): ListIssuesCache {
    return {
      byStatus: {
        unstarted: { issues: [makeIssue(1)], total: 1 },
        started: { issues: [], total: 0 },
      },
    };
  }

  function bucketIds(
    key: readonly unknown[],
    status: "unstarted" | "started",
  ): string[] {
    const c = qc.getQueryData<ListIssuesCache>(key);
    return (c?.byStatus[status]?.issues ?? []).map((i) => i.id);
  }

  function inboxStatus(issueId: string) {
    return qc
      .getQueryData<InboxItem[]>(inboxKey)
      ?.find((item) => item.issue_id === issueId)?.issue_status;
  }

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    updateIssue = vi.fn();
    moveIssue = vi.fn();
    setApiInstance({ updateIssue, moveIssue } as unknown as ApiClient);
    qc.setQueryData<ListIssuesCache>(wsKey, makeBucketed());
    qc.setQueryData<ListIssuesCache>(myKey, makeBucketed());
    qc.setQueryData<ListIssuesCache>(projectKey, makeBucketed());
    qc.setQueryData<InboxItem[]>(inboxKey, [
      makeInboxItem("inbox-1", "issue-1"),
      makeInboxItem("inbox-2", "issue-2"),
    ]);
  });

  afterEach(() => {
    qc.clear();
    vi.restoreAllMocks();
  });

  it("optimistically moves the card in both the workspace and myList caches", async () => {
    let resolve!: (issue: Issue) => void;
    updateIssue.mockReturnValue(
      new Promise<Issue>((r) => {
        resolve = r;
      }),
    );

    const { result } = renderHook(() => useUpdateIssue(), {
      wrapper: createWrapper(qc),
    });

    act(() => {
      result.current.mutate({ id: "issue-1", status: "in_progress", position: 5 });
    });

    // Optimistic state — the regression: myList must move too, not just ws.
    for (const key of [wsKey, myKey, projectKey]) {
      expect(bucketIds(key, "unstarted")).toEqual([]);
      expect(bucketIds(key, "started")).toEqual(["issue-1"]);
    }

    await act(async () => {
      resolve(makeIssue(1, { status: "in_progress", position: 5 }));
    });

    // Authoritative settle keeps the card in place in both caches.
    for (const key of [wsKey, myKey, projectKey]) {
      expect(bucketIds(key, "started")).toEqual(["issue-1"]);
    }
  });

  it("does not couple a field update to the cached aggregate revision", async () => {
    qc.setQueryData(
      issueKeys.detail(WS_ID, "issue-1"),
      makeIssue(1, { revision: 6 }),
    );
    updateIssue.mockResolvedValue(makeIssue(1, { title: "Renamed", revision: 7 }));
    const { result } = renderHook(() => useUpdateIssue(), {
      wrapper: createWrapper(qc),
    });

    await act(async () => {
      await result.current.mutateAsync({ id: "issue-1", title: "Renamed" });
    });

    expect(updateIssue).toHaveBeenCalledWith("issue-1", {
      title: "Renamed",
    });
  });

  it("does not let an older successful response overwrite a newer WS revision", async () => {
    let resolve!: (issue: Issue) => void;
    updateIssue.mockReturnValue(
      new Promise<Issue>((done) => {
        resolve = done;
      }),
    );
    const detailKey = issueKeys.detail(WS_ID, "issue-1");
    qc.setQueryData<Issue>(detailKey, makeIssue(1, { revision: 1 }));
    const { result } = renderHook(() => useUpdateIssue(), {
      wrapper: createWrapper(qc),
    });

    act(() => {
      result.current.mutate({ id: "issue-1", title: "local" });
    });
    await waitFor(() => expect(updateIssue).toHaveBeenCalled());
    onIssueUpdated(
      qc,
      WS_ID,
      makeIssue(1, { title: "newer remote", revision: 3 }),
    );

    await act(async () => {
      resolve(makeIssue(1, { title: "older success", revision: 2 }));
    });

    expect(qc.getQueryData<Issue>(detailKey)).toMatchObject({
      title: "newer remote",
      revision: 3,
    });
  });

  it("keeps a full response admissible after a newer revision-only response", async () => {
    let resolve!: (issue: Issue) => void;
    updateIssue.mockReturnValue(
      new Promise<Issue>((done) => {
        resolve = done;
      }),
    );
    const detailKey = issueKeys.detail(WS_ID, "issue-1");
    qc.setQueryData<Issue>(detailKey, makeIssue(1, { title: "A", revision: 1 }));
    const { result } = renderHook(() => useUpdateIssue(), {
      wrapper: createWrapper(qc),
    });

    act(() => {
      result.current.mutate({ id: "issue-1", title: "local" });
    });
    await waitFor(() => expect(updateIssue).toHaveBeenCalled());
    onIssueAuxiliaryRevision(qc, WS_ID, "issue-1", 3);

    await act(async () => {
      resolve(makeIssue(1, { title: "B", revision: 2 }));
    });

    expect(qc.getQueryData<Issue>(detailKey)).toMatchObject({
      title: "B",
      revision: 2,
    });
    expect(qc.getQueryState(detailKey)?.isInvalidated).toBe(true);
  });

  it("keeps the authoritative description base while a description update is pending", async () => {
    let resolve!: (issue: Issue) => void;
    updateIssue.mockReturnValue(
      new Promise<Issue>((r) => {
        resolve = r;
      }),
    );
    const detailKey = issueKeys.detail(WS_ID, "issue-1");
    qc.setQueryData<Issue>(detailKey, makeIssue(1, { description: "base" }));
    const { result } = renderHook(() => useUpdateIssue(), {
      wrapper: createWrapper(qc),
    });

    act(() => {
      result.current.mutate({
        id: "issue-1",
        description: "local edit",
        description_base: "base",
      });
    });

    await waitFor(() => {
      expect(updateIssue).toHaveBeenCalledWith("issue-1", {
        description: "local edit",
        description_base: "base",
      });
    });
    const optimistic = qc.getQueryData<Issue & { description_base?: string }>(detailKey);
    expect(optimistic?.description).toBe("base");
    expect(optimistic).not.toHaveProperty("description_base");

    await act(async () => {
      resolve(makeIssue(1, { description: "local edit" }));
    });
    expect(qc.getQueryData<Issue>(detailKey)?.description).toBe("local edit");
  });

  it("uses server move intent while keeping provisional position optimistic-only", async () => {
    moveIssue.mockResolvedValue(
      makeIssue(1, { status: "in_progress", position: 15 }),
    );
    const { result } = renderHook(() => useUpdateIssue(), {
      wrapper: createWrapper(qc),
    });

    await act(async () => {
      await result.current.mutateAsync({
        id: "issue-1",
        status: "in_progress",
        position: 12,
        move_intent: {
          before_id: "issue-0",
          after_id: "issue-2",
        },
      });
    });

    expect(moveIssue).toHaveBeenCalledWith("issue-1", {
      status: "in_progress",
      before_id: "issue-0",
      after_id: "issue-2",
    });
    expect(updateIssue).not.toHaveBeenCalled();
    expect(
      qc
        .getQueryData<ListIssuesCache>(wsKey)
        ?.byStatus.started?.issues[0]?.position,
    ).toBe(15);
  });

  it("optimistically patches the linked inbox row status and reconciles with the server response", async () => {
    let resolve!: (issue: Issue) => void;
    updateIssue.mockReturnValue(
      new Promise<Issue>((r) => {
        resolve = r;
      }),
    );

    const { result } = renderHook(() => useUpdateIssue(), {
      wrapper: createWrapper(qc),
    });

    act(() => {
      result.current.mutate({ id: "issue-1", status: "in_progress" });
    });

    expect(inboxStatus("issue-1")).toBe("in_progress");
    expect(inboxStatus("issue-2")).toBe("todo");

    await act(async () => {
      resolve(makeIssue(1, { status: "done" }));
    });

    expect(inboxStatus("issue-1")).toBe("done");
    expect(inboxStatus("issue-2")).toBe("todo");
  });

  it("rolls both caches back when the request fails", async () => {
    updateIssue.mockRejectedValue(new Error("boom"));
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    const { result } = renderHook(() => useUpdateIssue(), {
      wrapper: createWrapper(qc),
    });

    await act(async () => {
      await result.current
        .mutateAsync({ id: "issue-1", status: "in_progress", position: 5 })
        .catch(() => {});
    });

    for (const key of [wsKey, myKey, projectKey]) {
      expect(bucketIds(key, "unstarted")).toEqual(["issue-1"]);
      expect(bucketIds(key, "started")).toEqual([]);
    }
    const invalidatedKeys = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(invalidatedKeys).toContainEqual(issueKeys.detail(WS_ID, "issue-1"));
    expect(invalidatedKeys).toContainEqual(issueKeys.list(WS_ID));
    expect(invalidatedKeys).toContainEqual(issueKeys.myAll(WS_ID));
    expect(invalidatedKeys).toContainEqual(issueKeys.flatAll(WS_ID));
    expect(invalidatedKeys).toContainEqual(issueKeys.tableAll(WS_ID));
  });

  it("rolls the linked inbox row status back when the request fails", async () => {
    updateIssue.mockRejectedValue(new Error("boom"));

    const { result } = renderHook(() => useUpdateIssue(), {
      wrapper: createWrapper(qc),
    });

    await act(async () => {
      await result.current
        .mutateAsync({ id: "issue-1", status: "in_progress" })
        .catch(() => {});
    });

    expect(inboxStatus("issue-1")).toBe("todo");
    expect(inboxStatus("issue-2")).toBe("todo");
  });

  it("does not invalidate the board list on settle (no refetch flicker)", async () => {
    updateIssue.mockResolvedValue(makeIssue(1, { status: "in_progress", position: 5 }));
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    const { result } = renderHook(() => useUpdateIssue(), {
      wrapper: createWrapper(qc),
    });

    await act(async () => {
      await result.current.mutateAsync({ id: "issue-1", status: "in_progress", position: 5 });
    });

    const invalidatedKeys = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    // The board list + myList are reconciled surgically, never refetched.
    expect(invalidatedKeys).not.toContainEqual(issueKeys.list(WS_ID));
    expect(invalidatedKeys).not.toContainEqual(issueKeys.myAll(WS_ID));
  });

  it("surgically removes the issue from the old project's list on a project move (no blanket myAll refetch)", async () => {
    // A project move makes the issue leave the old project's filtered list.
    // The membership-aware coordinator removes the card from that loaded list
    // in onMutate — deterministic, no WS echo or refetch needed — replacing
    // the old blanket "invalidate myAll on settle" safety net (MUL-3669 /
    // #4548). Lists whose filter the move cannot affect stay untouched.
    let resolve!: (issue: Issue) => void;
    updateIssue.mockReturnValue(
      new Promise<Issue>((r) => {
        resolve = r;
      }),
    );
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    const { result } = renderHook(() => useUpdateIssue(), {
      wrapper: createWrapper(qc),
    });

    act(() => {
      result.current.mutate({ id: "issue-1", project_id: "project-9" });
    });

    // Optimistic: gone from the old project's list immediately; the
    // workspace board and the assignee-filtered list keep the card.
    expect(bucketIds(projectKey, "unstarted")).toEqual([]);
    expect(bucketIds(wsKey, "unstarted")).toEqual(["issue-1"]);
    expect(bucketIds(myKey, "unstarted")).toEqual(["issue-1"]);

    await act(async () => {
      resolve(makeIssue(1, { project_id: "project-9" }));
    });

    expect(bucketIds(projectKey, "unstarted")).toEqual([]);
    const invalidatedKeys = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(invalidatedKeys).not.toContainEqual(issueKeys.myAll(WS_ID));
  });

  it("rolls the membership removal back when a project move fails", async () => {
    updateIssue.mockRejectedValue(new Error("boom"));

    const { result } = renderHook(() => useUpdateIssue(), {
      wrapper: createWrapper(qc),
    });

    await act(async () => {
      await result.current
        .mutateAsync({ id: "issue-1", project_id: "project-9" })
        .catch(() => {});
    });

    expect(bucketIds(projectKey, "unstarted")).toEqual(["issue-1"]);
  });
});

describe("useUpdateIssue — detaching a sub-issue prunes the old parent's children cache", () => {
  const PARENT_ID = "parent-1";
  const childKey = issueKeys.children(WS_ID, PARENT_ID);

  let qc: QueryClient;
  let updateIssue: ReturnType<typeof vi.fn<(id: string, data: unknown) => Promise<Issue>>>;

  function childIds(): string[] {
    return (qc.getQueryData<Issue[]>(childKey) ?? []).map((c) => c.id);
  }

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    updateIssue = vi.fn();
    setApiInstance({ updateIssue } as unknown as ApiClient);
    // Seed the detail cache so onMutate resolves the old parent from the
    // freshest source, plus the parent's children list rendered by the
    // sub-issues section.
    const child = makeIssue(1, { parent_issue_id: PARENT_ID, stage: 2 });
    qc.setQueryData<Issue>(issueKeys.detail(WS_ID, child.id), child);
    qc.setQueryData<Issue[]>(childKey, [
      child,
      makeIssue(2, { parent_issue_id: PARENT_ID }),
    ]);
  });

  afterEach(() => {
    qc.clear();
    vi.restoreAllMocks();
  });

  it("optimistically removes the issue from the old parent's children array", async () => {
    let resolve!: (issue: Issue) => void;
    updateIssue.mockReturnValue(
      new Promise<Issue>((r) => {
        resolve = r;
      }),
    );

    const { result } = renderHook(() => useUpdateIssue(), {
      wrapper: createWrapper(qc),
    });

    act(() => {
      result.current.mutate({ id: "issue-1", parent_issue_id: null, stage: null });
    });

    // Pruned immediately so the parent's sub-issues list drops it now, not
    // after the settle refetch; the sibling is untouched.
    expect(childIds()).toEqual(["issue-2"]);

    await act(async () => {
      resolve(makeIssue(1, { parent_issue_id: null, stage: null }));
    });
    expect(childIds()).not.toContain("issue-1");
  });

  it("restores the old parent's children when the request fails", async () => {
    updateIssue.mockRejectedValue(new Error("boom"));

    const { result } = renderHook(() => useUpdateIssue(), {
      wrapper: createWrapper(qc),
    });

    await act(async () => {
      await result.current
        .mutateAsync({ id: "issue-1", parent_issue_id: null, stage: null })
        .catch(() => {});
    });

    expect(childIds()).toEqual(["issue-1", "issue-2"]);
  });

  it("keeps the issue under its parent for a non-reparenting update", async () => {
    updateIssue.mockResolvedValue(
      makeIssue(1, { parent_issue_id: PARENT_ID, status: "done" }),
    );

    const { result } = renderHook(() => useUpdateIssue(), {
      wrapper: createWrapper(qc),
    });

    act(() => {
      result.current.mutate({ id: "issue-1", status: "done" });
    });

    // A status-only change patches in place — never prunes the relationship.
    expect(childIds()).toEqual(["issue-1", "issue-2"]);
  });
});

describe("useBatchUpdateIssues — confirmed writes across filtered boards", () => {
  const sort: IssueSortParam = { sort_by: "position", sort_direction: undefined };
  const wsKey = issueKeys.listSorted(WS_ID, sort);
  const myKey = issueKeys.myListSorted(WS_ID, "assigned", { assignee_id: "user-1" }, sort);
  let qc: QueryClient;
  let batchUpdateIssues: ReturnType<typeof vi.fn>;
  function makeBucketed(): ListIssuesCache {
    return { byStatus: { unstarted: { issues: [makeIssue(1)], total: 1 }, started: { issues: [], total: 0 } } };
  }
  const receipt = { workspace_id: WS_ID, requested_ids: ["issue-1"], transaction_mode: "per_item", transaction_outcome: "committed",
    updated: 1, results: [{ issue_id: "issue-1", outcome: "applied", revision: 3, changed: true }], unconfirmed_ids: [] };
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    batchUpdateIssues = vi.fn(); setApiInstance({ batchUpdateIssues } as unknown as ApiClient);
    qc.setQueryData(wsKey, makeBucketed()); qc.setQueryData(myKey, makeBucketed());
  });
  afterEach(() => { qc.clear(); vi.restoreAllMocks(); });

  it("keeps both boards unchanged while pending and refreshes them from the server after acknowledgement", async () => {
    let resolve!: (value: typeof receipt) => void;
    batchUpdateIssues.mockReturnValue(new Promise((answer) => { resolve = answer; }));
    const { result } = renderHook(() => useBatchUpdateIssues(), { wrapper: createWrapper(qc) });
    let promise!: Promise<unknown>;
    await act(async () => { promise = result.current.mutateAsync({ ids: ["issue-1"], updates: { status: "in_progress" } }); await Promise.resolve(); });
    for (const key of [wsKey, myKey]) {
      expect(qc.getQueryData(key)).toEqual(makeBucketed());
      expect(qc.getQueryState(key)?.isInvalidated).toBe(false);
    }
    await act(async () => { resolve(receipt); await promise; });
    for (const key of [wsKey, myKey]) expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
    expect(batchUpdateIssues).toHaveBeenCalledWith(WS_ID, ["issue-1"], { status: "in_progress" }, { expected_revisions: undefined });
  });

  it("preserves description merge bases and passes explicit revision guards", async () => {
    batchUpdateIssues.mockResolvedValue(receipt);
    const detail = makeIssue(1, { description: "base with marker" });
    qc.setQueryData(issueKeys.detail(WS_ID, "issue-1"), detail);
    const { result } = renderHook(() => useBatchUpdateIssues(), { wrapper: createWrapper(qc) });
    await act(async () => { await result.current.mutateAsync({ ids: ["issue-1"], updates: { description: "local edit", description_base: "base with marker" }, expected_revisions: { "issue-1": 2 } }); });
    expect(batchUpdateIssues).toHaveBeenCalledWith(WS_ID, ["issue-1"], { description: "local edit", description_base: "base with marker" }, { expected_revisions: { "issue-1": 2 } });
    expect(qc.getQueryData(issueKeys.detail(WS_ID, "issue-1"))).toEqual(detail);
    expect(qc.getQueryState(issueKeys.detail(WS_ID, "issue-1"))?.isInvalidated).toBe(true);
  });

  it("does not restore old snapshots over newer facts after partial or unknown failure", async () => {
    let reject!: (error: Error) => void;
    batchUpdateIssues.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    const { result } = renderHook(() => useBatchUpdateIssues(), { wrapper: createWrapper(qc) });
    let promise!: Promise<unknown>;
    await act(async () => { promise = result.current.mutateAsync({ ids: ["issue-1"], updates: { status: "in_progress" } }).catch((error) => error); await Promise.resolve(); });
    const newer: ListIssuesCache = { byStatus: { started: { issues: [makeIssue(1, { status: "in_progress", title: "Already saved by another confirmed write" })], total: 1 } } };
    qc.setQueryData(wsKey, newer); qc.setQueryData(myKey, newer);
    await act(async () => { reject(new Error("response lost after partial commit")); await promise; });
    for (const key of [wsKey, myKey]) {
      expect(qc.getQueryData(key)).toEqual(newer);
      expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
    }
  });

  it("refreshes a filtered project window after a batch move instead of inventing membership from a count", async () => {
    const projectKey = issueKeys.myListSorted(WS_ID, "project:p1", { project_id: "p1" }, sort);
    qc.setQueryData(projectKey, makeBucketed()); batchUpdateIssues.mockResolvedValue(receipt);
    const { result } = renderHook(() => useBatchUpdateIssues(), { wrapper: createWrapper(qc) });
    await act(async () => { await result.current.mutateAsync({ ids: ["issue-1"], updates: { project_id: "project-9" } }); });
    expect(qc.getQueryState(projectKey)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(myKey)?.isInvalidated).toBe(true);
  });
});

// MUL-7286: a status / priority write cancels the Inbox list's in-flight
// request so it cannot land on top of the optimistic patch. Whatever that
// request was carrying — here a new notification — must be re-read once the
// write settles, or the unread badge counts a row the list never shows. The
// cancel primitive itself is covered in inbox/ws-updaters.test.ts.
describe("status / priority writes re-read an Inbox list they left behind", () => {
  const readItem = makeInboxItem("n1", "issue-1", {
    read: true,
    issue_priority: "none",
  });
  const notification = makeInboxItem("n2", "issue-2", {
    created_at: "2025-01-02T00:00:00Z",
  });
  const writes = [
    {
      name: "useUpdateIssue",
      write: (hooks: WriteHooks) =>
        hooks.single.mutateAsync({ id: "issue-1", priority: "high" }),
    },
    {
      name: "useBatchUpdateIssues",
      write: (hooks: WriteHooks) =>
        hooks.batch.mutateAsync({ ids: ["issue-1"], updates: { priority: "high" } }),
    },
  ];

  let qc: QueryClient;
  const unmounts: Array<() => void> = [];

  function renderWriteHooks() {
    const hooks = renderHook(
      () => ({ single: useUpdateIssue(), batch: useBatchUpdateIssues() }),
      { wrapper: createWrapper(qc) },
    );
    unmounts.push(hooks.unmount);
    return hooks.result;
  }
  type WriteHooks = ReturnType<typeof renderWriteHooks>["current"];

  function mountInbox() {
    const page = renderHook(() => useQuery(inboxListOptions(WS_ID)), {
      wrapper: createWrapper(qc),
    });
    unmounts.push(page.unmount);
    return page.result;
  }

  function mockApi(
    listInbox: () => Promise<InboxItem[]>,
    { fail = false }: { fail?: boolean } = {},
  ) {
    const settle = <T,>(value: T) =>
      fail ? Promise.reject(new Error("boom")) : Promise.resolve(value);
    setApiInstance({
      listInbox,
      updateIssue: () => settle(makeIssue(1, { priority: "high" })),
      batchUpdateIssues: () => settle({ updated: 1 }),
    } as unknown as ApiClient);
  }

  beforeEach(() => {
    qc = createQueryClient();
  });

  afterEach(() => {
    unmounts.splice(0).forEach((unmount) => unmount());
    qc.clear();
  });

  it.each(
    writes.flatMap((w) => [
      { ...w, issueEvent: false },
      { ...w, issueEvent: true },
    ]),
  )(
    "$name re-reads the request it interrupted (issue event meanwhile: $issueEvent)",
    async ({ write, issueEvent }) => {
      let release!: (items: InboxItem[]) => void;
      const listInbox = vi
        .fn<() => Promise<InboxItem[]>>()
        .mockResolvedValueOnce([readItem])
        .mockImplementationOnce(
          () => new Promise((resolve) => (release = resolve)),
        )
        .mockResolvedValue([notification, readItem]);
      mockApi(listInbox);
      const hooks = renderWriteHooks();
      const inbox = mountInbox();
      await waitFor(() => expect(inbox.current.data).toEqual([readItem]));

      // `inbox:new` while the Inbox is open; the list re-read is still out.
      act(() => {
        void onInboxInvalidate(qc, WS_ID);
      });
      await waitFor(() => expect(listInbox).toHaveBeenCalledTimes(2));
      expect(qc.getQueryState(inboxKeys.list(WS_ID))?.fetchStatus).toBe("fetching");
      if (issueEvent) {
        // An `issue:updated` patching a listed row mid-request replaces the
        // snapshot TanStack reverts to on cancel with a non-invalidated state.
        onInboxIssueStatusChanged(qc, WS_ID, "issue-1", "in_progress");
      }

      await act(async () => {
        await write(hooks.current);
      });
      release([notification, readItem]); // interrupted: its response is dropped

      await waitFor(() =>
        expect(inbox.current.data?.map((item) => item.id)).toEqual(["n2", "n1"]),
      );
      expect(listInbox).toHaveBeenCalledTimes(3);
    },
  );

  it.each(writes)(
    "$name reconciles the Inbox after an otherwise uninterrupted write",
    async ({ name, write }) => {
      const listInbox = vi
        .fn<() => Promise<InboxItem[]>>()
        .mockResolvedValueOnce([readItem])
        .mockResolvedValue([{ ...readItem, issue_priority: "high" }]);
      mockApi(listInbox);
      const hooks = renderWriteHooks();
      const inbox = mountInbox();
      await waitFor(() => expect(inbox.current.data).toEqual([readItem]));

      await act(async () => {
        await write(hooks.current);
      });

      await waitFor(() =>
        expect(inbox.current.data?.[0]?.issue_priority).toBe("high"),
      );
      expect(listInbox).toHaveBeenCalledTimes(name === "useBatchUpdateIssues" ? 2 : 1);
    },
  );

  it.each(writes)(
    "$name keeps the pending refresh when a failed write rolls the rows back",
    async ({ write }) => {
      const listInbox = vi.fn<() => Promise<InboxItem[]>>();
      mockApi(listInbox, { fail: true });
      // The user is elsewhere: the list is cached, nothing observes it, and an
      // `inbox:new` has marked it to re-read on the next visit.
      qc.setQueryData<InboxItem[]>(inboxKeys.list(WS_ID), [readItem]);
      await onInboxInvalidate(qc, WS_ID);
      const hooks = renderWriteHooks();

      await act(async () => {
        await write(hooks.current).catch(() => {});
      });

      await waitFor(() =>
        expect(qc.getQueryState(inboxKeys.list(WS_ID))?.isInvalidated).toBe(true),
      );
      expect(qc.getQueryData(inboxKeys.list(WS_ID))).toEqual([readItem]);
      expect(listInbox).not.toHaveBeenCalled();
    },
  );

  // Writes that overlap each other or a list request: the re-read must come
  // after the last save, or it reads a pending write's old value and lands on
  // top of its patch.
  describe("overlapping writes", () => {
    const rowA = makeInboxItem("n-a", "issue-1", { read: true, issue_priority: "none" });
    const rowB = makeInboxItem("n-b", "issue-2", { read: true, issue_priority: "none" });
    const newRow = makeInboxItem("n-c", "issue-3", {
      issue_priority: "none",
      created_at: "2025-01-02T00:00:00Z",
    });
    type Kind = "useUpdateIssue" | "useBatchUpdateIssues";

    // List reads and saves complete only when the test says so. A read answers
    // with the rows as they were when it reached the server.
    function controlledServer(initial: InboxItem[]) {
      let rows = initial;
      const reads: Array<() => void> = [];
      const saves = new Map<string, () => void>();
      const listInbox = vi.fn(() => {
        const snapshot = rows;
        return new Promise<InboxItem[]>((resolve) =>
          reads.push(() => resolve(snapshot)),
        );
      });
      const save = (id: string, priority: UpdateIssueRequest["priority"]) =>
        new Promise<void>((resolve) =>
          saves.set(id, () => {
            rows = rows.map((row) =>
              row.issue_id === id ? { ...row, issue_priority: priority } : row,
            );
            resolve();
          }),
        );
      setApiInstance({
        listInbox,
        updateIssue: (id: string, data: UpdateIssueRequest) =>
          save(id, data.priority).then(() => ({ ...makeIssue(1), ...data, id })),
        batchUpdateIssues: (_wsId: string, ids: string[], updates: UpdateIssueRequest) =>
          save(ids[0]!, updates.priority).then(() => ({ updated: ids.length })),
      } as unknown as ApiClient);
      return {
        listInbox,
        setRows: (next: InboxItem[]) => {
          rows = next;
        },
        answerReads: () => reads.splice(0).forEach((answer) => answer()),
        saving: (id: string) => saves.has(id),
        commit: (id: string) => saves.get(id)!(),
      };
    }

    function write(hooks: WriteHooks, kind: Kind, id: string) {
      return kind === "useUpdateIssue"
        ? hooks.single.mutateAsync({ id, priority: "high" })
        : hooks.batch.mutateAsync({ ids: [id], updates: { priority: "high" } });
    }

    async function loadInbox(server: ReturnType<typeof controlledServer>) {
      const inbox = mountInbox();
      await waitFor(() => expect(server.listInbox).toHaveBeenCalledTimes(1));
      server.answerReads();
      await waitFor(() => expect(inbox.current.data).toBeDefined());
      return () => inbox.current.data?.map((row) => [row.id, row.issue_priority]);
    }

    const pairings = [
      ["useUpdateIssue", "useUpdateIssue"],
      ["useBatchUpdateIssues", "useBatchUpdateIssues"],
      ["useUpdateIssue", "useBatchUpdateIssues"],
      ["useBatchUpdateIssues", "useUpdateIssue"],
    ] as const;

    // An `inbox:new` re-read is out when A's write interrupts it; B's write
    // starts before A is saved and finds nothing to interrupt.
    async function overlapWrites(first: Kind, second: Kind) {
      const server = controlledServer([rowA, rowB]);
      const hooks = renderWriteHooks();
      const rendered = await loadInbox(server);
      server.setRows([newRow, rowA, rowB]);
      act(() => {
        void onInboxInvalidate(qc, WS_ID);
      });
      await waitFor(() => expect(server.listInbox).toHaveBeenCalledTimes(2));

      let writeA!: Promise<unknown>;
      let writeB!: Promise<unknown>;
      act(() => {
        writeA = write(hooks.current, first, "issue-1");
      });
      await waitFor(() => expect(server.saving("issue-1")).toBe(true));
      act(() => {
        writeB = write(hooks.current, second, "issue-2");
      });
      await waitFor(() => expect(server.saving("issue-2")).toBe(true));
      // Batch writes keep current server facts until acknowledgement; they do
      // not need to interrupt this read to protect an optimistic Inbox patch.
      expect(qc.getQueryState(inboxKeys.list(WS_ID))?.fetchStatus).toBe(
        first === "useBatchUpdateIssues" && second === "useBatchUpdateIssues" ? "fetching" : "idle",
      );
      return { server, rendered, writeA, writeB };
    }

    const everySaved = [
      ["n-c", "none"],
      ["n-a", "high"],
      ["n-b", "high"],
    ];

    it.each(pairings)(
      "re-reads once, after the last of them saves (%s, then %s)",
      async (first: Kind, second: Kind) => {
        const { server, rendered, writeA, writeB } = await overlapWrites(first, second);

        await act(async () => {
          server.commit("issue-1");
          await writeA;
        });
        await act(async () => {});
        // A owes the re-read, but reading while B is unsaved would miss B.
        expect(server.listInbox).toHaveBeenCalledTimes(2);

        await act(async () => {
          server.commit("issue-2");
          await writeB;
        });
        await waitFor(() => expect(server.listInbox).toHaveBeenCalledTimes(3));
        server.answerReads();

        await waitFor(() => expect(rendered()).toEqual(everySaved));
      },
    );

    it.each(pairings)(
      "re-reads when both saves land in the same tick (%s, then %s)",
      async (first: Kind, second: Kind) => {
        const { server, rendered, writeA, writeB } = await overlapWrites(first, second);

        // Each write settles while the other still counts as in flight.
        await act(async () => {
          server.commit("issue-1");
          server.commit("issue-2");
          await Promise.all([writeA, writeB]);
        });
        expect(qc.isMutating()).toBe(0);
        await waitFor(() => expect(server.listInbox).toHaveBeenCalledTimes(3));
        server.answerReads();

        await waitFor(() => expect(rendered()).toEqual(everySaved));
      },
    );

    it.each(["useUpdateIssue", "useBatchUpdateIssues"] as const)(
      "%s re-reads a list request that started while it was saving",
      async (kind: Kind) => {
        const server = controlledServer([rowA]);
        const hooks = renderWriteHooks();
        const rendered = await loadInbox(server);

        let writeA!: Promise<unknown>;
        act(() => {
          writeA = write(hooks.current, kind, "issue-1");
        });
        await waitFor(() => expect(server.saving("issue-1")).toBe(true));
        // `inbox:new` mid-save: this read reaches the server before A is saved.
        server.setRows([newRow, rowA]);
        act(() => {
          void onInboxInvalidate(qc, WS_ID);
        });
        await waitFor(() => expect(server.listInbox).toHaveBeenCalledTimes(2));

        await act(async () => {
          server.commit("issue-1");
          await writeA;
        });
        await waitFor(() => expect(server.listInbox).toHaveBeenCalledTimes(3));
        server.answerReads();

        await waitFor(() =>
          expect(rendered()).toEqual([
            ["n-c", "none"],
            ["n-a", "high"],
          ]),
        );
      },
    );
  });
});

describe("comment mutations — owner revision and last activity", () => {
  const issueId = "issue-1";
  const detailKey = issueKeys.detail(WS_ID, issueId);
  const lastActivityKey = issueKeys.listSorted(WS_ID, {
    sort_by: "last_activity",
    sort_direction: "desc",
  });
  const positionKey = issueKeys.listSorted(WS_ID, { sort_by: "position" });

  function seed(qc: QueryClient) {
    const issue = makeIssue(1, { revision: 1 });
    const board: ListIssuesCache = {
      byStatus: { unstarted: { issues: [issue], total: 1 } },
    };
    qc.setQueryData<Issue>(detailKey, issue);
    qc.setQueryData<ListIssuesCache>(lastActivityKey, board);
    qc.setQueryData<ListIssuesCache>(positionKey, board);
    qc.setQueryData<TimelineEntry[]>(issueKeys.timeline(issueId), [
      {
        type: "comment",
        id: "comment-1",
        actor_type: "member",
        actor_id: "user-1",
        content: "before",
        parent_id: null,
        comment_type: "comment",
        reactions: [],
        attachments: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ]);
  }

  it("consumes an update response's issue revision and re-sorts activity", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seed(qc);
    setApiInstance({
      updateComment: vi.fn().mockResolvedValue({
        id: "comment-1",
        issue_id: issueId,
        content: "after",
        issue_revision: 2,
      }),
    } as unknown as ApiClient);
    const { result } = renderHook(() => useUpdateComment(issueId), {
      wrapper: createWrapper(qc),
    });

    await act(async () => {
      await result.current.mutateAsync({
        commentId: "comment-1",
        content: "after",
        attachmentIds: [],
      });
    });

    expect(qc.getQueryState(detailKey)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(lastActivityKey)?.isInvalidated).toBe(true);
    // The owner revision also invalidates any loaded projection containing
    // this issue, independent of sort.
    expect(qc.getQueryState(positionKey)?.isInvalidated).toBe(true);
    qc.clear();
  });

  it("invalidates the owner projection after a successful 204 delete", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seed(qc);
    setApiInstance({
      deleteComment: vi.fn().mockResolvedValue(undefined),
    } as unknown as ApiClient);
    const { result } = renderHook(() => useDeleteComment(issueId), {
      wrapper: createWrapper(qc),
    });

    await act(async () => {
      await result.current.mutateAsync("comment-1");
    });

    expect(qc.getQueryState(detailKey)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(lastActivityKey)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(positionKey)?.isInvalidated).toBe(true);
    qc.clear();
  });

  // #8296: deleting a comment keeps its replies. The outcome (tombstone or
  // removal) is applied only once the server confirms; the matrix itself lives
  // in comment-deletion.test.ts.
  it("keeps the timeline until the delete is confirmed, then keeps the replies", async () => {
    configStore.getState().setCommentDeleteKeepRepliesSupported(true);
    onTestFinished(() => configStore.getState().setCommentDeleteKeepRepliesSupported(false));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seed(qc);
    const [root] = qc.getQueryData<TimelineEntry[]>(issueKeys.timeline(issueId))!;
    const reply: TimelineEntry = { ...root!, id: "comment-2", parent_id: "comment-1", content: "reply" };
    qc.setQueryData<TimelineEntry[]>(issueKeys.timeline(issueId), [root!, reply]);
    let confirm!: () => void;
    const deleteComment = vi.fn(() => new Promise<void>((resolve) => { confirm = resolve; }));
    setApiInstance({ deleteComment } as unknown as ApiClient);
    const { result } = renderHook(() => useDeleteComment(issueId), {
      wrapper: createWrapper(qc),
    });

    let pending!: Promise<unknown>;
    await act(async () => {
      pending = result.current.mutateAsync("comment-1");
    });
    await waitFor(() => expect(deleteComment).toHaveBeenCalledWith("comment-1", { keepReplies: true }));
    expect(qc.getQueryData<TimelineEntry[]>(issueKeys.timeline(issueId))).toEqual([root, reply]);

    await act(async () => {
      confirm();
      await pending;
    });
    const timeline = qc.getQueryData<TimelineEntry[]>(issueKeys.timeline(issueId))!;
    expect(timeline.map((e) => e.id)).toEqual(["comment-1", "comment-2"]);
    expect(timeline[0]).toMatchObject({ content: "" });
    expect(timeline[0]?.deleted_at).toEqual(expect.any(String));
    expect(timeline[1]).toEqual(reply);
    qc.clear();
  });

  // A server that has not declared the capability deletes the replies too:
  // the client uses the legacy route and mirrors that outcome.
  it("mirrors a reply-deleting server when the capability is not declared", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seed(qc);
    const [root] = qc.getQueryData<TimelineEntry[]>(issueKeys.timeline(issueId))!;
    const reply: TimelineEntry = { ...root!, id: "comment-2", parent_id: "comment-1", content: "reply" };
    qc.setQueryData<TimelineEntry[]>(issueKeys.timeline(issueId), [root!, reply]);
    const deleteComment = vi.fn().mockResolvedValue(undefined);
    setApiInstance({ deleteComment } as unknown as ApiClient);
    const { result } = renderHook(() => useDeleteComment(issueId), {
      wrapper: createWrapper(qc),
    });

    await act(async () => {
      await result.current.mutateAsync("comment-1");
    });

    expect(deleteComment).toHaveBeenCalledWith("comment-1", { keepReplies: false });
    expect(qc.getQueryData<TimelineEntry[]>(issueKeys.timeline(issueId))).toEqual([]);
    qc.clear();
  });

  it("leaves the timeline untouched when the delete fails", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seed(qc);
    const before = qc.getQueryData<TimelineEntry[]>(issueKeys.timeline(issueId));
    setApiInstance({
      deleteComment: vi.fn().mockRejectedValue(new Error("nope")),
    } as unknown as ApiClient);
    const { result } = renderHook(() => useDeleteComment(issueId), {
      wrapper: createWrapper(qc),
    });

    await act(async () => {
      await result.current.mutateAsync("comment-1").catch(() => undefined);
    });

    expect(qc.getQueryData<TimelineEntry[]>(issueKeys.timeline(issueId))).toBe(before);
    qc.clear();
  });
});

describe("useResolveComment", () => {
  const ISSUE_ID = "issue-1";

  function makeComment(
    id: string,
    parentId: string | null,
    resolvedAt: string | null,
  ): TimelineEntry {
    return {
      type: "comment",
      id,
      actor_type: "member",
      actor_id: "user-1",
      content: id,
      parent_id: parentId,
      comment_type: "comment",
      reactions: [],
      attachments: [],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      resolved_at: resolvedAt,
      resolved_by_type: resolvedAt ? "member" : null,
      resolved_by_id: resolvedAt ? "user-1" : null,
    };
  }

  // Two independent threads on one issue:
  //   root1 ─ a1 (resolved), b1
  //   root2 ─ a2 (resolved)
  function seedTimeline(qc: QueryClient) {
    const entries: TimelineEntry[] = [
      makeComment("root1", null, null),
      makeComment("a1", "root1", "2026-01-01T00:01:00Z"),
      makeComment("b1", "root1", null),
      makeComment("root2", null, null),
      makeComment("a2", "root2", "2026-01-01T00:05:00Z"),
    ];
    qc.setQueryData<TimelineEntry[]>(issueKeys.timeline(ISSUE_ID), entries);
  }

  function resolvedIds(qc: QueryClient): string[] {
    const cache = qc.getQueryData<TimelineEntry[]>(issueKeys.timeline(ISSUE_ID)) ?? [];
    return cache.filter((e) => e.resolved_at).map((e) => e.id).sort();
  }

  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    setApiInstance({
      resolveComment: vi.fn().mockResolvedValue({ id: "b1" }),
      unresolveComment: vi.fn().mockResolvedValue({ id: "b1" }),
    } as unknown as ApiClient);
  });

  afterEach(() => {
    qc.clear();
    vi.restoreAllMocks();
  });

  it("clears the prior resolution in the same thread when resolving another comment", async () => {
    seedTimeline(qc);

    const { result } = renderHook(() => useResolveComment(ISSUE_ID), {
      wrapper: createWrapper(qc),
    });

    await act(async () => {
      await result.current.mutateAsync({ commentId: "b1", resolved: true });
    });

    // b1 replaces a1 inside thread 1; a2 (thread 2) is untouched.
    expect(resolvedIds(qc)).toEqual(["a2", "b1"]);
  });

  it("does not clear resolutions in other threads", async () => {
    seedTimeline(qc);

    const { result } = renderHook(() => useResolveComment(ISSUE_ID), {
      wrapper: createWrapper(qc),
    });

    // Resolving root1 (thread 1) must leave a2 (thread 2) resolved.
    await act(async () => {
      await result.current.mutateAsync({ commentId: "root1", resolved: true });
    });

    expect(resolvedIds(qc)).toEqual(["a2", "root1"]);
  });

  it("unresolve only clears its own row, never siblings", async () => {
    // Legacy state: two resolved comments coexist in one thread.
    qc.setQueryData<TimelineEntry[]>(issueKeys.timeline(ISSUE_ID), [
      makeComment("root1", null, null),
      makeComment("a1", "root1", "2026-01-01T00:01:00Z"),
      makeComment("b1", "root1", "2026-01-01T00:02:00Z"),
    ]);

    const { result } = renderHook(() => useResolveComment(ISSUE_ID), {
      wrapper: createWrapper(qc),
    });

    await act(async () => {
      await result.current.mutateAsync({ commentId: "b1", resolved: false });
    });

    // Only b1 is cleared; a1 stays resolved (unresolve never mirrors the clear).
    expect(resolvedIds(qc)).toEqual(["a1"]);
  });
});

// MUL-6394: posting a comment while the Table view's grouped/facet caches are
// loaded rejected `mutateAsync` with "Cannot read properties of undefined
// (reading 'some')" — the comment WAS created server-side (the agent task
// started), but the composer showed an error toast and never appended the
// entry, so it only appeared after a reload.
describe("useCreateComment — sibling caches under a shared key prefix", () => {
  const ISSUE_ID = "issue-1";
  const tableQuery = {
    scope: { kind: "workspace" },
    filters: {},
    sort: { field: "position", direction: "asc" },
  } as const;

  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    setApiInstance({
      createComment: vi.fn().mockResolvedValue({
        id: "comment-1",
        issue_id: ISSUE_ID,
        author_type: "member",
        author_id: "user-1",
        content: "hello",
        type: "comment",
        parent_id: null,
        reactions: [],
        attachments: [],
        created_at: "2026-08-19T00:00:00Z",
        updated_at: "2026-08-19T00:00:00Z",
        resolved_at: null,
        resolved_by_type: null,
        resolved_by_id: null,
        issue_revision: 7,
      }),
    } as unknown as ApiClient);
  });

  afterEach(() => {
    qc.clear();
    vi.restoreAllMocks();
  });

  it("refreshes producer attachment choices after a local comment binds uploads without invalidating fixed version bodies", async () => {
    const choices = cockpitArtifactKeys.sourceAttachments(WS_ID, "artifact-1");
    const fixed = cockpitArtifactKeys.version(WS_ID, "artifact-1", "version-1");
    qc.setQueryData(choices, { items: [] });
    qc.setQueryData(fixed, { content: "Fixed evidence" });
    const { result } = renderHook(() => useCreateComment(ISSUE_ID), { wrapper: createWrapper(qc) });
    await act(async () => { await result.current.mutateAsync({ content: "Report attached", attachmentIds: ["file-1"] }); });
    expect(qc.getQueryState(choices)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(fixed)?.isInvalidated).toBe(false);
  });

  it("appends the created comment even when non-row table caches are loaded", async () => {
    qc.setQueryData<TimelineEntry[]>(issueKeys.timeline(ISSUE_ID), []);
    // Grouped rows are an infinite cache and facets a plain object — both live
    // under the `table-query` prefix next to the row pages, and neither has a
    // `rows` array.
    qc.setQueryData(issueKeys.tableGroups(WS_ID, tableQuery, { kind: "status" }), {
      pages: [
        { query_fingerprint: "sha256:groups", total: 0, groups: [], next_cursor: null },
      ],
      pageParams: [null],
    });
    qc.setQueryData(
      issueKeys.tableFacets(WS_ID, { query: tableQuery, facets: [{ kind: "status" }] }),
      { query_fingerprint: "sha256:facets", total: 0, facets: [] },
    );

    const { result } = renderHook(() => useCreateComment(ISSUE_ID), {
      wrapper: createWrapper(qc),
    });

    await act(async () => {
      await result.current.mutateAsync({ content: "hello" });
    });

    expect(
      qc.getQueryData<TimelineEntry[]>(issueKeys.timeline(ISSUE_ID))?.map((e) => e.id),
    ).toEqual(["comment-1"]);
  });
});
