"use client";

// Confirming a new execution task.
//
// The toolbar click is only a proposal: the row lands once the confirm
// button is pressed, and the code it will wear is fetched for preview
// first — codes are spent once used (deleted rows keep theirs, see
// migration 948), so the number a direction is about to hand out is worth
// showing before it is spent. While the preview loads or refetches, if it
// fails, and whenever no fresh code is on screen, the confirm button stays
// inert: a code that is not on screen is not a code this dialog should
// create, and a code just spent is dropped from the cache so reopening the
// same direction never offers it twice.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CockpitNode } from "@multica/core/types";
import { cockpitKeys, cockpitNextCodeOptions, useCreateCockpitNode } from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useT } from "../../i18n";

export function CockpitTaskCreateDialog({
  wsId,
  direction,
  position,
  displayCode,
  onOpenChange,
  onCreated,
  onFail,
}: {
  wsId: string;
  /** The direction row the task will land under; null keeps the dialog closed. */
  direction: CockpitNode | null;
  position: number;
  /** The gantt's display code for the direction, preferred over the stored one. */
  displayCode: string | null;
  onOpenChange: (open: boolean) => void;
  onCreated: (node: CockpitNode) => void;
  onFail: (error: unknown) => void;
}) {
  const { t } = useT("cockpit");
  const queryClient = useQueryClient();
  const nextCode = useQuery({
    ...cockpitNextCodeOptions(wsId, direction?.id ?? ""),
    enabled: direction != null,
  });
  const createNode = useCreateCockpitNode(wsId);
  const submitting = createNode.isPending;

  const confirm = () => {
    if (!direction || !nextCode.data?.code) return;
    createNode.mutate(
      { code: nextCode.data.code, name: "", parent_id: direction.id, position, status: "" },
      {
        onSuccess: (node: CockpitNode) => {
          // The previewed code is spent now: drop it from the cache so a
          // second task under the same direction never flashes — or worse,
          // submits — the number that was just handed out.
          queryClient.removeQueries({ queryKey: cockpitKeys.nextCode(wsId, direction.id) });
          onCreated(node);
          onOpenChange(false);
        },
        onError: (error: unknown) => {
          // The preview is stale now — someone spent this code, or the board
          // moved — so refetch rather than offering the same number twice.
          void nextCode.refetch();
          onFail(error);
        },
      },
    );
  };

  return (
    <Dialog open={direction != null} onOpenChange={(next) => (submitting ? undefined : onOpenChange(next))}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t(($) => $.toolbar.add_node)}</DialogTitle>
          <DialogDescription>
            {t(($) => $.task_create.description, {
              parent: `${displayCode ?? direction?.code ?? ""} ${direction?.name ?? ""}`.trim(),
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <span className="text-caption font-medium">{t(($) => $.task_create.code)}</span>
          {nextCode.isPending ? (
            <Spinner className="size-4" />
          ) : nextCode.isError || !nextCode.data?.code ? (
            <p className="text-caption text-destructive">{t(($) => $.task_create.code_failed)}</p>
          ) : (
            <p className="font-mono text-body tabular-nums">{nextCode.data.code}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
            {t(($) => $.task_create.cancel)}
          </Button>
          <Button
            disabled={submitting || nextCode.isFetching || !nextCode.data?.code}
            onClick={confirm}
          >
            {submitting ? <Spinner className="size-4" /> : null}
            {t(($) => $.task_create.confirm)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
