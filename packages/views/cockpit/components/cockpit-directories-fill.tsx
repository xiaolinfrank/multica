"use client";

import { useState } from "react";
import { useFillPlanDirectories, useSyncNodeDirectory } from "@multica/core/directory";
import type { DirectoryFillItem, DirectoryFillResult } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { FolderOpen, RefreshCw } from "@multica/ui/icons";
import { toast } from "sonner";
import { useT } from "../../i18n";

/**
 * "Fill folders": one pass over a reconciled plan that creates the folders it is
 * missing and syncs the ones a rename left behind. Preview first — the first
 * run on a real share is exactly when someone wants to read the list before it
 * is acted on.
 *
 * Issues are not part of this pass: their folder is allocated when a task first
 * needs one, not in bulk.
 */
export function FillDirectoriesButton({ wsId, projectId, disabled }: {
  wsId: string;
  projectId?: string;
  disabled?: boolean;
}) {
  const { t } = useT("cockpit");
  const [open, setOpen] = useState(false);
  const [force, setForce] = useState(false);
  const [result, setResult] = useState<DirectoryFillResult | null>(null);
  const fill = useFillPlanDirectories(wsId);
  const sync = useSyncNodeDirectory(wsId);

  const run = (apply: boolean) => {
    fill.mutate({ apply, force, ...(projectId ? { project_id: projectId } : {}) }, { onSuccess: setResult });
  };
  const openDialog = () => {
    setOpen(true);
    setResult(null);
    run(false);
  };

  const pending = (result?.items ?? []).filter((item) => item.action !== "none");
  const shared = result?.shared_collab_projects ?? [];
  const failed = (result?.items ?? []).filter((item) => item.status === "failed");
  const skipped = (result?.items ?? []).filter((item) => item.status === "skipped");
  const showResults = Boolean(result?.applied);

  // Retry one failed row in place. Asking the server about that one folder is
  // a real repair, so its own result replaces the row's state; a refusal keeps
  // the row and says why.
  const retryItem = (item: DirectoryFillItem) => {
    sync.mutate({ nodeId: item.node_id, force }, {
      onSuccess: (answer) => {
        setResult((current) => current ? {
          ...current,
          items: current.items.map((row) => row.node_id === item.node_id ? {
            ...row,
            status: answer.directory_sync.status,
            directory_name: answer.directory_sync.directory_name ?? row.directory_name,
            full_path: answer.directory?.full_path ?? row.full_path,
            reason: answer.directory_sync.reason,
            error: answer.directory_sync.error,
          } : row),
        } : current);
        if (answer.directory_sync.status === "failed") {
          toast.error(t(($) => $.directories.sync_failed, { reason: answer.directory_sync.error || answer.directory_sync.reason || "" }));
        }
      },
      onError: (error) => toast.error(error instanceof Error ? error.message : t(($) => $.errors.save_failed)),
    });
  };

  return (
    <>
      <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={openDialog}>
        <FolderOpen className="size-3.5" aria-hidden />
        {t(($) => $.directories.fill_action)}
      </Button>
      <Dialog open={open} onOpenChange={(next) => { if (next) openDialog(); else setOpen(false); }}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t(($) => $.directories.fill_title)}</DialogTitle>
            <DialogDescription>{t(($) => $.directories.fill_body)}</DialogDescription>
          </DialogHeader>

          {fill.isPending && !result && (
            <div role="status" className="flex items-center gap-2 text-caption text-muted-foreground">
              <Spinner />{t(($) => $.workflow.loading)}
            </div>
          )}

          {result && !showResults && (
            <p className="text-caption">
              {pending.length === 0
                ? t(($) => $.directories.fill_none)
                : t(($) => $.directories.fill_counts, { create: result.counts.create ?? 0, sync: result.counts.sync ?? 0 })}
            </p>
          )}

          {!showResults && pending.length > 0 && (
            <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto text-caption" aria-label={t(($) => $.directories.fill_results)}>
              {pending.map((item) => (
                <li key={item.node_id} className="flex items-center gap-2 rounded-sm bg-muted/50 px-2 py-1">
                  <span className="font-mono text-micro text-muted-foreground">{item.code}</span>
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  <span className="shrink-0 text-micro">
                    {item.action === "create" ? t(($) => $.directories.fill_item_create) : t(($) => $.directories.fill_item_sync)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {showResults && (
            <div className="flex flex-col gap-2">
              <p className="text-caption text-muted-foreground">{t(($) => $.directories.fill_results)}</p>
              <ul className="max-h-64 flex-col gap-1 overflow-y-auto text-caption" aria-label={t(($) => $.directories.fill_results)}>
                {(result?.items ?? []).filter((item) => item.action !== "none").map((item) => (
                  <li key={item.node_id} className="flex items-center gap-2 rounded-sm bg-muted/50 px-2 py-1">
                    <span className="font-mono text-micro text-muted-foreground">{item.code}</span>
                    <span className="min-w-0 flex-1 truncate">{item.full_path || item.name}</span>
                    <FillStatus item={item} onRetry={() => retryItem(item)} retrying={sync.isPending} />
                  </li>
                ))}
              </ul>
            </div>
          )}

          {shared.length > 0 && (
            <p className="text-caption text-muted-foreground">
              {t(($) => $.directories.shared_warning, {
                names: shared.map((entry) => `${entry.workspace_name} / ${entry.project_title}`).join("、"),
              })}
            </p>
          )}

          <DialogFooter>
            {!showResults && (
              <label className="mr-auto flex items-center gap-2 text-caption">
                <Checkbox checked={force} onCheckedChange={(value) => setForce(value === true)} />
                {t(($) => $.directories.fill_force)}
              </label>
            )}
            {!showResults ? (
              <>
                <Button type="button" variant="outline" disabled={fill.isPending || pending.length === 0} onClick={() => run(false)}>
                  {t(($) => $.directories.fill_preview)}
                </Button>
                <Button type="button" disabled={fill.isPending || pending.length === 0} aria-busy={fill.isPending} onClick={() => run(true)}>
                  {fill.isPending && <Spinner />}
                  {t(($) => $.directories.fill_apply)}
                </Button>
              </>
            ) : (
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>{t(($) => $.directories.close)}</Button>
            )}
          </DialogFooter>
          {failed.length > 0 && (
            <p className="text-caption text-destructive">{t(($) => $.directories.sync_failed, { reason: failed[0]!.error || failed[0]!.reason || "" })}</p>
          )}
          {skipped.length > 0 && (
            <p className="text-caption text-muted-foreground">{t(($) => $.directories.fill_skipped_hint, { n: skipped.length })}</p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function FillStatus({ item, onRetry, retrying }: { item: DirectoryFillItem; onRetry: () => void; retrying: boolean }) {
  const { t } = useT("cockpit");
  if (item.status === "failed" || item.status === "skipped") {
    return (
      <Button type="button" size="sm" variant="ghost" disabled={retrying} onClick={onRetry}
        title={item.error || item.reason}>
        <RefreshCw className="size-3" aria-hidden />
        {t(($) => $.directories.retry)}
      </Button>
    );
  }
  const label = (() => {
    switch (item.status) {
      case "created": return t(($) => $.directories.fill_status_created);
      case "renamed": return t(($) => $.directories.fill_status_renamed);
      case "ok": return t(($) => $.directories.fill_status_ok);
      case "skipped": return t(($) => $.directories.fill_status_skipped);
      case "failed": return t(($) => $.directories.fill_status_failed);
      default: return item.status;
    }
  })();
  return <span className="shrink-0 text-micro text-muted-foreground">{label}</span>;
}
