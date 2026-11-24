"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { issueDirectoryOptions, useEnsureIssueDirectory } from "@multica/core/directory";
import type { Issue, UpdateIssueRequest } from "@multica/core/types";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { FolderOpen, RefreshCw } from "@multica/ui/icons";
import { toast } from "sonner";
import { LocalPathLink, useLocalPathActions } from "../../common/local-path-link";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";

/**
 * The issue's delivery folder: the fixed path, its state, and the two things a
 * person can do about it — create it (or retry), and point the issue at a
 * folder name they already use.
 *
 * Read on demand, when the detail opens. The issue list never asks: most issues
 * never produce a file, and a share that is away must not make the list hang.
 */
export function IssueDeliveryDirectory({ issue, onUpdate, readOnly }: {
  issue: Issue;
  onUpdate: (updates: Partial<UpdateIssueRequest>) => void;
  readOnly?: boolean;
}) {
  const { t } = useT("cockpit");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const pathActions = useLocalPathActions();
  const query = useQuery(issueDirectoryOptions(wsId, issue.id));
  const ensure = useEnsureIssueDirectory(wsId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const status = query.data;
  const busy = ensure.isPending;

  if (query.isPending) {
    return <span role="status" className="flex items-center gap-2 text-caption text-muted-foreground"><Spinner />{t(($) => $.workflow.loading)}</span>;
  }
  if (!status) return <span className="text-caption text-muted-foreground">—</span>;

  const canFile = Boolean(issue.project_id);
  const noCollab = status.status === "no_collab_path";
  const needsCreate = status.status === "unallocated" || status.status === "missing";

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

  const saveName = () => {
    const next = draft.trim();
    if (!next) return;
    onUpdate({ directory_name: next });
    setEditing(false);
  };

  const statusLabel = (() => {
    switch (status.status) {
      case "ok": return t(($) => $.directories.status_ok);
      case "missing": return t(($) => $.directories.status_missing);
      case "unallocated": return t(($) => $.directories.issue_unallocated);
      case "root_unavailable": return t(($) => $.directories.status_root_unavailable);
      case "invalid": return t(($) => $.directories.status_invalid);
      default: return t(($) => $.directories.status_no_collab_path);
    }
  })();

  if (!canFile) {
    return <p className="text-caption text-muted-foreground">{t(($) => $.directories.issue_no_project)}</p>;
  }

  return (
    <div className="flex flex-col gap-1.5" data-issue-directory="">
      {status.full_path ? (
        <LocalPathLink path={status.full_path} wrap="truncate" />
      ) : (
        <span className="text-caption text-muted-foreground">{statusLabel}</span>
      )}
      <div className="flex flex-wrap items-center gap-2 text-caption">
        {status.full_path && <span className="text-muted-foreground">{statusLabel}</span>}
        <Button type="button" size="sm" variant="ghost" disabled={noCollab || busy} aria-busy={busy} onClick={openOrCreate}>
          {busy ? <Spinner /> : needsCreate ? <RefreshCw className="size-3" aria-hidden /> : <FolderOpen className="size-3" aria-hidden />}
          {needsCreate ? t(($) => $.directories.retry) : t(($) => $.directories.open)}
        </Button>
        {status.full_path && (
          <Button type="button" size="sm" variant="ghost" onClick={() => { if (status.full_path) void pathActions.copy(status.full_path); }}>
            {t(($) => $.directories.copy)}
          </Button>
        )}
        {!readOnly && !noCollab && !editing && (
          <Button type="button" size="sm" variant="ghost"
            onClick={() => { setDraft(status.directory_name ?? ""); setEditing(true); }}>
            {t(($) => $.directories.issue_edit)}
          </Button>
        )}
        {noCollab && issue.project_id && (
          <AppLink href={paths.projectDetail(issue.project_id)} className="text-primary hover:underline">
            {t(($) => $.directories.setting)}
          </AppLink>
        )}
      </div>
      {editing && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Input autoFocus value={draft} onChange={(event) => setDraft(event.target.value)}
              aria-label={t(($) => $.directories.issue_edit)}
              className="h-7 text-caption"
              onKeyDown={(event) => { if (event.key === "Enter") saveName(); if (event.key === "Escape") setEditing(false); }} />
            <Button type="button" size="sm" disabled={!draft.trim()} onClick={saveName}>{t(($) => $.directories.issue_save)}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>{t(($) => $.directories.cancel)}</Button>
          </div>
          <p className="text-micro text-muted-foreground">{t(($) => $.directories.issue_edit_hint)}</p>
        </div>
      )}
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
