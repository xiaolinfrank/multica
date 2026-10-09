"use client";

import { useRef, useState } from "react";
import {
  canRetryCockpitNasExport, cockpitNasDestination, cockpitNasExportActions, cockpitNasExportMatchesVersion,
  CockpitUnconfirmedWriteError, sameCockpitNasDestination, useExportCockpitMinutesToNas, useRetryCockpitNasExport,
} from "@multica/core/cockpit";
import type { CockpitMeetingWorkflow, CockpitNasDestination, CockpitNasExport } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { LocalPathLink } from "../../common/local-path-link";
import { useLocale, useT } from "../../i18n";

/** Mount per version: destination updates must never silently change the reader's selection. */
export function CockpitMinutesPublishControl({ workflow, disabled, pending, onPublish }: {
  workflow: CockpitMeetingWorkflow;
  disabled: boolean;
  pending: boolean;
  onPublish: (destination?: CockpitNasDestination) => void;
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
    {!destination && <p className="text-caption text-muted-foreground">{workflow.nas_unavailable_reason || t(($) => $.nas.no_destination)}</p>}
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

export function CockpitMinutesNasCopies({ wsId, workflow, userId, readOnly, disabled, onReload }: {
  wsId: string;
  workflow: CockpitMeetingWorkflow;
  userId: string;
  readOnly?: boolean;
  disabled: boolean;
  onReload: () => void;
}) {
  const { t } = useT("cockpit");
  const locale = useLocale();
  const requestExport = useExportCockpitMinutesToNas(wsId);
  const retryExport = useRetryCockpitNasExport(wsId);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState("");
  const actions = cockpitNasExportActions(workflow, userId);
  const disabledAction = readOnly || disabled || busy;

  async function run(command: () => Promise<unknown>) {
    if (lock.current || disabledAction) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try { await command(); }
    catch (cause) {
      setError(cause instanceof CockpitUnconfirmedWriteError ? t(($) => $.nas.unconfirmed)
        : cause instanceof Error ? cause.message : t(($) => $.workflow.command_failed));
    } finally { lock.current = false; setBusy(false); }
  }

  function statusLabel(job: CockpitNasExport, valid: boolean) {
    if (!valid || (job.status === "succeeded" && (!job.completed_at || job.size_bytes === null))) return t(($) => $.nas.incomplete);
    switch (job.status) {
      case "queued": return t(($) => $.nas.queued);
      case "running": return t(($) => $.nas.running);
      case "retry_wait": return t(($) => $.nas.retry_wait);
      case "succeeded": return t(($) => $.nas.succeeded);
      case "needs_attention": return t(($) => $.nas.needs_attention);
      default: return t(($) => $.nas.unknown_status, { status: job.status });
    }
  }

  if (!actions.published && workflow.nas_exports.length === 0) return null;
  return <section className="space-y-3 rounded-lg border border-border p-4" aria-label={t(($) => $.nas.title)}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-title-sm font-medium">{t(($) => $.nas.title)}</h3>
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onReload}>{t(($) => $.nas.refresh)}</Button>
    </div>
    {actions.published && <p className="text-caption font-medium">{t(($) => $.nas.official_version, { number: actions.published.version_number })}</p>}
    {actions.published && !actions.destination && <p className="text-caption text-muted-foreground">{workflow.nas_unavailable_reason || t(($) => $.nas.no_destination)}</p>}
    {actions.published && actions.destination && !actions.existing && <div className="space-y-2">
      <p className="text-caption text-muted-foreground">{t(($) => $.nas.configured_destination)}</p>
      <p dir="ltr" className="break-all font-mono text-caption">{actions.destination.directory}</p>
      {actions.canExport && !readOnly && <Button type="button" size="sm" variant="outline" disabled={disabledAction} aria-busy={requestExport.isPending}
        onClick={() => void run(() => requestExport.mutateAsync({ meetingId: workflow.meeting_id, versionId: actions.published!.id, destination: actions.destination! }))}>
        {requestExport.isPending && <Spinner />}{t(($) => $.nas.export)}</Button>}
    </div>}
    <p className="text-caption text-muted-foreground">{t(($) => $.nas.immutable_hint)}</p>
    {workflow.nas_exports.length === 0 && <p className="text-caption text-muted-foreground">{t(($) => $.nas.not_requested)}</p>}
    {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
    {[...workflow.nas_exports].sort((a, b) => b.version_number - a.version_number || b.created_at.localeCompare(a.created_at)).map((job) => {
      const valid = cockpitNasExportMatchesVersion(workflow, job);
      const succeeded = valid && job.status === "succeeded" && Boolean(job.completed_at) && job.size_bytes !== null;
      const active = job.status === "queued" || job.status === "running";
      const retryAt = job.next_retry_at ? new Date(job.next_retry_at) : null;
      return <article key={job.id} className="space-y-2 rounded-md bg-muted/40 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-caption">
          <span className="font-medium">{t(($) => $.workflow.version, { number: job.version_number })}</span>
          <span role="status" className="inline-flex items-center gap-1.5">{active && valid && <Spinner />}{statusLabel(job, valid)}</span>
        </div>
        {job.target_path && (succeeded ? <LocalPathLink path={job.target_path} className="text-caption" />
          : <p dir="ltr" className="break-all font-mono text-caption text-muted-foreground">{job.target_path}</p>)}
        {job.last_error && <p className="break-words text-caption text-destructive">{job.last_error}</p>}
        {job.status === "retry_wait" && retryAt && !Number.isNaN(retryAt.getTime()) && <p className="text-caption text-muted-foreground">
          {t(($) => $.nas.retry_at, { time: retryAt.toLocaleString(locale) })}</p>}
        {job.status === "needs_attention" && <p className="text-caption text-muted-foreground">{t(($) => $.nas.attention_hint)}</p>}
        {canRetryCockpitNasExport(workflow, job, userId) && !readOnly && <Button type="button" size="sm" variant="outline"
          disabled={disabledAction} aria-busy={retryExport.isPending && retryExport.variables?.operation.id === job.id}
          onClick={() => void run(() => retryExport.mutateAsync({ meetingId: workflow.meeting_id, operation: job }))}>
          {retryExport.isPending && retryExport.variables?.operation.id === job.id && <Spinner />}{t(($) => $.nas.retry)}</Button>}
      </article>;
    })}
  </section>;
}
