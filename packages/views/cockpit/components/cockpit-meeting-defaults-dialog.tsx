"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  cockpitKeys,
  cockpitMeetingDestinationOptions,
  cockpitReadKeys,
  useUpdateCockpit,
} from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { Label } from "@multica/ui/components/ui/label";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";
import { useWorkspacePaths } from "@multica/core/paths";
import { IssueScopePicker, EMPTY_ISSUE_SCOPE, type IssueScopeValue } from "../../issues/components/pickers/issue-scope-picker";

/** The board's default meeting location: one tree, one save.
 *
 *  The same ownership picker a task uses, so "where meetings are filed" reads
 *  and behaves exactly like "where this task is filed". The preview below it
 *  is the server's own answer for the selected path — a proposal when nothing
 *  has been confirmed yet, never a path the client composed. */
export function CockpitMeetingDefaultsDialog({
  wsId,
  open,
  onOpenChange,
  defaultProjectId,
  defaultModuleId,
  defaultNodeId,
}: {
  wsId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultProjectId: string | null;
  defaultModuleId: string | null;
  defaultNodeId: string | null;
}) {
  const { t } = useT("cockpit");
  const paths = useWorkspacePaths();
  const client = useQueryClient();
  const update = useUpdateCockpit(wsId);
  const [value, setValue] = useState<IssueScopeValue>(EMPTY_ISSUE_SCOPE);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setValue({
      project_id: defaultProjectId,
      module_id: defaultModuleId,
      work_item_id: defaultNodeId,
    });
    setError("");
  }, [open, defaultProjectId, defaultModuleId, defaultNodeId]);

  const destination = useQuery({
    ...cockpitMeetingDestinationOptions(wsId, {
      projectId: value.project_id ?? undefined,
      // Always sent: "" clears the level, which is what the picker showed.
      // Omitting it would ask the server for the board's remembered folder.
      moduleId: value.module_id ?? "",
      nodeId: value.work_item_id ?? "",
    }),
    enabled: open && Boolean(value.project_id),
  });
  const destinationData = destination.data;
  const preview = !value.project_id
    ? t(($) => $.meetings.defaults_preview_missing)
    : destination.isPending
      ? t(($) => $.meeting_center.checking_destination)
      : destination.isError || !destinationData
        ? t(($) => $.meetings.defaults_preview_unavailable, { reason: t(($) => $.errors.load_failed) })
        : destinationData.error
          ? t(($) => $.meetings.defaults_preview_unavailable, { reason: destinationData.error })
          : destinationData.base_dir
            ? [
                t(($) => $.meetings.defaults_preview_path, { path: destinationData.base_dir }),
                destinationData.base_dir_exists
                  ? t(($) => $.meetings.defaults_preview_exists)
                  : t(($) => $.meetings.defaults_preview_will_create),
                destinationData.derived ? t(($) => $.meetings.defaults_preview_derived) : "",
              ]
                .filter(Boolean)
                .join(" ")
            : t(($) => $.meetings.defaults_preview_unavailable, { reason: t(($) => $.meetings.with_task_unset) });

  const save = async () => {
    setError("");
    try {
      await update.mutateAsync({
        meeting_project_id: value.project_id ?? "",
        meeting_module_id: value.module_id ?? "",
        meeting_node_id: value.work_item_id ?? "",
      });
      await Promise.all([
        client.invalidateQueries({ queryKey: cockpitReadKeys.all(wsId) }),
        client.invalidateQueries({ queryKey: [...cockpitKeys.all(wsId), "meeting-destination"] }),
      ]);
      toast.success(t(($) => $.meetings.defaults_saved));
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t(($) => $.meetings.defaults_failed));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (update.isPending ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t(($) => $.meetings.defaults_title)}</DialogTitle>
          <DialogDescription>{t(($) => $.meetings.defaults_description)}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label>{t(($) => $.meetings.destination_tree)}</Label>
          {/* The board's default location is workspace-wide, so the tree is
              the whole workspace: constraining it to the current view's
              project would make another project's saved default unreachable. */}
          <IssueScopePicker
            wsId={wsId}
            value={value}
            onUpdate={setValue}
            allowClear={false}
            disabled={update.isPending}
          />
          <p className="text-caption text-muted-foreground">{t(($) => $.meetings.destination_tree_hint)}</p>
          {destination.isError ? (
            <div role="alert" className="flex flex-wrap items-center gap-2 text-caption text-destructive">
              <span>{t(($) => $.meetings.defaults_preview_unavailable, { reason: t(($) => $.errors.load_failed) })}</span>
              <Button type="button" variant="ghost" size="sm" onClick={() => void destination.refetch()}>
                {t(($) => $.binding.retry)}
              </Button>
            </div>
          ) : (
            <p role="status" aria-live="polite" className="flex min-w-0 items-start gap-2 text-caption text-muted-foreground">
              {destination.isPending && value.project_id ? <Spinner /> : null}
              <span className="min-w-0 break-words [overflow-wrap:anywhere]">{preview}</span>
            </p>
          )}
          <AppLink
            href={value.project_id ? paths.projectDetail(value.project_id) : paths.projects()}
            target="_blank"
            rel="noreferrer"
            className="text-caption text-primary underline"
          >
            {t(($) => $.meetings.defaults_settings)}
          </AppLink>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-fit text-muted-foreground"
            disabled={update.isPending}
            onClick={() => setValue(EMPTY_ISSUE_SCOPE)}
          >
            {t(($) => $.meetings.defaults_clear)}
          </Button>
          {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={update.isPending} onClick={() => onOpenChange(false)}>
            {t(($) => $.task_create.cancel)}
          </Button>
          <Button type="button" disabled={update.isPending} aria-busy={update.isPending} onClick={() => void save()}>
            {update.isPending && <Spinner />}
            {t(($) => $.meetings.defaults_save)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
