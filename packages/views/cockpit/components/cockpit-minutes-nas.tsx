"use client";

import { useRef, useState } from "react";
import {
  cockpitNasDestination, cockpitWorkflowNasExportValid,
  CockpitUnconfirmedWriteError, sameCockpitNasDestination, useExportCockpitMinutesToNas, useRetryCockpitNasExport,
} from "@multica/core/cockpit";
import type { CockpitMeetingWorkflowSummary, CockpitNasDestination, CockpitWorkflowNasExport } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { copyText } from "@multica/ui/lib/clipboard";
import { LocalPathLink } from "../../common/local-path-link";
import { AppLink } from "../../navigation";
import { useLocale, useT } from "../../i18n";

function NasDeploymentHelp() {
  const { t } = useT("cockpit");
  return <details className="text-caption"><summary className="cursor-pointer text-primary">{t(($) => $.nas.deployment_help)}</summary>
    <div className="mt-2 space-y-2 rounded-md bg-muted/40 p-3">
      <p>{t(($) => $.nas.deployment_roots)}</p>
      <pre dir="ltr" className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-micro">{'COCKPIT_NAS_EXPORT_ROOTS=[{"workspace_id":"<workspace UUID>","root_id":"<root UUID>","path":"/mounted/share/workspace","allow_local":false}]'}</pre>
      <p>{t(($) => $.nas.deployment_identity)}</p><p>{t(($) => $.nas.deployment_access)}</p>
    </div>
  </details>;
}

function NasDestinationRecovery({ reason, resourcesHref }: { reason: string; resourcesHref: string }) {
  const { t } = useT("cockpit");
  const message = reason === "not_configured" ? t(($) => $.nas.not_configured)
    : reason === "directory_missing" ? t(($) => $.nas.directory_missing)
      : reason === "outside_root" ? t(($) => $.nas.outside_root)
        : reason === "unsupported_platform" ? t(($) => $.nas.unsupported_storage)
          : reason || t(($) => $.nas.no_destination);
  return <div className="space-y-2 text-caption"><p className="break-words text-muted-foreground">{message}</p>
    {reason !== "not_configured" && reason !== "unsupported_platform" && <AppLink href={resourcesHref}
      className="rounded-sm text-primary underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring">{t(($) => $.nas.configure_materials)}</AppLink>}
    {(reason === "not_configured" || reason === "unsupported_platform" || !reason) && <NasDeploymentHelp />}
  </div>;
}

function NasExportTarget({ job, succeeded }: { job: CockpitWorkflowNasExport; succeeded: boolean }) {
  const { t } = useT("cockpit");
  const [copyResult, setCopyResult] = useState<"copied" | "failed" | "">("");
  async function copyTarget() {
    try { setCopyResult(await copyText(job.target_path) ? "copied" : "failed"); }
    catch { setCopyResult("failed"); }
  }
  return <div className="space-y-2 text-caption">
    {job.target_path && <><div title={job.target_path}>{succeeded ? <LocalPathLink path={job.target_path} className="text-caption" />
      : <p dir="ltr" className="break-all font-mono text-muted-foreground">{job.target_path}</p>}</div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {job.directory && <LocalPathLink path={job.directory} className="text-caption">{t(($) => $.nas.open_frozen_directory)}</LocalPathLink>}
        <Button type="button" variant="ghost" size="xs" onClick={() => void copyTarget()}>{t(($) => $.nas.copy_target)}</Button>
      </div>
      {copyResult && <p role="status" className={copyResult === "failed" ? "text-destructive" : "text-muted-foreground"}>{copyResult === "copied" ? t(($) => $.nas.target_copied) : t(($) => $.nas.copy_failed)}</p>}
    </>}
  </div>;
}

function NasOperationRecovery({ code }: { code: string }) {
  const { t } = useT("cockpit");
  const unsupported = ["unsupported_commit", "unsupported_sync", "unsupported_platform"].includes(code);
  const message = unsupported ? t(($) => $.nas.unsupported_storage)
    : code === "permission_denied" ? t(($) => $.nas.permission_recovery)
      : code === "file_conflict" ? t(($) => $.nas.conflict_recovery)
        : ["root_changed", "path_changed", "identity_mismatch", "unsafe_path"].includes(code) ? t(($) => $.nas.identity_recovery)
          : ["storage_unavailable", "root_unavailable", "mount_unavailable"].includes(code) ? t(($) => $.nas.mount_recovery)
            : t(($) => $.nas.attention_hint);
  return <div className="space-y-2 text-caption text-muted-foreground"><p>{message}</p>
    <p>{t(($) => $.nas.frozen_retry)}</p>
    {(unsupported || ["root_changed", "identity_mismatch", "permission_denied"].includes(code)) && <NasDeploymentHelp />}
  </div>;
}

/** Mount per version: destination updates must never silently change the reader's selection. */
export function CockpitMinutesPublishControl({ workflow, disabled, pending, onPublish, resourcesHref }: {
  workflow: CockpitMeetingWorkflowSummary;
  disabled: boolean;
  pending: boolean;
  onPublish: (destination?: CockpitNasDestination) => void;
  resourcesHref: string;
}) {
  const { t } = useT("cockpit");
  const destination = cockpitNasDestination(workflow);
  const [selected, setSelected] = useState<CockpitNasDestination | null>(() => destination);
  const changed = Boolean(selected && !sameCockpitNasDestination(selected, destination));
  return <div className="space-y-3">
    <p className="text-caption text-muted-foreground">{t(($) => $.workflow.publish_hint)}</p>
    <label className="flex items-start gap-2 text-caption"><Checkbox checked={Boolean(selected)}
      disabled={disabled || pending || (!destination && !selected)}
      onCheckedChange={(checked) => setSelected(checked === true ? destination : null)} />
      {t(($) => $.nas.sync_on_publish)}</label>
    {(selected || destination) && <p dir="ltr" className="break-all font-mono text-caption text-muted-foreground">{(selected || destination)?.directory}</p>}
    {!destination && <NasDestinationRecovery reason={workflow.nas_unavailable_reason} resourcesHref={resourcesHref} />}
    {selected && <p className="text-caption text-muted-foreground">{t(($) => $.nas.publish_queue_hint)}</p>}
    {changed && <div role="alert" className="space-y-2 text-caption">
      <p>{t(($) => $.nas.destination_changed)}</p>
      {destination && <Button type="button" size="sm" variant="outline" disabled={disabled || pending} onClick={() => setSelected(destination)}>
        {t(($) => $.nas.use_updated_destination)}</Button>}
    </div>}
    <Button type="button" size="sm" disabled={disabled || pending || changed} aria-busy={pending}
      onClick={() => onPublish(selected || undefined)}>{pending && <Spinner />}{t(($) => $.workflow.publish)}</Button>
  </div>;
}

export function CockpitNasExportList({ wsId, workflow, jobs, userId, readOnly, disabled }: {
  wsId: string; workflow: CockpitMeetingWorkflowSummary; jobs: CockpitWorkflowNasExport[]; userId: string; readOnly?: boolean; disabled: boolean;
}) {
  const { t } = useT("cockpit");
  const locale = useLocale();
  const retry = useRetryCockpitNasExport(wsId);
  const lock = useRef(false);
  const [error, setError] = useState("");
  function statusLabel(job: CockpitWorkflowNasExport, valid: boolean) {
    if (!valid) return t(($) => $.nas.incomplete);
    switch (job.status) {
      case "queued": return t(($) => $.nas.queued);
      case "running": return t(($) => $.nas.running);
      case "retry_wait": return t(($) => $.nas.retry_wait);
      case "succeeded": return t(($) => $.nas.succeeded);
      case "needs_attention": return t(($) => $.nas.needs_attention);
      default: return t(($) => $.nas.unknown_status, { status: job.status });
    }
  }
  async function retryJob(job: CockpitWorkflowNasExport) {
    if (lock.current || disabled || readOnly) return;
    lock.current = true; setError("");
    try { await retry.mutateAsync({ meetingId: workflow.meeting_id, operation: job }); }
    catch (cause) { setError(cause instanceof CockpitUnconfirmedWriteError ? t(($) => $.nas.unconfirmed) : cause instanceof Error ? cause.message : t(($) => $.workflow.command_failed)); }
    finally { lock.current = false; }
  }
  return <div className="space-y-3">{error && <p role="alert" className="text-caption text-destructive">{error}</p>}
    {jobs.map((job) => {
      const valid = cockpitWorkflowNasExportValid(workflow, job);
      const succeeded = valid && job.status === "succeeded";
      const canRetry = valid && userId && job.can_retry && ["retry_wait", "needs_attention"].includes(job.status)
        && (workflow.can_manage || job.source_version.reviewer_id === userId);
      const retryAt = job.next_retry_at ? new Date(job.next_retry_at) : null;
      return <article key={job.id} className="space-y-2 rounded-md bg-muted/40 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-caption"><span className="font-medium">{t(($) => $.workflow.version, { number: job.version_number })}</span>
          <span role="status" className="inline-flex items-center gap-1.5">{valid && ["queued", "running"].includes(job.status) && <Spinner />}{statusLabel(job, valid)}</span></div>
        <NasExportTarget job={job} succeeded={succeeded} />
        {(job.last_error || job.last_error_code) && <details className="text-caption"><summary className="cursor-pointer text-destructive">{t(($) => $.nas.error_details)}</summary>
          <div className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-destructive">
            {job.last_error_code && <p className="font-mono">{job.last_error_code}</p>}{job.last_error && <p>{job.last_error}</p>}
          </div>
        </details>}
        {job.status === "retry_wait" && retryAt && !Number.isNaN(retryAt.getTime()) && <p className="text-caption text-muted-foreground">{t(($) => $.nas.retry_at, { time: retryAt.toLocaleString(locale) })}</p>}
        {["needs_attention", "retry_wait"].includes(job.status) && <NasOperationRecovery code={job.last_error_code} />}
        {canRetry && !readOnly && <Button type="button" size="sm" variant="outline" disabled={disabled || retry.isPending}
          aria-busy={retry.isPending && retry.variables?.operation.id === job.id} onClick={() => void retryJob(job)}>
          {retry.isPending && retry.variables?.operation.id === job.id && <Spinner />}{["unsupported_commit", "unsupported_sync", "unsupported_platform"].includes(job.last_error_code)
            ? t(($) => $.nas.retry_after_storage_fix) : t(($) => $.nas.retry)}</Button>}
      </article>;
    })}
  </div>;
}

export function CockpitMinutesNasCopies({ wsId, workflow, userId, readOnly, disabled, onReload, onOpenHistory, resourcesHref }: {
  wsId: string; workflow: CockpitMeetingWorkflowSummary; userId: string; readOnly?: boolean; disabled: boolean; onReload: () => void; onOpenHistory: () => void; resourcesHref: string;
}) {
  const { t } = useT("cockpit");
  const request = useExportCockpitMinutesToNas(wsId);
  const lock = useRef(false);
  const [error, setError] = useState("");
  const published = workflow.published_version;
  const destination = cockpitNasDestination(workflow);
  const existing = workflow.published_nas_export;
  const canExport = Boolean(workflow.enabled && userId && workflow.can_export_nas && published?.published_at && published.decision === "approved"
    && published.content_hash && published.source_issue_id === workflow.minutes_issue?.id && (workflow.can_manage || published.reviewer_id === userId) && destination && !existing);
  async function exportMinutes() {
    if (lock.current || !canExport || !published || !destination || readOnly || disabled) return;
    lock.current = true; setError("");
    try { await request.mutateAsync({ meetingId: workflow.meeting_id, versionId: published.id, destination }); }
    catch (cause) { setError(cause instanceof CockpitUnconfirmedWriteError ? t(($) => $.nas.unconfirmed) : cause instanceof Error ? cause.message : t(($) => $.workflow.command_failed)); }
    finally { lock.current = false; }
  }
  if (!published && workflow.history_counts.nas_exports === 0) return null;
  return <section className="space-y-3 rounded-lg border border-border p-4" aria-label={t(($) => $.nas.title)}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-title-sm font-medium">{t(($) => $.nas.title)}</h3>
      <Button type="button" size="sm" variant="ghost" disabled={request.isPending} onClick={onReload}>{t(($) => $.nas.refresh)}</Button></div>
    {published && <p className="text-caption font-medium">{t(($) => $.nas.official_version, { number: published.version_number })}</p>}
    {published && !destination && <NasDestinationRecovery reason={workflow.nas_unavailable_reason} resourcesHref={resourcesHref} />}
    {published && destination && !existing && <div className="space-y-2"><p className="text-caption text-muted-foreground">{t(($) => $.nas.configured_destination)}</p>
      <p dir="ltr" className="break-all font-mono text-caption">{destination.directory}</p>
      {canExport && !readOnly && <Button type="button" size="sm" variant="outline" disabled={disabled || request.isPending} aria-busy={request.isPending} onClick={() => void exportMinutes()}>
        {request.isPending && <Spinner />}{t(($) => $.nas.export)}</Button>}</div>}
    <p className="text-caption text-muted-foreground">{t(($) => $.nas.immutable_hint)}</p>
    {!existing && <p className="text-caption text-muted-foreground">{t(($) => $.minutes_history.no_current_copy)}</p>}
    {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
    {existing && <CockpitNasExportList wsId={wsId} workflow={workflow} jobs={[existing]} userId={userId} readOnly={readOnly} disabled={disabled} />}
    {workflow.history_counts.nas_exports > 0 && <Button type="button" size="sm" variant="ghost" onClick={onOpenHistory}>{t(($) => $.minutes_history.export_history, { count: workflow.history_counts.nas_exports })}</Button>}
  </section>;
}
