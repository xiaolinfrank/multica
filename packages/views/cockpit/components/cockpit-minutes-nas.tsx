"use client";

import { useRef, useState } from "react";
import {
  cockpitNasDestination, cockpitNasWriteMode, cockpitWorkflowNasExportValid,
  CockpitUnconfirmedWriteError, sameCockpitNasDestination, useExportCockpitMinutesToNas, useRetryCockpitNasExport,
  useUnpublishCockpitMinutesVersion,
} from "@multica/core/cockpit";
import type { CockpitMeetingWorkflowSummary, CockpitNasDestination, CockpitWorkflowNasExport } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@multica/ui/components/ui/collapsible";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@multica/ui/components/ui/dialog";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { copyText } from "@multica/ui/lib/clipboard";
import { LocalPathLink } from "../../common/local-path-link";
import { useLocale, useT } from "../../i18n";
import { CockpitNasAttempts } from "./cockpit-nas-attempts";

function NasWriteMode({ destination }: { destination: { write_mode?: string } }) {
  const { t } = useT("cockpit");
  const mode = cockpitNasWriteMode(destination);
  return <div className="space-y-1 text-caption"><p className="font-medium">{mode === "atomic" ? t(($) => $.nas.mode_atomic)
    : mode === "create_only" ? t(($) => $.nas.mode_create_only) : t(($) => $.nas.unknown_mode, { mode })}</p>
    {mode === "create_only" && <p className="text-muted-foreground">{t(($) => $.nas.create_only_visibility)}</p>}</div>;
}

function NasDeploymentHelp() {
  const { t } = useT("cockpit");
  return <details className="text-caption"><summary className="cursor-pointer text-primary">{t(($) => $.nas.deployment_help)}</summary>
    <div className="mt-2 space-y-2 rounded-md bg-muted/40 p-3">
      <p>{t(($) => $.nas.deployment_roots)}</p>
      <pre dir="ltr" className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-micro">{'COCKPIT_NAS_EXPORT_ROOTS=[{"workspace_id":"<workspace UUID>","root_id":"<root UUID>","path":"/mounted/share/workspace","allow_local":false}]'}</pre>
      <p>{t(($) => $.nas.deployment_identity)}</p><p>{t(($) => $.nas.deployment_access)}</p>
      <p>{t(($) => $.nas.deployment_create_only)}</p>
    </div>
  </details>;
}

function NasDestinationRecovery({ reason }: { reason: string }) {
  const { t } = useT("cockpit");
  const message = reason === "not_configured" ? t(($) => $.nas.not_configured)
    : reason === "directory_missing" ? t(($) => $.nas.directory_missing)
      : reason === "outside_root" ? t(($) => $.nas.outside_root)
        : reason === "unsupported_platform" ? t(($) => $.nas.unsupported_storage)
          : reason || t(($) => $.nas.no_destination);
  // Recovery happens where the directory facts live — the meeting's own
  // metadata and its directory maintenance; there is no separate materials
  // tab to link to anymore.
  return <div className="space-y-2 text-caption"><p className="break-words text-muted-foreground">{message}</p>
    {(reason === "not_configured" || reason === "unsupported_platform" || !reason) && <NasDeploymentHelp />}
  </div>;
}

function NasVerifiedCopy({ wsId, meetingId, job }: { wsId: string; meetingId: string; job: CockpitWorkflowNasExport }) {
  const { t } = useT("cockpit");
  const [open, setOpen] = useState(false);
  const [copyResult, setCopyResult] = useState<"copied" | "failed" | "">("");
  const createOnly = cockpitNasWriteMode(job) === "create_only";
  const path = createOnly ? job.verified_path! : job.target_path;
  async function copyPath() {
    try { setCopyResult(await copyText(path) ? "copied" : "failed"); }
    catch { setCopyResult("failed"); }
  }
  return <div className="space-y-2 text-caption">
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <LocalPathLink path={path} className="text-caption">{createOnly ? t(($) => $.nas.open_verified_copy) : t(($) => $.nas.open_copy)}</LocalPathLink>
      <Button type="button" variant="ghost" size="xs" onClick={() => void copyPath()}>{createOnly ? t(($) => $.nas.copy_verified_path) : t(($) => $.nas.copy_target)}</Button>
    </div>
    {copyResult === "failed" && <p dir="ltr" className="break-all font-mono text-micro">{path}</p>}
    {copyResult && <p role="status" className={copyResult === "failed" ? "text-destructive" : "text-muted-foreground"}>{copyResult === "copied" ? t(($) => $.nas.target_copied) : t(($) => $.nas.copy_failed)}</p>}
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger render={<Button type="button" variant="ghost" size="sm" />}>{t(($) => $.nas.copy_details)}</CollapsibleTrigger>
      <CollapsibleContent>
        {open && <div className="mt-2 space-y-3">
          <NasWriteMode destination={job} />
          <dl className="space-y-2">
            <div><dt className="text-muted-foreground">{t(($) => $.nas.actual_path)}</dt><dd dir="ltr" className="break-all font-mono text-micro">{path}</dd></div>
            {createOnly && <div><dt className="text-muted-foreground">{t(($) => $.nas.fixed_target)}</dt><dd dir="ltr" className="break-all font-mono text-micro">{job.target_path}</dd></div>}
          </dl>
          {createOnly && <p className="text-muted-foreground">{t(($) => $.nas.logical_target_hint)}</p>}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {job.directory && <LocalPathLink path={job.directory} className="text-caption">{t(($) => $.nas.open_frozen_directory)}</LocalPathLink>}
            {createOnly && job.receipt_path && <LocalPathLink path={job.receipt_path} className="text-caption">{t(($) => $.nas.open_completion_record)}</LocalPathLink>}
          </div>
          {createOnly && <p className="text-muted-foreground">{t(($) => $.nas.recorded_verification)}</p>}
          <p className="text-muted-foreground">{t(($) => $.nas.immutable_hint)}</p>
          {createOnly && <CockpitNasAttempts key={`${wsId}:${meetingId}:${job.id}`} wsId={wsId} meetingId={meetingId} exportId={job.id} />}
        </div>}
      </CollapsibleContent>
    </Collapsible>
  </div>;
}

function NasExportTarget({ job }: { job: CockpitWorkflowNasExport }) {
  const { t } = useT("cockpit");
  const [copyResult, setCopyResult] = useState<"copied" | "failed" | "">("");
  const createOnly = cockpitNasWriteMode(job) === "create_only";
  async function copyTarget() {
    try { setCopyResult(await copyText(job.target_path) ? "copied" : "failed"); }
    catch { setCopyResult("failed"); }
  }
  return <div className="space-y-2 text-caption">
    {job.target_path && <><p dir="ltr" className="break-all font-mono text-muted-foreground">{job.target_path}</p>
      {createOnly && <p className="text-muted-foreground">{t(($) => $.nas.logical_target_hint)}</p>}
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
export function CockpitMinutesPublishControl({ workflow, disabled, pending, onPublish }: {
  workflow: CockpitMeetingWorkflowSummary;
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
    {(selected || destination) && <NasWriteMode destination={(selected || destination)!} />}
    {!destination && <NasDestinationRecovery reason={workflow.nas_unavailable_reason} />}
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

export function CockpitNasExportList({ wsId, workflow, jobs, userId, readOnly, disabled, official = false }: {
  wsId: string; workflow: CockpitMeetingWorkflowSummary; jobs: CockpitWorkflowNasExport[]; userId: string; readOnly?: boolean; disabled: boolean; official?: boolean;
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
        <div className="flex flex-wrap items-center justify-between gap-2 text-caption"><span className="font-medium">{official ? t(($) => $.nas.official_version, { number: job.version_number }) : t(($) => $.workflow.version, { number: job.version_number })}</span>
          <span role="status" className="inline-flex items-center gap-1.5">{valid && ["queued", "running"].includes(job.status) && <Spinner />}{statusLabel(job, valid)}</span></div>
        {succeeded ? <NasVerifiedCopy wsId={wsId} meetingId={workflow.meeting_id} job={job} />
          : <><NasWriteMode destination={job} /><NasExportTarget job={job} /></>}
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
        {!succeeded && cockpitNasWriteMode(job) === "create_only" && <CockpitNasAttempts key={`${wsId}:${workflow.meeting_id}:${job.id}`} wsId={wsId} meetingId={workflow.meeting_id} exportId={job.id} />}
      </article>;
    })}
  </div>;
}

/** R2 (design-principles-2026-10-12): withdrawing the official minutes is a
 * re-decision, not a deletion; the reason stays in the version's history. */
function OfficialMinutesWithdrawal({ wsId, workflow, disabled }: {
  wsId: string; workflow: CockpitMeetingWorkflowSummary; disabled: boolean;
}) {
  const { t } = useT("cockpit");
  const unpublish = useUnpublishCockpitMinutesVersion(wsId);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const lock = useRef(false);
  const published = workflow.published_version;
  const trimmed = reason.trim();
  async function withdraw() {
    if (lock.current || !published || !trimmed) return;
    lock.current = true; setError("");
    try {
      await unpublish.mutateAsync({ meetingId: workflow.meeting_id, versionId: published.id, revision: workflow.revision, reason: trimmed });
      setOpen(false); setReason("");
    } catch (cause) {
      setError(cause instanceof CockpitUnconfirmedWriteError ? t(($) => $.workflow.unconfirmed)
        : cause instanceof Error ? cause.message : t(($) => $.workflow.command_failed));
    } finally { lock.current = false; }
  }
  return <Dialog open={open} onOpenChange={(next) => {
    if (unpublish.isPending) return;
    setOpen(next);
    if (!next) setError("");
  }}>
    <DialogTrigger render={<Button type="button" size="sm" variant="outline" disabled={disabled} />}>{t(($) => $.workflow.unpublish)}</DialogTrigger>
    <DialogContent className="sm:max-w-lg" showCloseButton={!unpublish.isPending}><DialogHeader>
      <DialogTitle>{t(($) => $.workflow.unpublish)}</DialogTitle>
      <DialogDescription>{t(($) => $.workflow.unpublish_description)}</DialogDescription>
    </DialogHeader>
      {published && <p className="text-caption text-muted-foreground">{t(($) => $.workflow.version, { number: published.version_number })}</p>}
      <label className="space-y-1 text-caption">{t(($) => $.workflow.unpublish_reason)}
        <Textarea value={reason} rows={3} disabled={unpublish.isPending} onChange={(event) => setReason(event.target.value)} /></label>
      <p className="text-caption text-muted-foreground">{t(($) => $.workflow.unpublish_reason_hint)}</p>
      {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" disabled={unpublish.isPending} />}>{t(($) => $.binding.cancel)}</DialogClose>
        <Button type="button" disabled={!trimmed || unpublish.isPending} aria-busy={unpublish.isPending} onClick={() => void withdraw()}>
          {unpublish.isPending && <Spinner />}{t(($) => $.workflow.unpublish_confirm)}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function CockpitMinutesNasCopies({ wsId, workflow, userId, readOnly, disabled, onReload, onOpenHistory }: {
  wsId: string; workflow: CockpitMeetingWorkflowSummary; userId: string; readOnly?: boolean; disabled: boolean; onReload: () => void; onOpenHistory: () => void;
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
      <div className="flex flex-wrap items-center gap-2">
        {published && workflow.can_manage && !readOnly && <OfficialMinutesWithdrawal wsId={wsId} workflow={workflow} disabled={disabled || request.isPending} />}
        <Button type="button" size="sm" variant="ghost" disabled={request.isPending} onClick={onReload}>{t(($) => $.nas.refresh)}</Button>
      </div></div>
    {published && !existing && <p className="text-caption font-medium">{t(($) => $.nas.official_version, { number: published.version_number })}</p>}
    {published && !destination && <NasDestinationRecovery reason={workflow.nas_unavailable_reason} />}
    {published && destination && !existing && <div className="space-y-2"><p className="text-caption text-muted-foreground">{t(($) => $.nas.configured_destination)}</p>
      <p dir="ltr" className="break-all font-mono text-caption">{destination.directory}</p>
      <NasWriteMode destination={destination} />
      {canExport && !readOnly && <Button type="button" size="sm" variant="outline" disabled={disabled || request.isPending} aria-busy={request.isPending} onClick={() => void exportMinutes()}>
        {request.isPending && <Spinner />}{t(($) => $.nas.export)}</Button>}</div>}
    {!existing && <p className="text-caption text-muted-foreground">{t(($) => $.nas.immutable_hint)}</p>}
    {!existing && <p className="text-caption text-muted-foreground">{t(($) => $.minutes_history.no_current_copy)}</p>}
    {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
    {existing && <CockpitNasExportList wsId={wsId} workflow={workflow} jobs={[existing]} userId={userId} readOnly={readOnly} disabled={disabled} official />}
    {workflow.history_counts.nas_exports > 0 && <Button type="button" size="sm" variant="ghost" onClick={onOpenHistory}>{t(($) => $.minutes_history.export_history, { count: workflow.history_counts.nas_exports })}</Button>}
  </section>;
}
