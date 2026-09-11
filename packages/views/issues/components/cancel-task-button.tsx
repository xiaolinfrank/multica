"use client";

import { useState } from "react";
import { Loader2, Square } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@multica/ui/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@multica/ui/components/ui/tooltip";
import { api } from "@multica/core/api";
import type { AgentTask } from "@multica/core/types";
import { useT } from "../../i18n";
import { TerminateTaskConfirmDialog } from "./terminate-task-confirm-dialog";

// The one "stop this run" control on the issue page.
//
// Two surfaces need it and they must behave identically: the execution log row
// in the right panel, and the live process fold in the main column — the second
// exists precisely for the reader who thinks the agent is stuck, so it is the
// place a stop is most likely to be reached for.
//
// Copy deliberately comes from `issues.execution_log.cancel_task_*` even though
// the control is no longer execution-log-only: sharing the strings is what keeps
// the two surfaces from wording the same action differently. Rename the keys
// only in a change that updates both.
export function CancelTaskButton({
  task,
  issueId,
  className,
}: {
  task: AgentTask;
  issueId: string;
  className?: string;
}) {
  const { t } = useT("issues");
  const [cancelling, setCancelling] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const handleCancel = async () => {
    if (cancelling) return;
    setCancelling(true);
    try {
      await api.cancelTask(issueId, task.id);
      // No reset on success: the task leaves the active statuses and whatever
      // rendered this button unmounts. Clearing the flag would only flash the
      // idle icon back for a frame.
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : t(($) => $.execution_log.cancel_failed),
      );
      setCancelling(false);
    }
  };

  const requestCancel = () => {
    if (cancelling) return;
    setConfirmOpen(true);
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={requestCancel}
              disabled={cancelling}
              aria-label={t(($) => $.execution_log.cancel_task_aria)}
            />
          }
          className={cn(
            "flex items-center justify-center rounded p-1 text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
        >
          {cancelling ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Square className="h-3.5 w-3.5" />
          )}
        </TooltipTrigger>
        <TooltipContent>
          {t(($) => $.execution_log.cancel_task_tooltip)}
        </TooltipContent>
      </Tooltip>
      <TerminateTaskConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={() => void handleCancel()}
        // Queued work stops at once; anything already handed to a daemon may
        // take a few seconds, and the dialog says so only then.
        showRunningNote={
          task.status === "running" ||
          task.status === "dispatched" ||
          task.status === "waiting_local_directory"
        }
      />
    </>
  );
}
