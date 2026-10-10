import { normalizeStatusPatch } from "./status-category";
import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { api } from "../api";
import { invalidateCockpitArtifactSourceAttachments } from "../cockpit/artifact-queries";
import { issueKeys } from "./queries";
import { invalidateIssueOperationBasis } from "./operation-basis";
import { issueBatchAppliedIds, issueBatchErrorReceipt } from "./batch-receipt";
import { projectKeys } from "../projects/queries";
import {
  cancelInboxLists,
  isInboxListRequestInFlight,
  onInboxInvalidate,
} from "../inbox/ws-updaters";
import {
  applyIssueChange,
  invalidateIssueDerivatives,
  invalidateLastActivitySortedIssueLists,
  invalidateStaleListKeys,
  rollbackIssueChange,
} from "./cache-coordinator";
import { issueChangedDims } from "./surface/membership";
import { addIssueToBuckets } from "./cache-helpers";
import {
  cleanupDeletedIssueCaches,
  collectDeletedIssueCacheMetadata,
  invalidateDeletedIssueDependentCaches,
  invalidateDeletedIssueParentCaches,
} from "./delete-cache";
import { useWorkspaceId } from "../hooks";
import { useRecentContextStore } from "../chat/recent-context-store";
import { useRecentIssuesStore } from "./stores";
import type { Issue, IssueReaction, IssueBatchReceipt } from "../types";
import type {
  CreateCommentSubIssueManualRequest,
  CreateIssueRequest,
  ListIssuesCache,
  MoveIssueRequest,
  UpdateIssueRequest,
} from "../types";
import type { TimelineEntry, IssueSubscriber, Reaction } from "../types";
import { sortTimelineEntriesAsc } from "./timeline-sort";
import { applyCommentDeletion, removeCommentSubtree } from "./comment-deletion";
import { configStore } from "../config";
import {
  onIssueAuxiliaryRevision,
  invalidateIssueOwnerProjections,
  reconcileIssueFullSnapshotRevision,
} from "./ws-updaters";

// ---------------------------------------------------------------------------
// Shared mutation variable types — used by both mutation hooks and
// useMutationState consumers to keep the type assertion in sync.
// ---------------------------------------------------------------------------

export type ToggleCommentReactionVars = {
  commentId: string;
  emoji: string;
  existing: Reaction | undefined;
};

export type ToggleIssueReactionVars = {
  emoji: string;
  existing: IssueReaction | undefined;
};

export type UpdateIssueMutationInput = {
  id: string;
  /**
   * Present only for drag/drop. `position` remains in the optimistic patch,
   * while the request sent to the server contains relative anchors instead.
   */
  move_intent?: Pick<MoveIssueRequest, "before_id" | "after_id">;
} & UpdateIssueRequest;

// ---------------------------------------------------------------------------
// Per-status pagination
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Issue CRUD
// ---------------------------------------------------------------------------

// Shared by the single and batch update hooks, so the inbox re-read can wait
// for the last of them (see `owedInboxRereads`).
const ISSUE_WRITE = "issue-write";
const issueWriteMutationKey = (wsId: string) => [ISSUE_WRITE, wsId] as const;

// Workspaces whose inbox lists owe a re-read, per client.
const inboxRereadsOwed = new WeakMap<QueryClient, Set<string>>();

// A client's owed re-reads, each paid once its workspace has no issue write
// left in flight. Issued earlier, the re-read could read a pending write's old
// value and land after that write's patch, reverting a saved change. The check
// runs when a write reaches its terminal state, not in onSettled: TanStack
// calls onSettled while the mutation still counts as pending, so two writes
// settling in the same tick would each count the other and both skip
// (MUL-7286).
function owedInboxRereads(qc: QueryClient): Set<string> {
  const existing = inboxRereadsOwed.get(qc);
  if (existing) return existing;
  const owed = new Set<string>();
  inboxRereadsOwed.set(qc, owed);
  qc.getMutationCache().subscribe((event) => {
    if (event.type !== "updated") return;
    if (event.action.type !== "success" && event.action.type !== "error") return;
    const [kind, wsId] = event.mutation.options.mutationKey ?? [];
    if (kind !== ISSUE_WRITE || typeof wsId !== "string") return;
    if (!owed.has(wsId)) return;
    if (qc.isMutating({ mutationKey: issueWriteMutationKey(wsId) }) > 0) return;
    owed.delete(wsId);
    void onInboxInvalidate(qc, wsId);
  });
  return owed;
}

// Inbox side of settling a status / priority write. It patched the inbox rows
// optimistically, so the lists owe a re-read only when the write left them
// behind the server: onMutate interrupted one of their requests (see
// `cancelInboxLists`), a failure restored their rollback snapshot, or a list
// request is still out and may have read the server before this write
// committed. Otherwise the patch was the whole change, and no request is added.
function settleInboxAfterIssueWrite(
  qc: QueryClient,
  wsId: string,
  // Set by onMutate for status / priority writes only.
  inboxWrite: { interrupted: boolean } | undefined,
  failed: boolean,
) {
  if (!inboxWrite) return;
  if (inboxWrite.interrupted || failed || isInboxListRequestInFlight(qc, wsId)) {
    owedInboxRereads(qc).add(wsId);
  }
}

function useIssueCreateMutation<TVariables>(
  mutationFn: (variables: TVariables) => Promise<Issue>,
) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn,
    onSuccess: (newIssue) => {
      for (const [key, data] of qc.getQueriesData<ListIssuesCache>({ queryKey: issueKeys.list(wsId) })) {
        if (data) qc.setQueryData<ListIssuesCache>(key, addIssueToBuckets(data, newIssue));
      }
      // Surface the just-created issue in cmd+k's Recent list without
      // requiring the user to open it first.
      useRecentIssuesStore.getState().recordVisit(wsId, newIssue.id);
      // Invalidate parent's children query so sub-issues list updates immediately
      if (newIssue.parent_issue_id) {
        qc.invalidateQueries({ queryKey: issueKeys.children(wsId, newIssue.parent_issue_id) });
        qc.invalidateQueries({ queryKey: issueKeys.childProgress(wsId) });
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: issueKeys.list(wsId) });
      qc.invalidateQueries({ queryKey: issueKeys.flatAll(wsId) });
      qc.invalidateQueries({ queryKey: issueKeys.tableAll(wsId) });
      qc.invalidateQueries({ queryKey: issueKeys.assigneeGroupsAll(wsId) });
      qc.invalidateQueries({ queryKey: issueKeys.myAssigneeGroupsAll(wsId) });
      qc.invalidateQueries({ queryKey: issueKeys.projectGanttAll(wsId) });
      qc.invalidateQueries({ queryKey: projectKeys.all(wsId) });
    },
  });
}

export function useCreateIssue() {
  return useIssueCreateMutation((data: CreateIssueRequest) => api.createIssue(data));
}

export function useCreateCommentSubIssue() {
  return useIssueCreateMutation(({
    anchorCommentId,
    data,
  }: {
    anchorCommentId: string;
    data: CreateCommentSubIssueManualRequest;
  }) => api.createCommentSubIssue(anchorCommentId, data));
}

export function useUpdateIssue() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationKey: issueWriteMutationKey(wsId),
    mutationFn: ({ id, move_intent: moveIntent, ...data }: UpdateIssueMutationInput) => {
      if (!moveIntent) return api.updateIssue(id, data);
      const { position: _optimisticPosition, ...target } = data;
      return api.moveIssue(id, { ...target, ...moveIntent });
    },
    onMutate: ({ id, move_intent: _moveIntent, ...data }) => {
      // suppress_run is a write-time control field, not an Issue column.
      // description_base is merge metadata, while description itself
      // is resolved against that base on the server and therefore is not safe
      // to predict optimistically. Keep the authoritative raw description in
      // cache so hidden channel-media markers remain available as the base for
      // a rapid follow-up edit. mutationFn still sends the full payload.
      const {
        suppress_run: _suppressRun,
        duplicate_of_issue_id: _duplicateOfIssueId,
        description: _description,
        description_base: _descriptionBase,
        title_base: _titleBase,
        expected_revision: _expectedRevision,
        ...patch
      } = data;
      // Fire-and-forget cancelQueries — keeps onMutate synchronous so the
      // cache update happens in the same tick as mutate(). Awaiting would
      // yield to the event loop, letting @dnd-kit reset its visual state
      // before the optimistic update lands.
      qc.cancelQueries({ queryKey: issueKeys.list(wsId) });
      qc.cancelQueries({ queryKey: issueKeys.myAll(wsId) });
      qc.cancelQueries({ queryKey: issueKeys.flatAll(wsId) });
      qc.cancelQueries({ queryKey: issueKeys.tableAll(wsId) });
      const inboxWrite =
        patch.status !== undefined || patch.priority !== undefined
          ? { interrupted: cancelInboxLists(qc, wsId) }
          : undefined;
      const prevDetail = qc.getQueryData<Issue>(issueKeys.detail(wsId, id));
      // The coordinator owns the cross-cache rules: surgical patch/rebucket
      // where the card is loaded and still belongs, surgical REMOVE where the
      // change moves it off a filtered surface, stale-key bookkeeping where
      // the server result may have drifted (invalidated on settle, not here —
      // a mid-flight refetch would stomp the optimistic state).
      const change = applyIssueChange(qc, wsId, id, patch as Partial<Issue>, {
        changed: issueChangedDims(patch, prevDetail),
        baseIssue: prevDetail,
      });

      // Resolve parent_issue_id from the freshest source so we can keep the
      // parent's children cache in sync (used by the parent issue's
      // sub-issues list). Falls back to scanning loaded children caches —
      // when the user navigates straight to a parent's detail page, the
      // child may live only there, not in detail/list.
      let parentId: string | null =
        prevDetail?.parent_issue_id ??
        change.prevIssue?.parent_issue_id ??
        null;
      if (!parentId) {
        const childrenCaches = qc.getQueriesData<Issue[]>({
          queryKey: [...issueKeys.all(wsId), "children"],
        });
        for (const [key, data] of childrenCaches) {
          if (!data?.some((c) => c.id === id)) continue;
          const candidate = key[key.length - 1];
          if (typeof candidate === "string") {
            parentId = candidate;
            break;
          }
        }
      }
      const prevChildren = parentId
        ? qc.getQueryData<Issue[]>(issueKeys.children(wsId, parentId))
        : undefined;

      if (parentId) {
        // When the write re-parents this issue away from `parentId` (detach
        // to standalone, or move under a different parent), prune it from the
        // old parent's children cache. The parent's sub-issues list renders
        // that array directly, so a bare patch to parent_issue_id: null would
        // leave an orphaned row in the list until the settle refetch lands.
        // onError restores prevChildren, so the prune rolls back on failure.
        const detachedFromParent =
          Object.prototype.hasOwnProperty.call(patch, "parent_issue_id") &&
          patch.parent_issue_id !== parentId;
        qc.setQueryData<Issue[]>(
          issueKeys.children(wsId, parentId),
          (old) =>
            detachedFromParent
              ? old?.filter((c) => c.id !== id)
              : old?.map((c) => (c.id === id ? { ...c, ...normalizeStatusPatch(patch) } : c)),
        );
      }
      return { change, prevChildren, parentId, id, inboxWrite };
    },
    onError: (_err, vars, ctx) => {
      if (ctx) {
        rollbackIssueChange(qc, wsId, ctx.id, ctx.change);
      }
      if (ctx?.parentId && ctx.prevChildren !== undefined) {
        qc.setQueryData(
          issueKeys.children(wsId, ctx.parentId),
          ctx.prevChildren,
        );
      }
      // A remote revision may have landed through WS after onMutate captured
      // its rollback snapshot. Restoring that snapshot on any failed request
      // can therefore transiently put an older entity back into cache; refresh
      // every loaded owner projection after rollback. A revision conflict is
      // the common case, but transport/5xx failures have the same interleave.
      qc.invalidateQueries({ queryKey: issueKeys.detail(wsId, vars.id) });
      qc.invalidateQueries({ queryKey: issueKeys.list(wsId) });
      qc.invalidateQueries({ queryKey: issueKeys.myAll(wsId) });
      qc.invalidateQueries({ queryKey: issueKeys.flatAll(wsId) });
      qc.invalidateQueries({ queryKey: issueKeys.tableAll(wsId) });
    },
    onSuccess: (serverIssue, vars) => {
      // Reconcile with the authoritative server entity by patching the one card
      // in place — NOT by invalidating + refetching the list. The list refetch
      // is what made a successful move flicker: the optimistic card was already
      // in the right place, then the refetch replaced the whole column and the
      // card re-landed. updateIssue returns the full issue and a position update
      // touches only that row, so a surgical patch is the authoritative
      // reconcile and is a visual no-op when the optimistic value matched.
      //
      // baseIssue = serverIssue: membership moves were already handled
      // optimistically; against the post-write entity the changed dims come
      // out false unless the server coerced a different value, so this pass
      // is the plain surgical patch it always was.
      const {
        suppress_run: _suppressRun,
        duplicate_of_issue_id: _duplicateOfIssueId,
        description_base: _descriptionBase,
        move_intent: _moveIntent,
        id: _id,
        ...intent
      } = vars;
      // Drop `properties` from the reconcile payload: the bag is owned by the
      // property mutation pipeline (single-key atomic writes + its own
      // optimistic state). An UpdateIssue snapshot taken before a concurrent
      // property write resolves would otherwise overwrite the newer bag
      // (clean-room review F3 response-ordering race).
      const { properties: _staleBag, ...reconcilable } = serverIssue;
      const reconcile = applyIssueChange(qc, wsId, serverIssue.id, reconcilable as typeof serverIssue, {
        changed: issueChangedDims(intent, serverIssue),
        baseIssue: serverIssue,
        // The HTTP response can arrive after a newer WS event. Reconcile the
        // committed snapshot only into projections that have not already
        // advanced beyond it; otherwise an older successful response would
        // undo a later remote write in cache.
        acceptCurrent: (current) =>
          current.revision === undefined ||
          (serverIssue.revision !== undefined &&
            serverIssue.revision > current.revision),
      });
      reconcileIssueFullSnapshotRevision(
        qc,
        wsId,
        serverIssue.id,
        serverIssue.revision,
      );
      // The server has committed — safe to flush any drift it reported now.
      invalidateStaleListKeys(qc, reconcile.staleKeys);
    },
    onSettled: (_data, err, vars, ctx) => {
      settleInboxAfterIssueWrite(qc, wsId, ctx?.inboxWrite, err !== null);
      invalidateIssueOperationBasis(qc, wsId);
      // The issue's own list + detail caches are reconciled surgically in
      // onSuccess / onError, so they are deliberately NOT invalidated here — a
      // full-list refetch on settle is what made drags flicker. Only aggregate
      // caches that cannot be patched from a single issue are refreshed, plus
      // the specific list keys the coordinator flagged as drifted (unknown
      // membership, enter/leave beyond the loaded window, bucket-count drift).
      // Those stale keys are the surgical replacement for the old blanket
      // "invalidate myAll on project move" safety net (MUL-3669 / #4548): the
      // old project's loaded list already had the card removed in onMutate,
      // and only genuinely undecidable lists refetch here.
      invalidateIssueDerivatives(qc, wsId, {
        statusOrProjectChanged:
          vars.status !== undefined ||
          Object.prototype.hasOwnProperty.call(vars, "project_id"),
      });
      qc.invalidateQueries({ queryKey: issueKeys.tableAll(wsId) });
      if (ctx) {
        invalidateStaleListKeys(qc, ctx.change.staleKeys);
      }
      // Refresh the issue's attachments cache when the description editor
      // bound new uploads — the description editor reads `issueAttachments`
      // to resolve text-preview Eye gates, and unlike other mutations this
      // payload mutates the attachment join table.
      if (vars.attachment_ids?.length) {
        qc.invalidateQueries({ queryKey: issueKeys.attachments(vars.id) });
        invalidateCockpitArtifactSourceAttachments(qc, wsId, vars.id);
      }
      // A duplicate mark is not on Issue; refresh both sides now rather than
      // waiting for the realtime echo.
      if (vars.duplicate_of_issue_id) {
        qc.invalidateQueries({ queryKey: issueKeys.duplicates(wsId, vars.id) });
        qc.invalidateQueries({
          queryKey: issueKeys.duplicates(wsId, vars.duplicate_of_issue_id),
        });
      }
      // Invalidate old parent's children cache
      if (ctx?.parentId) {
        qc.invalidateQueries({
          queryKey: issueKeys.children(wsId, ctx.parentId),
        });
        qc.invalidateQueries({ queryKey: issueKeys.childProgress(wsId) });
      }
      // Invalidate new parent's children cache when parent_issue_id changed
      const newParentId = vars.parent_issue_id;
      if (newParentId && newParentId !== ctx?.parentId) {
        qc.invalidateQueries({
          queryKey: issueKeys.children(wsId, newParentId),
        });
        qc.invalidateQueries({ queryKey: issueKeys.childProgress(wsId) });
      }
      // Invalidate the batched-children cache only when the parent link
      // actually changed. The WS path (ws-updaters.ts) invalidates
      // unconditionally because it doesn't know what the server change
      // touched; here onMutate already patched issueKeys.children(parent)
      // optimistically, so we only need to flush when the parent relation
      // itself moved.
      if (ctx?.parentId || newParentId) {
        qc.invalidateQueries({ queryKey: issueKeys.childrenByParentsAll(wsId) });
      }
    },
  });
}

function invalidateIssueBatchViews(qc: QueryClient, wsId: string) {
  for (const queryKey of [issueKeys.list(wsId), issueKeys.myAll(wsId), issueKeys.flatAll(wsId), issueKeys.tableAll(wsId),
    issueKeys.assigneeGroupsAll(wsId), issueKeys.myAssigneeGroupsAll(wsId), issueKeys.projectGanttAll(wsId),
    issueKeys.childrenByParentsAll(wsId), issueKeys.childProgress(wsId), projectKeys.all(wsId)]) {
    void qc.invalidateQueries({ queryKey });
  }
  invalidateIssueOperationBasis(qc, wsId);
}

export function useDeleteIssue() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationKey: ["deleteIssue", wsId],
    mutationFn: (id: string) => api.deleteIssue(wsId, id),
    // Keep the visible object and all dependent state until the server confirms deletion.
    onMutate: (id) => ({ metadata: collectDeletedIssueCacheMetadata(qc, wsId, id) }),
    onSuccess: (_data, id, ctx) => {
      useRecentContextStore.getState().forgetContext(wsId, { type: "issue", id });
      cleanupDeletedIssueCaches(qc, wsId, id, ctx?.metadata);
    },
    onSettled: (_data, err, id, ctx) => {
      invalidateIssueBatchViews(qc, wsId);
      if (ctx?.metadata) invalidateDeletedIssueParentCaches(qc, wsId, ctx.metadata);
      if (err) void qc.invalidateQueries({ queryKey: issueKeys.detail(wsId, id) });
    },
  });
}

export type BatchUpdateIssuesInput = {
  ids: string[];
  updates: UpdateIssueRequest;
  expected_revisions?: Record<string, number>;
};
export type BatchDeleteIssuesInput = {
  ids: string[];
  expected_revisions?: Record<string, number>;
};

export function useBatchUpdateIssues() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationKey: issueWriteMutationKey(wsId),
    mutationFn: ({ ids, updates, expected_revisions }: BatchUpdateIssuesInput) =>
      api.batchUpdateIssues(wsId, ids, updates, { expected_revisions }),
    onMutate: ({ ids, updates }) => ({
      metadata: ids.map((id) => collectDeletedIssueCacheMetadata(qc, wsId, id)),
      // This batch does not patch server facts. Both success and partial/unknown
      // failure owe a server read, paid after all concurrent issue writes settle.
      inboxWrite: updates.status !== undefined || updates.priority !== undefined ? { interrupted: true } : undefined,
    }),
    onSettled: (_receipt, err, vars, ctx) => {
      settleInboxAfterIssueWrite(qc, wsId, ctx?.inboxWrite, err !== null);
      invalidateIssueBatchViews(qc, wsId);
      invalidateIssueDerivatives(qc, wsId, {
        statusOrProjectChanged: vars.updates.status !== undefined || Object.prototype.hasOwnProperty.call(vars.updates, "project_id"),
      });
      const ids = new Set(vars.ids);
      void qc.invalidateQueries({ queryKey: issueKeys.all(wsId), predicate: (query) =>
        query.queryKey[2] === "detail" && typeof query.queryKey[3] === "string" && ids.has(query.queryKey[3]) });
      const parents = new Set(ctx?.metadata.flatMap((entry) => entry.parentIssueIds) ?? []);
      if (vars.updates.parent_issue_id) parents.add(vars.updates.parent_issue_id);
      for (const parentId of parents) void qc.invalidateQueries({ queryKey: issueKeys.children(wsId, parentId) });
    },
  });
}

export function useBatchDeleteIssues() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  const acknowledge = (receipt: IssueBatchReceipt | null, metadata?: Map<string, ReturnType<typeof collectDeletedIssueCacheMetadata>>) => {
    for (const id of issueBatchAppliedIds(receipt)) {
      useRecentContextStore.getState().forgetContext(wsId, { type: "issue", id });
      cleanupDeletedIssueCaches(qc, wsId, id, metadata?.get(id));
    }
  };
  return useMutation({
    mutationKey: ["batchDeleteIssues", wsId],
    mutationFn: ({ ids, expected_revisions }: BatchDeleteIssuesInput) => api.batchDeleteIssues(wsId, ids, { expected_revisions }),
    onMutate: ({ ids }) => ({ metadata: new Map(ids.map((id) => [id, collectDeletedIssueCacheMetadata(qc, wsId, id)])) }),
    onSuccess: (receipt, _vars, ctx) => acknowledge(receipt, ctx?.metadata),
    onError: (error, vars, ctx) => acknowledge(issueBatchErrorReceipt(error, wsId, vars.ids, "delete"), ctx?.metadata),
    onSettled: (_receipt, err, vars, ctx) => {
      invalidateIssueBatchViews(qc, wsId);
      invalidateDeletedIssueDependentCaches(qc, wsId);
      const parentIssueIds = [...new Set([...(ctx?.metadata.values() ?? [])].flatMap((entry) => entry.parentIssueIds))];
      invalidateDeletedIssueParentCaches(qc, wsId, { parentIssueIds });
      if (err) {
        const ids = new Set(vars.ids);
        void qc.invalidateQueries({ queryKey: issueKeys.all(wsId), predicate: (query) =>
          query.queryKey[2] === "detail" && typeof query.queryKey[3] === "string" && ids.has(query.queryKey[3]) });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Comments / Timeline
// ---------------------------------------------------------------------------

type TimelineCache = TimelineEntry[];

export function useCreateComment(issueId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({
      content,
      type,
      parentId,
      attachmentIds,
      suppressAgentIds,
      steerTaskIds,
    }: {
      content: string;
      type?: string;
      parentId?: string;
      attachmentIds?: string[];
      suppressAgentIds?: string[];
      /** Running turns this comment goes into instead of a follow-up run. */
      steerTaskIds?: string[];
    }) => api.createComment(issueId, content, type, parentId, attachmentIds, suppressAgentIds, steerTaskIds),
    onSuccess: (comment, variables) => {
      if (variables.attachmentIds?.length) invalidateCockpitArtifactSourceAttachments(qc, wsId, issueId);
      if (comment.issue_revision) {
        onIssueAuxiliaryRevision(qc, wsId, issueId, comment.issue_revision);
      } else {
        invalidateIssueOwnerProjections(qc, wsId, issueId);
      }
      invalidateLastActivitySortedIssueLists(qc, wsId);
      const entry: TimelineEntry = {
        type: "comment",
        id: comment.id,
        actor_type: comment.author_type,
        actor_id: comment.author_id,
        content: comment.content,
        parent_id: comment.parent_id,
        comment_type: comment.type,
        reactions: comment.reactions ?? [],
        attachments: comment.attachments ?? [],
        created_at: comment.created_at,
        updated_at: comment.updated_at,
        supplements: comment.supplements,
      };
      const steered = !!comment.supplements?.length;
      // Dedupe by id: the `comment:created` WS event may have already added
      // this entry from the broadcast path before this onSuccess fires. Skip
      // the append if the entry is already in the cache — but keep the
      // steering receipts, which that broadcast predates.
      qc.setQueryData<TimelineCache>(issueKeys.timeline(issueId), (old) => {
        if (!old) return [entry];
        if (old.some((e) => e.id === entry.id)) {
          return steered
            ? old.map((e) => (e.id === entry.id && !e.supplements?.length ? { ...e, supplements: entry.supplements } : e))
            : old;
        }
        return sortTimelineEntriesAsc([...old, entry]);
      });
      // A steered turn now lists this comment among its inputs.
      if (steered) qc.invalidateQueries({ queryKey: issueKeys.tasks(issueId) });
      // Posting a comment changes the trigger answer itself (the enqueued
      // task now dedupes follow-up triggers), so cached previews for this
      // issue are stale the moment the create lands.
      qc.invalidateQueries({ queryKey: issueKeys.commentTriggerPreview(issueId) });
    },
    // No onSettled invalidate. The `comment:created` WS broadcast keeps
    // the timeline cache fresh after a successful create, and reconnect
    // recovery in useIssueTimeline already invalidates if the connection
    // dropped. Re-fetching on every submit replaces every entry's
    // reference, which forces every memoized CommentCard subtree to
    // re-render (visible as a flash across sibling threads during AI
    // streaming).
  });
}

export function useUpdateComment(issueId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({
      commentId,
      content,
      attachmentIds,
      suppressAgentIds,
      contentBase,
      expectedRevision,
    }: {
      commentId: string;
      content: string;
      attachmentIds: string[];
      suppressAgentIds?: string[];
      contentBase?: string;
      expectedRevision?: number;
    }) => api.updateComment(commentId, content, attachmentIds, suppressAgentIds, contentBase, expectedRevision),
    onMutate: async ({ commentId, content, attachmentIds }) => {
      await qc.cancelQueries({ queryKey: issueKeys.timeline(issueId) });
      const prev = qc.getQueryData<TimelineCache>(issueKeys.timeline(issueId));
      const kept = new Set(attachmentIds);
      qc.setQueryData<TimelineCache>(issueKeys.timeline(issueId), (old) =>
        old?.map((e) =>
          e.id === commentId
            ? { ...e, content, attachments: e.attachments?.filter((a) => kept.has(a.id)) }
            : e,
        ),
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev !== undefined) {
        qc.setQueryData(issueKeys.timeline(issueId), ctx.prev);
      }
    },
    onSuccess: (comment) => {
      if (comment.issue_revision) {
        onIssueAuxiliaryRevision(qc, wsId, issueId, comment.issue_revision);
      } else {
        // Mixed-version fallback: an older backend may have committed the
        // aggregate revision without returning it.
        invalidateIssueOwnerProjections(qc, wsId, issueId);
      }
      invalidateLastActivitySortedIssueLists(qc, wsId);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: issueKeys.timeline(issueId) });
    },
  });
}

export function useDeleteComment(issueId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    // The capability is read when the delete runs, so the route matches the
    // copy the confirmation showed. Older servers delete the replies too.
    mutationFn: async (commentId: string) => {
      const keepReplies = configStore.getState().commentDeleteKeepRepliesSupported;
      await api.deleteComment(commentId, { keepReplies });
      return keepReplies;
    },
    // Not optimistic: whether the comment disappears or stays as a tombstone
    // depends on replies only the server sees for certain (#8296). Once it
    // confirms, mirror its outcome; realtime events and the settle refetch
    // reconcile the rest.
    onSuccess: (keptReplies, commentId) => {
      qc.setQueryData<TimelineCache>(issueKeys.timeline(issueId), (old) => {
        if (!old) return old;
        return keptReplies
          ? applyCommentDeletion(old, commentId, new Date().toISOString())
          : removeCommentSubtree(old, commentId);
      });
      // The endpoint remains 204 for compatibility, so the local caller has
      // no body carrying issue_revision. The realtime event will narrow this
      // with its revision when connected; this is the no-WS safety net.
      invalidateIssueOwnerProjections(qc, wsId, issueId);
      invalidateLastActivitySortedIssueLists(qc, wsId);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: issueKeys.timeline(issueId) });
    },
  });
}

// Every comment id in the same thread as `commentId` — the thread root plus
// every descendant. Mirrors the server's thread walk in
// ClearOtherThreadResolutions so the resolve optimistic update can clear sibling
// resolutions exactly as the backend will, instead of briefly showing two
// resolutions until the refetch settles.
function collectThreadCommentIds(
  entries: TimelineCache,
  commentId: string,
): Set<string> {
  const byId = new Map<string, TimelineEntry>();
  for (const e of entries) {
    if (e.type === "comment") byId.set(e.id, e);
  }
  // Walk up to the thread root (cycle-guarded against malformed parent chains).
  let rootId = commentId;
  const guard = new Set<string>();
  let cur = byId.get(commentId);
  while (cur?.parent_id && byId.has(cur.parent_id) && !guard.has(cur.id)) {
    guard.add(cur.id);
    rootId = cur.parent_id;
    cur = byId.get(cur.parent_id);
  }
  // Expand back down over the whole subtree.
  const childrenByParent = new Map<string, string[]>();
  for (const e of byId.values()) {
    if (e.parent_id) {
      const list = childrenByParent.get(e.parent_id) ?? [];
      list.push(e.id);
      childrenByParent.set(e.parent_id, list);
    }
  }
  const ids = new Set<string>([rootId]);
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const child of childrenByParent.get(id) ?? []) {
      if (!ids.has(child)) {
        ids.add(child);
        stack.push(child);
      }
    }
  }
  return ids;
}

export function useResolveComment(issueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ commentId, resolved }: { commentId: string; resolved: boolean }) =>
      resolved ? api.resolveComment(commentId) : api.unresolveComment(commentId),
    onMutate: async ({ commentId, resolved }) => {
      await qc.cancelQueries({ queryKey: issueKeys.timeline(issueId) });
      const prev = qc.getQueryData<TimelineCache>(issueKeys.timeline(issueId));
      qc.setQueryData<TimelineCache>(issueKeys.timeline(issueId), (old) => {
        if (!old) return old;
        // Resolving makes this comment the sole resolution in its thread, so
        // mirror the server (ClearOtherThreadResolutions) and clear every other
        // resolution in the same thread. Without this the cache shows two
        // resolutions until the settle refetch, which is exactly the flash the
        // single-resolution fix removes. Unresolve only clears its own row.
        const threadIds = resolved ? collectThreadCommentIds(old, commentId) : null;
        return old.map((e) => {
          if (e.id === commentId) {
            return {
              ...e,
              resolved_at: resolved ? new Date().toISOString() : null,
              resolved_by_type: resolved ? e.resolved_by_type ?? null : null,
              resolved_by_id: resolved ? e.resolved_by_id ?? null : null,
            };
          }
          if (resolved && e.resolved_at && threadIds?.has(e.id)) {
            return { ...e, resolved_at: null, resolved_by_type: null, resolved_by_id: null };
          }
          return e;
        });
      });
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev !== undefined) {
        qc.setQueryData(issueKeys.timeline(issueId), ctx.prev);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: issueKeys.timeline(issueId) });
    },
  });
}

export function useToggleCommentReaction(issueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["toggleCommentReaction", issueId] as const,
    mutationFn: async ({
      commentId,
      emoji,
      existing,
    }: ToggleCommentReactionVars) => {
      if (existing) {
        await api.removeReaction(commentId, emoji);
        return null;
      }
      return api.addReaction(commentId, emoji);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: issueKeys.timeline(issueId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Issue-level Reactions
// ---------------------------------------------------------------------------

export function useToggleIssueReaction(issueId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationKey: ["toggleIssueReaction", issueId] as const,
    mutationFn: async ({
      emoji,
      existing,
    }: ToggleIssueReactionVars) => {
      if (existing) {
        await api.removeIssueReaction(issueId, emoji);
        return null;
      }
      return api.addIssueReaction(issueId, emoji);
    },
    onSuccess: (reaction) => {
      onIssueAuxiliaryRevision(qc, wsId, issueId, reaction?.issue_revision);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: issueKeys.reactions(issueId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Issue Subscribers
// ---------------------------------------------------------------------------

export function useToggleIssueSubscriber(issueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      userId,
      userType,
      subscribed,
    }: {
      userId: string;
      userType: "member" | "agent";
      subscribed: boolean;
    }) => {
      if (subscribed) {
        await api.unsubscribeFromIssue(issueId, userId, userType);
      } else {
        await api.subscribeToIssue(issueId, userId, userType);
      }
    },
    onMutate: async ({ userId, userType, subscribed }) => {
      await qc.cancelQueries({ queryKey: issueKeys.subscribers(issueId) });
      const prev = qc.getQueryData<IssueSubscriber[]>(
        issueKeys.subscribers(issueId),
      );

      if (subscribed) {
        qc.setQueryData<IssueSubscriber[]>(
          issueKeys.subscribers(issueId),
          (old) =>
            old?.filter(
              (s) => !(s.user_id === userId && s.user_type === userType),
            ),
        );
      } else {
        const temp: IssueSubscriber = {
          issue_id: issueId,
          user_type: userType,
          user_id: userId,
          reason: "manual",
          created_at: new Date().toISOString(),
        };
        qc.setQueryData<IssueSubscriber[]>(
          issueKeys.subscribers(issueId),
          (old) => {
            if (
              old?.some(
                (s) => s.user_id === userId && s.user_type === userType,
              )
            )
              return old;
            return [...(old ?? []), temp];
          },
        );
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev)
        qc.setQueryData(issueKeys.subscribers(issueId), ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: issueKeys.subscribers(issueId) });
    },
  });
}

/**
 * Leave an issue AND its whole sub-tree (MUL-5483). Not optimistic: it writes
 * to an unknown number of other issues' subscriber lists, so there is nothing
 * determinate to patch — invalidate every subscriber query instead and let the
 * server be the source of truth.
 */
export function useUnsubscribeFromIssueSubtree(issueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      userId,
      userType,
    }: {
      userId: string;
      userType: "member" | "agent";
    }) => {
      await api.unsubscribeFromIssueSubtree(issueId, userId, userType);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: issueKeys.subscribersAll() });
    },
  });
}

export function useCancelIssueRun(issueId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => api.cancelTask(issueId, taskId),
    onSuccess: () => client.invalidateQueries({ queryKey: issueKeys.tasks(issueId) }),
  });
}

export function useRetryTaskSupplement(issueId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, commentId }: { taskId: string; commentId: string }) =>
      api.retryTaskSupplement(issueId, taskId, commentId),
    onSettled: () => {
      client.invalidateQueries({ queryKey: issueKeys.timeline(issueId) });
      client.invalidateQueries({ queryKey: issueKeys.tasks(issueId) });
    },
  });
}

export function useRetryIssueRun(issueId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => api.rerunIssue(issueId, taskId),
    onSuccess: () => client.invalidateQueries({ queryKey: issueKeys.tasks(issueId) }),
  });
}
