"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { cn } from "@multica/ui/lib/utils";
import { api } from "@multica/core/api";
import {
  chatKeys,
  isTaskMessageTaskId,
  taskMessagesOptions,
} from "@multica/core/chat/queries";
import { issueKeys } from "@multica/core/issues/queries";
import { useAgentProcessFoldStore } from "@multica/core/issues/stores";
import { useActorName } from "@multica/core/workspace/hooks";
import type { AgentTask } from "@multica/core/types";
import type { TaskMessagePayload } from "@multica/core/types/events";
import { AgentProcessFold } from "../../common/agent-process";
import { buildTimeline, type TimelineItem } from "../../common/task-transcript";
import { ActorAvatar } from "../../common/actor-avatar";
import { CancelTaskButton } from "./cancel-task-button";
import { useStatusLabel, useTriggerText } from "./task-run-labels";
import { useT } from "../../i18n";

// Watching the agent work, in the main column.
//
// The in-body live signal was deliberately removed once before — the sticky
// `agent-live-card.tsx` was deleted in a02b3dfb4 and replaced by the header
// chip, so the live state would stop competing with banners in this column.
// That decision stands for *status*. What it left behind is the gap this
// section fills: status is all the issue page ever showed. A first-time user
// watching an untouched issue for two minutes cannot tell a thinking agent
// from a hung one, and reads it as frozen. The process existed the whole time
// — behind a dialog nobody knew to open.
//
// So this is not the old card coming back. It is the process fold chat has
// always rendered, on the same shared `["task-messages", taskId]` cache
// useRealtimeSync streams `task:message` frames into, in two placements:
//
//   - LIVE (IssueLiveAgentProcess, between the timeline and the composer):
//     one card per active run, auto-expanded, appending in real time. It is
//     the last thing in the reading column, so a growing panel never shifts
//     the comments a reader is looking at, and it carries its own max-height
//     and scroll — the timeline above it is virtualized and document-shaped,
//     and must not be re-measured on every frame.
//   - SETTLED (IssueAgentProcessFold on an agent comment): the same fold,
//     collapsed, so the result stands alone but the process is one click away.
//     It sits above the answer, in the order the two actually happened; that
//     costs the reader nothing because a settled fold is one caption line.
//     It fetches nothing until opened — an issue with 40 agent comments must
//     not fire 40 transcript requests on mount.

/** Live process output is capped so the panel never grows past a screenful. */
const LIVE_PROCESS_MAX_HEIGHT = "22rem";

/**
 * Subscribe to a run's process timeline.
 *
 * Live runs mount the shared cache entry and let the WebSocket write it: the
 * `task:message` handler in useRealtimeSync only keeps frames for a task some
 * observer already holds an entry for (MUL-6396), so mounting this query is
 * what turns the stream on for this issue. `enabled: false` keeps React Query
 * from fetching on its own; the backfill below is the only fetch, and it runs
 * on mount and again when the run reaches a terminal state so a WS reconnect
 * gap — or the tail a finished run never re-broadcasts — cannot leave a hole.
 *
 * Settled runs stay disabled until the reader opens the fold, then fetch once.
 * `taskMessagesOptions` is `staleTime: Infinity`, so collapsing and re-opening
 * costs nothing.
 */
function useTaskProcessTimeline(
  taskId: string,
  { live, enabled }: { live: boolean; enabled: boolean },
): { items: TimelineItem[]; loading: boolean } {
  const queryClient = useQueryClient();
  const fetchable = enabled && isTaskMessageTaskId(taskId);

  const { data, isFetching } = useQuery({
    ...taskMessagesOptions(taskId),
    enabled: fetchable && !live,
  });

  // Live path: a manual, seq-merged backfill. `taskMessagesOptions` carries
  // `structuralSharing: unionTaskMessagesBySeq`, so this response folds into
  // whatever the stream already delivered instead of replacing it.
  useEffect(() => {
    if (!fetchable || !live) return;
    let cancelled = false;
    api
      .listTaskMessages(taskId)
      .then((msgs) => {
        if (cancelled) return;
        queryClient.setQueryData<TaskMessagePayload[]>(
          chatKeys.taskMessages(taskId),
          msgs,
        );
      })
      .catch((err) => {
        console.error(err);
      });
    return () => {
      cancelled = true;
    };
    // `live` is a dependency on purpose: the running → terminal transition
    // re-runs this and takes the final authoritative snapshot.
  }, [fetchable, live, queryClient, taskId]);

  const items = useMemo(() => buildTimeline(data ?? []), [data]);
  return { items, loading: isFetching && items.length === 0 };
}

/**
 * The reader's open/closed choice for one run's fold, over the default
 * (open while live, closed once settled). Kept in a store because a settled
 * fold lives inside the virtualized comment timeline and is unmounted the
 * moment it scrolls out of view.
 */
function useFoldOpenState(taskId: string, isLive: boolean) {
  const override = useAgentProcessFoldStore((s) => s.overrides.get(taskId));
  const setOverride = useAgentProcessFoldStore((s) => s.setOpen);
  const clearOverride = useAgentProcessFoldStore((s) => s.clearOverride);

  const wasLive = useRef(isLive);
  useEffect(() => {
    // On the live → settled edge, drop the override so the fold collapses to
    // its settled default even if the reader had opened it during the run.
    if (wasLive.current && !isLive) clearOverride(taskId);
    wasLive.current = isLive;
  }, [clearOverride, isLive, taskId]);

  const open = override ?? isLive;
  const setOpen = useCallback(
    (next: boolean) => setOverride(taskId, next),
    [setOverride, taskId],
  );
  return { open, setOpen };
}

interface IssueAgentProcessFoldProps {
  taskId: string;
  /** True while the run is still producing events. */
  isLive?: boolean;
  /** Pinned to the right of the fold bar — the live card puts its stop here. */
  triggerActions?: React.ReactNode;
  className?: string;
}

/**
 * One run's process fold. Lazy by default: a closed fold holds no query
 * observer, so an issue full of past agent comments costs nothing until the
 * reader asks for one.
 */
export function IssueAgentProcessFold({
  taskId,
  isLive = false,
  triggerActions,
  className,
}: IssueAgentProcessFoldProps) {
  const { t } = useT("issues");
  const { open, setOpen } = useFoldOpenState(taskId, isLive);

  const { items, loading } = useTaskProcessTimeline(taskId, {
    live: isLive,
    enabled: open || isLive,
  });

  return (
    <AgentProcessFold
      items={items}
      isStreaming={isLive}
      phase={isLive ? "streaming" : "settled"}
      open={open}
      onOpenChange={setOpen}
      // Before the first fetch there is no count, and "0 steps" would be a lie.
      triggerLabel={
        items.length === 0 ? t(($) => $.agent_process.view_process) : undefined
      }
      triggerSuffix={
        isLive ? (
          <span
            className="ml-1 h-1.5 w-1.5 shrink-0 rounded-full bg-info animate-pulse"
            aria-hidden="true"
          />
        ) : null
      }
      triggerActions={triggerActions}
      className={className}
      // Live output is capped and scrolls inside itself. Letting it grow would
      // re-measure the virtualized timeline above on every 500ms flush.
      contentClassName={isLive ? "overflow-y-auto" : undefined}
      contentStyle={isLive ? { maxHeight: LIVE_PROCESS_MAX_HEIGHT } : undefined}
      followOutput={isLive}
    >
      {loading && items.length === 0 ? (
        <ProcessHint label={t(($) => $.agent_process.loading)} />
      ) : items.length > 0 ? null : isLive ? (
        <ProcessHint label={t(($) => $.agent_process.starting)} />
      ) : (
        // A run that reported nothing — dispatch failed, or it was cancelled
        // before it started. Say so instead of hiding the fold the reader just
        // clicked: a control that vanishes on click reads as a broken one.
        <div className="py-0.5 text-caption text-muted-foreground">
          {t(($) => $.agent_process.empty)}
        </div>
      )}
    </AgentProcessFold>
  );
}

function ProcessHint({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-1.5 py-0.5 text-caption text-muted-foreground">
      <Loader2 className="h-3 w-3 animate-spin" />
      <span>{label}</span>
    </div>
  );
}

/**
 * The live block at the end of the reading column: one card per in-flight run,
 * each showing who is working and what they are doing right now.
 *
 * Reads the same `issueKeys.tasks(issueId)` cache as the header chip and the
 * right-panel Execution log, so all three agree on what is active — WS `task:*`
 * events invalidate it, no polling here.
 */
export function IssueLiveAgentProcess({
  issueId,
  className,
}: {
  issueId: string;
  className?: string;
}) {
  const { t } = useT("issues");
  const { getActorName } = useActorName();

  const { data: tasks = [] } = useQuery({
    queryKey: issueKeys.tasks(issueId),
    queryFn: () => api.listTasksByIssue(issueId),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  const activeTasks = useMemo(
    () =>
      tasks.filter(
        (task) =>
          task.status === "queued" ||
          task.status === "dispatched" ||
          // Daemon-parked on a busy local_directory — still active, just
          // waiting on a path lock.
          task.status === "waiting_local_directory" ||
          task.status === "running",
      ),
    [tasks],
  );

  if (activeTasks.length === 0) return null;

  return (
    <div className={cn("mt-6 flex flex-col gap-2", className)}>
      {activeTasks.map((task) => (
        <LiveRunCard
          key={task.id}
          task={task}
          issueId={issueId}
          agentName={
            getActorName("agent", task.agent_id) ||
            t(($) => $.agent_live.fallback_name)
          }
        />
      ))}
    </div>
  );
}

function LiveRunCard({
  task,
  issueId,
  agentName,
}: {
  task: AgentTask;
  issueId: string;
  agentName: string;
}) {
  const running = task.status === "running";
  // Status and trigger copy come from the shared run labels, so this card,
  // the Execution log row and the usage dialog can never word the same run
  // differently.
  const statusLabel = useStatusLabel(task.status);
  const triggerText = useTriggerText(task);

  return (
    // The border beam matches the header chip's treatment for a run genuinely
    // in flight. Queued work stays calm — reserving the motion for running work
    // is what makes it mean anything.
    <div
      className={cn(
        "rounded-lg border bg-card/50 px-3 py-2",
        running && "border-beam",
      )}
    >
      <div className="flex items-center gap-2">
        <ActorAvatar actorType="agent" actorId={task.agent_id} size="xs" />
        <span className="shrink-0 truncate text-caption font-medium text-foreground">
          {agentName}
        </span>
        {triggerText ? (
          <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground">
            {triggerText}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <span
          className={cn(
            "shrink-0 text-caption",
            running ? "text-info" : "text-muted-foreground",
          )}
        >
          {statusLabel}
        </span>
        {/* Stop belongs on the card's LAST row, which is the fold bar once the
            run streams. A card with no fold — queued, or parked on a busy
            local_directory — has only this row, and must still be stoppable:
            waiting for dispatch is exactly when a user changes their mind. */}
        {running ? null : <CancelTaskButton task={task} issueId={issueId} />}
      </div>
      {running ? (
        <div className="mt-1.5">
          <IssueAgentProcessFold
            taskId={task.id}
            isLive
            // Always visible, unlike the execution log's hover-revealed row
            // actions: this surface exists for the reader who thinks the agent
            // is stuck, so the way out cannot itself be hidden.
            triggerActions={<CancelTaskButton task={task} issueId={issueId} />}
          />
        </div>
      ) : null}
    </div>
  );
}
