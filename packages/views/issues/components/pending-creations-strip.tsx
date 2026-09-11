"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertCircle, ChevronDown, Loader2, Plus, X } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { api } from "@multica/core/api";
import { useAuthStore } from "@multica/core/auth";
import { useWorkspaceId } from "@multica/core/hooks";
import { agentTaskSnapshotKeys, agentTaskSnapshotOptions } from "@multica/core/agents";
import { agentListOptions } from "@multica/core/workspace/queries";
import {
  derivePendingCreations,
  type PendingCreation,
} from "@multica/core/issues/pending-creations";
import {
  useIssueDraftStore,
  usePendingCreationStore,
} from "@multica/core/issues/stores";
import { useModalStore } from "@multica/core/modals";
import { ActorAvatar } from "../../common/actor-avatar";
import { useT, useTimeAgo } from "../../i18n";

/** How many rows show before the strip collapses the rest behind a control. */
const VISIBLE_ROWS = 2;

/**
 * "Issues being created" strip, rendered between the surface header and the
 * list body.
 *
 * A quick-create writes an agent_task_queue row and nothing else — the issue
 * does not exist until the agent runs `multica issue create` — so until this
 * strip existed the user's own list showed no trace of what they had just
 * asked for, and the only evidence anywhere was a row on the agent's page.
 * That reads as "stuck" or "it didn't work". This puts the pending record
 * where the user looked for it.
 *
 * It derives entirely from the agent-task snapshot the app already keeps warm
 * for presence, so it issues no request of its own, and each row retires
 * itself the moment the queue row gains an issue_id.
 */
export function PendingCreationsStrip({ projectId }: { projectId?: string }) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const dismissed = usePendingCreationStore((s) => s.dismissed);
  const [expanded, setExpanded] = useState(false);

  const { data: tasks } = useQuery({
    ...agentTaskSnapshotOptions(wsId),
    enabled: wsId !== "",
  });
  const { data: agents } = useQuery({
    ...agentListOptions(wsId),
    enabled: wsId !== "",
  });

  const availability = useMemo(
    () => new Map((agents ?? []).map((a) => [a.id, a.runtime_availability])),
    [agents],
  );
  const agentNames = useMemo(
    () => new Map((agents ?? []).map((a) => [a.id, a.name])),
    [agents],
  );

  // Recomputed whenever the snapshot changes, which task:* events already
  // drive. The two time thresholds inside derivePendingCreations are coarse
  // (30 s / 24 h) precisely so this needs no ticker of its own.
  const rows = useMemo(
    () =>
      derivePendingCreations({
        tasks,
        userId,
        availability,
        dismissed,
        now: Date.now(),
        projectId,
      }),
    [tasks, userId, availability, dismissed, projectId],
  );

  if (rows.length === 0) return null;

  const shown = expanded ? rows : rows.slice(0, VISIBLE_ROWS);
  const hidden = rows.length - shown.length;

  return (
    <div
      className="flex shrink-0 flex-col gap-1.5 border-b px-4 py-2"
      role="status"
      aria-live="polite"
      aria-label={t(($) => $.quick_create_pending.region_label)}
    >
      {shown.map((row: PendingCreation) => (
        <PendingCreationRow
          key={row.taskId}
          row={row}
          agentName={agentNames.get(row.agentId) ?? ""}
          wsId={wsId}
        />
      ))}
      {hidden > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          className="self-start text-caption text-muted-foreground"
          onClick={() => setExpanded(true)}
        >
          <ChevronDown className="size-3.5" />
          {t(($) => $.quick_create_pending.more_count, { count: hidden })}
        </Button>
      ) : null}
    </div>
  );
}

function PendingCreationRow({
  row,
  agentName,
  wsId,
}: {
  row: PendingCreation;
  agentName: string;
  wsId: string;
}) {
  const { t } = useT("issues");
  const timeAgo = useTimeAgo();
  const queryClient = useQueryClient();
  const dismiss = usePendingCreationStore((s) => s.dismiss);
  const [busy, setBusy] = useState(false);

  const name = agentName || t(($) => $.quick_create_pending.fallback_agent);
  const terminal = row.state === "failed" || row.state === "unconfirmed";

  const label = (() => {
    switch (row.state) {
      case "queued":
        return t(($) => $.quick_create_pending.state_queued);
      case "queued_behind":
        return t(($) => $.quick_create_pending.state_queued_behind, { name });
      case "queued_offline":
        return t(($) => $.quick_create_pending.state_queued_offline, { name });
      case "working":
        return t(($) => $.quick_create_pending.state_working, { name });
      case "failed":
        return t(($) => $.quick_create_pending.state_failed);
      case "unconfirmed":
        return t(($) => $.quick_create_pending.state_unconfirmed);
      default:
        // Server-driven enums need a default branch; an unmapped state never
        // reaches here because derivePendingCreations drops it first.
        return t(($) => $.quick_create_pending.state_queued);
    }
  })();

  async function handleCancel() {
    setBusy(true);
    try {
      await api.cancelTaskById(row.taskId);
      // Cancelled rows are excluded from the snapshot entirely, so the refetch
      // retires this row on its own. Dismiss locally so it leaves on the click
      // rather than on the round trip.
      dismiss(row.taskId);
    } catch {
      toast.error(t(($) => $.quick_create_pending.cancel_failed));
    } finally {
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: agentTaskSnapshotKeys.list(wsId) });
    }
  }

  function handleRetry() {
    // Reopen the same modal pre-filled, rather than making the user retype a
    // prompt the server still has. The draft store is the create flow's own
    // seam — see the inbox's retry affordance, which seeds it the same way.
    useIssueDraftStore.getState().setAgent({ prompt: row.prompt });
    // The modal's own seed order puts caller-provided agent_id/squad_id first.
    // Retry a squad run as the squad, not as the leader it happened to resolve
    // to, or the second attempt silently changes who was asked.
    useModalStore.getState().open("quick-create-issue", {
      ...(row.squadId ? { squad_id: row.squadId } : { agent_id: row.agentId }),
      ...(row.projectId ? { project_id: row.projectId } : {}),
    });
    dismiss(row.taskId);
  }

  return (
    <div className="flex items-center gap-2 text-caption">
      <span className="flex size-5 shrink-0 items-center justify-center">
        {terminal ? (
          <AlertCircle className="size-3.5 text-destructive" />
        ) : (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        )}
      </span>
      <ActorAvatar actorType="agent" actorId={row.agentId} size="xs" />
      <span className={cn("shrink-0", terminal ? "text-destructive" : "text-foreground")}>
        {label}
      </span>
      {row.prompt ? (
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.prompt}</span>
      ) : (
        <span className="flex-1" />
      )}
      <span className="shrink-0 text-faint-foreground" aria-hidden="true">
        {timeAgo(row.createdAt)}
      </span>
      {!terminal ? (
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0"
          disabled={busy}
          onClick={handleCancel}
        >
          {t(($) => $.quick_create_pending.action_cancel)}
        </Button>
      ) : row.sourceContextId || !row.prompt ? (
        // A captured source context can only be retried through the endpoint
        // that clones it; a fresh quick-create would silently drop the capture
        // and its attachments. Same for a row whose prompt this backend did not
        // project — reopening the modal empty would lose the user's text.
        // Both cases belong to the inbox item the server wrote.
        <span className="shrink-0 text-muted-foreground">
          {t(($) => $.quick_create_pending.check_inbox)}
        </span>
      ) : (
        <Button variant="ghost" size="sm" className="shrink-0" onClick={handleRetry}>
          <Plus className="size-3.5" />
          {t(($) => $.quick_create_pending.action_retry)}
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0"
        onClick={() => dismiss(row.taskId)}
        aria-label={t(($) => $.quick_create_pending.action_dismiss)}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
