"use client";

import { useQuery } from "@tanstack/react-query";
import { cockpitMeetingDirectoryPath } from "@multica/core/cockpit";
import { issueDirectoryOptions, useEnsureIssueDirectory } from "@multica/core/directory";
import type { Issue } from "@multica/core/types";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { FolderOpen, RefreshCw } from "@multica/ui/icons";
import { toast } from "sonner";
import { LocalPathLink, useLocalPathActions } from "../../common/local-path-link";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";

/**
 * The folder the issue delivers into (its meeting's folder, or the one it is
 * filed under): the path, its state, and opening or copying it. A missing
 * filing folder is created on retry; a meeting folder is prepared from its
 * meeting, so a meeting folder that is not ready links there.
 *
 * Read on demand, when the detail opens. The issue list never asks: most issues
 * never produce a file, and a share that is away must not make the list hang.
 */
export function IssueDeliveryDirectory({ issue }: { issue: Issue }) {
  const { t } = useT("cockpit");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const pathActions = useLocalPathActions();
  const query = useQuery(issueDirectoryOptions(wsId, issue.id));
  const ensure = useEnsureIssueDirectory(wsId);

  const status = query.data;
  const busy = ensure.isPending;

  if (query.isPending) {
    return <span role="status" className="flex items-center gap-2 text-caption text-muted-foreground"><Spinner />{t(($) => $.workflow.loading)}</span>;
  }
  if (!status) return <span className="text-caption text-muted-foreground">—</span>;

  const noCollab = status.status === "no_collab_path";
  const meetingFolder = status.source === "meeting";
  const meetingMissing = meetingFolder && status.status === "missing";
  const needsCreate = status.status === "missing" && !meetingFolder;

  const openOrCreate = () => {
    if (status.full_path && status.status === "ok") {
      void pathActions.open(status.full_path);
      return;
    }
    ensure.mutate(issue.id, {
      onSuccess: (result) => {
        if (result.status === "ok" && result.full_path) void pathActions.open(result.full_path);
        else toast.error(t(($) => $.directories.sync_failed, { reason: result.error || result.status }));
      },
      onError: (error) => toast.error(error instanceof Error ? error.message : t(($) => $.errors.save_failed)),
    });
  };

  const statusLabel = (() => {
    switch (status.status) {
      case "ok": return t(($) => $.directories.status_ok);
      case "missing": return t(($) => $.directories.status_missing);
      case "root_unavailable": return t(($) => $.directories.status_root_unavailable);
      case "invalid": return t(($) => $.directories.status_invalid);
      default: return t(($) => $.directories.status_no_collab_path);
    }
  })();

  // A meeting folder exists without a filing, so only a missing path asks for one.
  if (!issue.project_id && !status.full_path) {
    return <p className="text-caption text-muted-foreground">{t(($) => $.directories.issue_no_project)}</p>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-issue-directory="">
      {status.full_path ? (
        <LocalPathLink path={status.full_path} wrap="truncate" />
      ) : (
        <span className="text-caption text-muted-foreground">{statusLabel}</span>
      )}
      <div className="flex flex-wrap items-center gap-2 text-caption">
        {status.full_path && <span className="text-muted-foreground">{statusLabel}</span>}
        {!meetingMissing && (
          <Button type="button" size="sm" variant="ghost" disabled={noCollab || busy} aria-busy={busy} onClick={openOrCreate}>
            {busy ? <Spinner /> : needsCreate ? <RefreshCw className="size-3" aria-hidden /> : <FolderOpen className="size-3" aria-hidden />}
            {needsCreate ? t(($) => $.directories.retry) : t(($) => $.directories.open)}
          </Button>
        )}
        {meetingFolder && status.status !== "ok" && status.meeting_id && (
          <AppLink href={cockpitMeetingDirectoryPath(paths.cockpit(), status.meeting_id, null, new URLSearchParams())} className="text-primary hover:underline">
            {t(($) => $.meeting_lifecycle.open_meeting)}
          </AppLink>
        )}
        {status.full_path && (
          <Button type="button" size="sm" variant="ghost" onClick={() => { if (status.full_path) void pathActions.copy(status.full_path); }}>
            {t(($) => $.directories.copy)}
          </Button>
        )}
        {noCollab && issue.project_id && (
          <AppLink href={paths.projectDetail(issue.project_id)} className="text-primary hover:underline">
            {t(($) => $.directories.setting)}
          </AppLink>
        )}
      </div>
      {meetingMissing && <p className="text-micro text-muted-foreground">{t(($) => $.directories.issue_meeting_missing)}</p>}
      {status.error && <p className="text-micro text-destructive">{status.error}</p>}
      {status.shared_collab_projects.length > 0 && (
        <p className="text-micro text-muted-foreground">
          {t(($) => $.directories.shared_warning, {
            names: status.shared_collab_projects.map((entry) => `${entry.workspace_name} / ${entry.project_title}`).join("、"),
          })}
        </p>
      )}
    </div>
  );
}
