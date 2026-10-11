"use client";

// Version history for the board.
//
// Every import and every restore freezes the board it displaces; anyone can
// save a version on demand; ordinary edits leave a throttled auto checkpoint
// (dense runs collapse per actor, see group-snapshots). Restore is the one
// destructive operation the toolbar offers, so it asks inline (a second click
// confirms) and then awaits the server — the list and the board underneath
// refresh only when the replacement actually landed.

import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CockpitSnapshot } from "@multica/core/types";
import { cockpitSnapshotPageOptions } from "@multica/core/cockpit";
import { Input } from "@multica/ui/components/ui/input";
import { CockpitFlowPaging, useCockpitSearch } from "./cockpit-task-flow";
import {
  useCreateCockpitSnapshot,
  useDeleteCockpitSnapshot,
  useRestoreCockpitSnapshot,
} from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@multica/ui/components/ui/popover";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { ChevronDown, History, RotateCcw, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@multica/ui/lib/utils";
import { groupVersionHistory } from "../group-snapshots";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";
import { useTimeAgo } from "../../i18n/use-time-ago";
import { CockpitSnapshotDiffDialog } from "./cockpit-snapshot-diff";

function triggerLabel(
  t: ReturnType<typeof useT<"cockpit">>["t"],
  trigger: string,
): string {
  // Server-driven value; unknown kinds still render, as a literal.
  switch (trigger) {
    case "import":
      return t(($) => $.versions.trigger_import);
    case "restore":
      return t(($) => $.versions.trigger_restore);
    case "manual":
      return t(($) => $.versions.trigger_manual);
    case "auto":
      return t(($) => $.versions.trigger_auto);
    default:
      return trigger;
  }
}

function SnapshotRow({
  wsId,
  snapshot,
  canRestore,
  restoreBlocked,
  restoreBlockedReasonId,
  onRestored,
  onError,
  onCompare,
}: {
  wsId: string;
  snapshot: CockpitSnapshot;
  canRestore: boolean;
  restoreBlocked: boolean;
  restoreBlockedReasonId: string;
  onRestored: () => void;
  onError: (error: unknown) => void;
  onCompare: (snapshot: CockpitSnapshot) => void;
}) {
  const { t } = useT("cockpit");
  const timeAgo = useTimeAgo();
  const restore = useRestoreCockpitSnapshot(wsId);
  const remove = useDeleteCockpitSnapshot(wsId);
  const [confirming, setConfirming] = useState(false);

  return (
    <li className="flex flex-col gap-1 rounded-md px-2 py-2 hover:bg-accent">
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-micro text-muted-foreground">
          {triggerLabel(t, snapshot.trigger_kind)}
        </span>
        {snapshot.label !== "" && (
          <span className="min-w-0 truncate text-caption font-medium">{snapshot.label}</span>
        )}
        <span className="ml-auto shrink-0 text-micro text-faint-foreground">
          {timeAgo(snapshot.created_at)}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate text-micro text-muted-foreground">
          {t(($) => $.versions.row_meta, {
            nodes: snapshot.node_count,
            by: snapshot.created_by_label || t(($) => $.versions.by_unknown),
          })}
        </span>
        <Button type="button" variant="ghost" size="sm" className="ml-auto h-6 px-2 text-micro" onClick={() => onCompare(snapshot)}>{t(($) => $.snapshot_diff.compare)}</Button>
        {canRestore && (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {confirming ? (
              <>
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-6 px-2 text-micro"
                  disabled={restore.isPending || restoreBlocked}
                  aria-describedby={restoreBlocked ? restoreBlockedReasonId : undefined}
                  onClick={() =>
                    restore.mutate(snapshot.id, {
                      onSuccess: (result) => {
                        setConfirming(false);
                        onRestored();
                        toast.success(
                          t(($) => $.versions.restore_done, { nodes: result.nodes }),
                        );
                        if (result.unresolved_issues.length > 0) {
                          toast.warning(
                            t(($) => $.versions.restore_skipped, {
                              n: result.unresolved_issues.length,
                            }),
                          );
                        }
                      },
                      onError: (error) => {
                        setConfirming(false);
                        onError(error);
                      },
                    })
                  }
                >
                  {restore.isPending ? <Spinner className="size-3" /> : null}
                  {t(($) => $.versions.confirm_restore)}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-micro"
                  onClick={() => setConfirming(false)}
                >
                  {t(($) => $.versions.cancel)}
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-micro"
                disabled={restoreBlocked}
                aria-describedby={restoreBlocked ? restoreBlockedReasonId : undefined}
                onClick={() => setConfirming(true)}
              >
                <RotateCcw className="size-3" />
                {t(($) => $.versions.restore)}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              aria-label={t(($) => $.versions.delete, { label: snapshot.label })}
              className="h-6 w-6 px-0 text-muted-foreground"
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate(snapshot.id, {
                  onSuccess: () => setConfirming(false),
                  onError,
                })
              }
            >
              <Trash2 className="size-3" />
            </Button>
          </span>
        )}
      </div>
    </li>
  );
}

// A collapsed run of auto checkpoints by one actor. The whole header toggles;
// rows inside keep the same affordances as standalone ones.
function SnapshotRunRow({
  wsId,
  snapshots,
  canRestore,
  restoreBlocked,
  restoreBlockedReasonId,
  onRestored,
  onError,
  onCompare,
}: {
  wsId: string;
  snapshots: CockpitSnapshot[];
  canRestore: boolean;
  restoreBlocked: boolean;
  restoreBlockedReasonId: string;
  onRestored: () => void;
  onError: (error: unknown) => void;
  onCompare: (snapshot: CockpitSnapshot) => void;
}) {
  const { t } = useT("cockpit");
  const timeAgo = useTimeAgo();
  const [open, setOpen] = useState(false);

  return (
    <li className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        className="flex min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronDown
          className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
        />
        <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-micro text-muted-foreground">
          {t(($) => $.versions.trigger_auto)}
        </span>
        <span className="min-w-0 truncate text-caption font-medium">
          {t(($) => $.versions.auto_group, { n: snapshots.length })}
        </span>
        <span className="ml-auto shrink-0 text-micro text-faint-foreground">
          {timeAgo(snapshots[0]!.created_at)}
        </span>
      </button>
      {open && (
        <ul className="ml-3 flex flex-col border-l pl-1">
          {snapshots.map((snapshot) => (
            <SnapshotRow
              key={snapshot.id}
              wsId={wsId}
              snapshot={snapshot}
              canRestore={canRestore}
              restoreBlocked={restoreBlocked}
              restoreBlockedReasonId={restoreBlockedReasonId}
              onRestored={onRestored}
              onError={onError}
              onCompare={onCompare}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * The toolbar entry for version history. `canRestore` is the caller's word for
 * whether this member may replace the board (owner/admin); the server
 * re-checks regardless. Stable bindings separately protect board identity,
 * without removing the member's snapshot viewing, saving or deletion access.
 */
export function CockpitVersions({ wsId, canRestore, hasStableBindings = false, hasMeetingWorkflows = false, hasMeetingLifecycle = false, hasMeetingPreparation = false, meetingsHref }: {
  wsId: string;
  canRestore: boolean;
  hasStableBindings?: boolean;
  hasMeetingWorkflows?: boolean;
  hasMeetingLifecycle?: boolean;
  hasMeetingPreparation?: boolean;
  meetingsHref: string;
}) {
  const { t } = useT("cockpit");
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(""); const [cursors, setCursors] = useState<string[]>([""]);
  const [comparison, setComparison] = useState<{ wsId: string; snapshot: CockpitSnapshot } | null>(null);
  const compare = (snapshot: CockpitSnapshot) => { setOpen(false); setComparison({ wsId, snapshot }); };
  const q = useCockpitSearch(text), changing = q !== text.trim();
  const query = useQuery({ ...cockpitSnapshotPageOptions(wsId, { q, cursor: cursors.at(-1) || undefined, page_size: 25 }), enabled: open && !changing });
  const { data: page, isLoading } = query;
  const create = useCreateCockpitSnapshot(wsId);
  const restoreBlockedReasonId = useId();
  const restoreBlocked = hasStableBindings || hasMeetingWorkflows || hasMeetingLifecycle || hasMeetingPreparation;

  const fail = (error: unknown) => {
    toast.error(error instanceof Error ? error.message : t(($) => $.errors.save_failed));
  };

  const rows = page?.items ?? [];

  return (
    <><Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="sm" className="h-7 gap-1 px-2">
            <History className="size-3.5" />
            {t(($) => $.versions.button)}
          </Button>
        }
      />
      <PopoverContent align="end" className="w-[min(24rem,calc(100vw-2rem))] p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <p className="text-caption font-medium">{t(($) => $.versions.title)}</p>
          <Button
            variant="outline"
            size="sm"
            className="h-6 gap-1 px-2 text-micro"
            disabled={create.isPending}
            onClick={() =>
              create.mutate("", {
                onSuccess: () => toast.success(t(($) => $.versions.saved)),
                onError: fail,
              })
            }
          >
            <Save className="size-3" />
            {t(($) => $.versions.save_current)}
          </Button>
        </div>
        <div className="space-y-3 border-b p-3"><p className="text-caption text-muted-foreground">{t(($) => $.governance.workspace_history)}</p>
          <Input value={text} name="cockpit-snapshot-search" autoComplete="off" spellCheck={false} aria-label={t(($) => $.governance.search_snapshots)} placeholder={t(($) => $.governance.search_snapshots)} onChange={(event) => { setText(event.target.value); setCursors([""]); }} />
          {page ? <CockpitFlowPaging page={cursors.length} shown={page.items.length} total={page.total} hasNext={Boolean(page.next_cursor)} busy={query.isFetching || changing}
            onPrevious={() => setCursors(cursors.slice(0, -1))} onNext={() => { if (page.next_cursor) setCursors([...cursors, page.next_cursor]); }} />
            : cursors.length > 1 && <Button type="button" variant="outline" size="sm" onClick={() => setCursors(cursors.slice(0, -1))}>{t(($) => $.task_flow.previous)}</Button>}
        </div>
        {restoreBlocked && (
          <div id={restoreBlockedReasonId} className="space-y-2 border-b px-3 py-2 text-caption text-muted-foreground">
            <p>{hasMeetingPreparation ? t(($) => $.meeting_preparation.restore_protected) : hasMeetingLifecycle ? t(($) => $.meeting_lifecycle.restore_protected) : hasMeetingWorkflows ? t(($) => $.versions.restore_workflow_protected) : t(($) => $.versions.restore_protected)}</p>
            {(hasMeetingLifecycle || hasMeetingPreparation) && <AppLink href={meetingsHref} className="text-primary underline" onClick={() => setOpen(false)}>{t(($) => $.work_overview.open_meetings)}</AppLink>}
          </div>
        )}
        {!canRestore && (
          <p className="border-b px-3 py-2 text-caption text-muted-foreground">
            {t(($) => $.versions.restore_permission)}
          </p>
        )}
        <div className="max-h-80 overflow-y-auto p-1">
          {isLoading || changing ? (
            <div className="flex items-center justify-center py-6">
              <Spinner className="size-4" />
            </div>
          ) : query.isError ? (
            <div role="alert" className="space-y-2 p-3 text-caption text-destructive"><p>{t(($) => $.errors.load_failed)}</p><Button type="button" variant="outline" size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>{t(($) => $.binding.retry)}</Button></div>
          ) : page && rows.length === 0 ? (
            <p className="px-2 py-6 text-center text-caption text-muted-foreground">
              {t(($) => $.versions.empty)}
            </p>
          ) : (
            <ul className={cn("flex flex-col")}>
              {groupVersionHistory(rows).map((entry) =>
                entry.kind === "single" ? (
                  <SnapshotRow
                    key={entry.snapshot.id}
                    wsId={wsId}
                    snapshot={entry.snapshot}
                    canRestore={canRestore}
                    restoreBlocked={restoreBlocked}
                    restoreBlockedReasonId={restoreBlockedReasonId}
                    onRestored={() => setOpen(false)}
                    onError={fail}
                    onCompare={compare}
                  />
                ) : (
                  <SnapshotRunRow
                    key={entry.run.snapshots[0]!.id}
                    wsId={wsId}
                    snapshots={entry.run.snapshots}
                    canRestore={canRestore}
                    restoreBlocked={restoreBlocked}
                    restoreBlockedReasonId={restoreBlockedReasonId}
                    onRestored={() => setOpen(false)}
                    onError={fail}
                    onCompare={compare}
                  />
                ),
              )}
            </ul>
          )}
        </div>
        <p className="border-t px-3 py-2 text-micro text-faint-foreground">
          {t(($) => $.versions.hint)}
        </p>
      </PopoverContent>
    </Popover>{comparison?.wsId === wsId && <CockpitSnapshotDiffDialog key={`${wsId}:${comparison.snapshot.id}`} wsId={wsId} snapshot={comparison.snapshot} onClose={() => setComparison(null)} />}</>
  );
}
