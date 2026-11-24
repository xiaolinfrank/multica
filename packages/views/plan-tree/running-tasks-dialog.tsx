"use client";

import type { RunningAgentTask } from "@multica/core/types";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multica/ui/components/ui/alert-dialog";
import { Button } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useT } from "../i18n";

/** A structural write the server refused because an agent is working in the
 *  folder it would rename: the tasks it listed, and how to run the write again
 *  with the reader's choice. */
export interface RunningTasksConflict {
  tasks: RunningAgentTask[];
  /** `force` renames the folder now; `defer` writes the row and leaves the
   *  folder for the directory panel to sync later. */
  retry: (mode: "force" | "defer") => void;
}

/**
 * "An agent is working in this folder." One dialog for every surface that can
 * rename a folder — the plan tree, the gantt, the node panel — so the two
 * choices mean the same thing everywhere.
 */
export function RunningTasksDialog({
  conflict,
  onDismiss,
  pending,
}: {
  conflict: RunningTasksConflict | null;
  onDismiss: () => void;
  pending?: boolean;
}) {
  const { t } = useT("cockpit");
  return (
    <AlertDialog open={conflict !== null} onOpenChange={(open) => { if (!open && !pending) onDismiss(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t(($) => $.directories.running_title)}</AlertDialogTitle>
          <AlertDialogDescription>{t(($) => $.directories.running_body)}</AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto text-caption">
          {(conflict?.tasks ?? []).map((task) => (
            <li key={task.task_id} className="flex items-center justify-between gap-3 rounded-sm bg-muted/60 px-2 py-1">
              <span className="font-mono">{task.issue_identifier || task.issue_id}</span>
              <span className="text-muted-foreground">{t(($) => $.directories.task_status, { status: task.status })}</span>
            </li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t(($) => $.directories.cancel)}</AlertDialogCancel>
          <Button type="button" variant="outline" disabled={pending} onClick={() => conflict?.retry("defer")}>
            {t(($) => $.directories.sync_later)}
          </Button>
          <Button type="button" disabled={pending} aria-busy={pending} onClick={() => conflict?.retry("force")}>
            {pending && <Spinner />}
            {t(($) => $.directories.sync_now)}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
