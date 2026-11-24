"use client";

import { useQuery } from "@tanstack/react-query";
import { planDirectoriesOptions, useSyncNodeDirectory } from "@multica/core/directory";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { FolderOpen, RefreshCw } from "@multica/ui/icons";
import { toast } from "sonner";
import { useState } from "react";
import { LocalPathLink, useLocalPathActions } from "../../common/local-path-link";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";
import { RunningTasksDialog, type RunningTasksConflict } from "../../plan-tree/running-tasks-dialog";
import { isCockpitRunningTasksError } from "@multica/core/cockpit";

/**
 * The node panel's delivery folder: the path, what state it is in, and the one
 * action that state calls for.
 *
 * The panel asks for this row's status when it opens — one request, on demand.
 * The plan tree never does: a tree that stats a share is a tree that hangs when
 * the share is away.
 */
export function CockpitDirectorySection({ wsId, nodeId, projectId, readOnly }: {
  wsId: string;
  nodeId: string;
  projectId: string | null;
  readOnly?: boolean;
}) {
  const { t } = useT("cockpit");
  const paths = useWorkspacePaths();
  const query = useQuery(planDirectoriesOptions(wsId, [nodeId]));
  const status = query.data?.[0];
  const sync = useSyncNodeDirectory(wsId);
  const pathActions = useLocalPathActions();
  const [conflict, setConflict] = useState<RunningTasksConflict | null>(null);

  const runSync = (force: boolean) => {
    sync.mutate({ nodeId, force }, {
      onSuccess: (result) => {
        setConflict(null);
        if (result.directory_sync.status === "failed") {
          toast.error(t(($) => $.directories.sync_failed, { reason: result.directory_sync.error || result.directory_sync.reason || "" }));
        }
      },
      onError: (error) => {
        // A running-task refusal is a choice, not a failure.
        if (isCockpitRunningTasksError(error)) {
          setConflict({
            tasks: error.runningTasks,
            retry: (mode) => {
              // "Later" means the row keeps today's folder; there is nothing
              // to sync now, and re-sending `force: false` would only hit the
              // same 409 again.
              if (mode === "defer") { setConflict(null); return; }
              runSync(true);
            },
          });
          return;
        }
        toast.error(error instanceof Error ? error.message : t(($) => $.errors.save_failed));
      },
    });
  };

  if (query.isPending) {
    return <div role="status" className="flex items-center gap-2 text-caption text-muted-foreground"><Spinner />{t(($) => $.workflow.loading)}</div>;
  }
  if (!status) {
    return <p className="text-caption text-muted-foreground">{t(($) => $.directories.status_invalid)}</p>;
  }

  const shared = status.shared_collab_projects;
  const statusLabel = (() => {
    switch (status.status) {
      case "ok": return t(($) => $.directories.status_ok);
      case "missing": return status.directory_name ? t(($) => $.directories.status_missing) : t(($) => $.directories.status_unallocated);
      case "name_mismatch": return t(($) => $.directories.status_name_mismatch);
      case "no_collab_path": return t(($) => $.directories.status_no_collab_path);
      case "root_unavailable": return t(($) => $.directories.status_root_unavailable);
      default: return t(($) => $.directories.status_invalid);
    }
  })();
  const needsCreate = status.status === "missing" && status.directory_name !== null;
  const needsUnallocated = status.status === "missing" && status.directory_name === null;
  const needsRename = status.status === "name_mismatch";
  const noCollab = status.status === "no_collab_path";

  return (
    <div className="flex min-w-0 flex-col gap-2" data-directory-section="">
      {status.full_path ? (
        <LocalPathLink path={status.full_path} wrap="break" />
      ) : (
        <p className="text-caption text-muted-foreground">{statusLabel}</p>
      )}
      <div className="flex flex-wrap items-center gap-2 text-caption">
        {status.full_path && <span className="text-muted-foreground">{statusLabel}</span>}
        {!readOnly && !noCollab && (needsCreate || needsRename) && (
          <Button type="button" size="sm" variant="outline" disabled={sync.isPending} aria-busy={sync.isPending}
            onClick={() => runSync(false)}>
            {sync.isPending ? <Spinner /> : <RefreshCw className="size-3" aria-hidden />}
            {needsCreate ? t(($) => $.directories.retry) : t(($) => $.directories.sync)}
          </Button>
        )}
        {!readOnly && !noCollab && needsUnallocated && (
          <Button type="button" size="sm" variant="outline" disabled={sync.isPending} aria-busy={sync.isPending}
            onClick={() => runSync(false)}>
            {sync.isPending ? <Spinner /> : <RefreshCw className="size-3" aria-hidden />}
            {t(($) => $.directories.retry)}
          </Button>
        )}
        {/* A missing folder has nothing to open; the retry above creates it,
            and "open" that lands on an absent path only falls back to a copy. */}
        {status.full_path && status.status !== "missing" && (
          <>
            <Button type="button" size="sm" variant="ghost"
              onClick={() => { if (status.full_path) void pathActions.open(status.full_path); }}>
              <FolderOpen className="size-3" aria-hidden />
              {t(($) => $.directories.open)}
            </Button>
            <Button type="button" size="sm" variant="ghost"
              onClick={() => { if (status.full_path) void pathActions.copy(status.full_path); }}>
              {t(($) => $.directories.copy)}
            </Button>
          </>
        )}
        {noCollab && projectId && (
          <AppLink href={paths.projectDetail(projectId)} className="text-primary hover:underline">
            {t(($) => $.directories.setting)}
          </AppLink>
        )}
      </div>
      {status.error && <p className="text-caption text-destructive">{status.error}</p>}
      {shared.length > 0 && (
        <p className="text-caption text-muted-foreground">
          {t(($) => $.directories.shared_warning, {
            names: shared.map((entry) => `${entry.workspace_name} / ${entry.project_title}`).join("、"),
          })}
        </p>
      )}
      <RunningTasksDialog conflict={conflict} onDismiss={() => setConflict(null)} pending={sync.isPending} />
    </div>
  );
}
