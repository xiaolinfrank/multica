"use client";

// Version history for the board.
//
// Every import and every restore freezes the board it displaces; anyone can
// save a version on demand. Restore is the one destructive operation the
// toolbar offers, so it asks inline (a second click confirms) and then awaits
// the server — the list and the board underneath refresh only when the
// replacement actually landed.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CockpitSnapshot } from "@multica/core/types";
import { cockpitSnapshotsOptions } from "@multica/core/cockpit/queries";
import {
  useCreateCockpitSnapshot,
  useDeleteCockpitSnapshot,
  useRestoreCockpitSnapshot,
} from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@multica/ui/components/ui/popover";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { History, RotateCcw, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import { useTimeAgo } from "../../i18n/use-time-ago";

function triggerLabel(
  t: ReturnType<typeof useT>["t"],
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
    default:
      return trigger;
  }
}

function SnapshotRow({
  wsId,
  snapshot,
  canRestore,
  onRestored,
  onError,
}: {
  wsId: string;
  snapshot: CockpitSnapshot;
  canRestore: boolean;
  onRestored: () => void;
  onError: (error: unknown) => void;
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
        {canRestore && (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {confirming ? (
              <>
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-6 px-2 text-micro"
                  disabled={restore.isPending}
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

/**
 * The toolbar entry for version history. `canRestore` is the caller's word for
 * whether this member may replace the board (owner/admin); the server
 * re-checks regardless.
 */
export function CockpitVersions({ wsId, canRestore }: { wsId: string; canRestore: boolean }) {
  const { t } = useT("cockpit");
  const { data: snapshots, isLoading } = useQuery(cockpitSnapshotsOptions(wsId));
  const create = useCreateCockpitSnapshot(wsId);
  const [open, setOpen] = useState(false);

  const fail = (error: unknown) => {
    toast.error(error instanceof Error ? error.message : t(($) => $.errors.save_failed));
  };

  const rows = snapshots ?? [];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="sm" className="h-7 gap-1 px-2">
            <History className="size-3.5" />
            {t(($) => $.versions.button)}
          </Button>
        }
      />
      <PopoverContent align="end" className="w-96 p-0">
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
        <div className="max-h-80 overflow-y-auto p-1">
          {isLoading ? (
            <div className="flex items-center justify-center py-6">
              <Spinner className="size-4" />
            </div>
          ) : rows.length === 0 ? (
            <p className="px-2 py-6 text-center text-caption text-muted-foreground">
              {t(($) => $.versions.empty)}
            </p>
          ) : (
            <ul className={cn("flex flex-col")}>
              {rows.map((snapshot) => (
                <SnapshotRow
                  key={snapshot.id}
                  wsId={wsId}
                  snapshot={snapshot}
                  canRestore={canRestore}
                  onRestored={() => setOpen(false)}
                  onError={fail}
                />
              ))}
            </ul>
          )}
        </div>
        <p className="border-t px-3 py-2 text-micro text-faint-foreground">
          {t(($) => $.versions.hint)}
        </p>
      </PopoverContent>
    </Popover>
  );
}
