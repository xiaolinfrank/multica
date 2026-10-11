"use client";

import { useState } from "react";
import type { CockpitDirectoryTarget, CockpitDirectoryPreview, CockpitDirectoryPrincipal, CockpitDirectoryCounts } from "@multica/core/types";
import { cn } from "@multica/ui/lib/utils";
import { useLocale, useT } from "../../i18n";
import { LocalPathLink } from "../../common/local-path-link";
import { CollabPathCopyButton } from "../../projects/components/collab-path";
import { CockpitFlowPaging } from "./cockpit-task-flow";

export const knownDirectoryStates = new Set(["active", "paused", "needs_attention", "completed", "abandoned"]);
export const knownDirectoryStepStates = new Set(["pending", "running", "retry_wait", "satisfied", "needs_attention", "abandoned"]);
export const retryableDirectoryStep = (step: { kind: string; state: string; can_retry: boolean }) => step.can_retry
  && (["needs_attention", "retry_wait"].includes(step.state) || step.kind === "base" && step.state === "pending");
export const supportsDirectoryPreview = (steps: { kind: string; planned_state: string }[]) => steps.length > 0 && steps.length <= 32
  && steps.every((step) => ["ancestor", "base", "partition"].includes(step.kind) && ["exists", "missing", "conflict", "unknown"].includes(step.planned_state));

export function useDirectoryLabel() {
  const { t } = useT("cockpit");
  const labels: Record<string, string> = {
    active: t(($) => $.meeting_directory.active), paused: t(($) => $.meeting_directory.paused), needs_attention: t(($) => $.meeting_directory.needs_attention), completed: t(($) => $.meeting_directory.completed), abandoned: t(($) => $.meeting_directory.abandoned),
    pending: t(($) => $.meeting_directory.pending), running: t(($) => $.meeting_directory.running), retry_wait: t(($) => $.meeting_directory.retry_wait), satisfied: t(($) => $.meeting_directory.satisfied),
    succeeded: t(($) => $.meeting_directory.succeeded), failed: t(($) => $.meeting_directory.failed), expired: t(($) => $.meeting_directory.expired),
    created: t(($) => $.meeting_directory.created), observed_existing: t(($) => $.meeting_directory.observed_existing),
    exists: t(($) => $.meeting_directory.exists), missing: t(($) => $.meeting_directory.missing), conflict: t(($) => $.meeting_directory.conflict),
    ancestor: t(($) => $.meeting_directory.ancestor), base: t(($) => $.meeting_directory.base), partition: t(($) => $.meeting_directory.partition),
  };
  return (value: string | null | undefined) => value && labels[value] || t(($) => $.meeting_directory.unknown);
}

export function CockpitDirectoryReasons({ codes }: { codes: string[] }) {
  const { t } = useT("cockpit");
  const labels: Record<string, string> = {
    prepare_not_configured: t(($) => $.meeting_directory.prepare_not_configured), prepare_configuration_invalid: t(($) => $.meeting_directory.configuration_invalid),
    root_target_changed: t(($) => $.meeting_directory.target_changed), prepare_path_outside_scope: t(($) => $.meeting_directory.outside_scope),
    root_unavailable: t(($) => $.meeting_directory.root_unavailable), mount_unavailable: t(($) => $.meeting_directory.root_unavailable), root_identity_mismatch: t(($) => $.meeting_directory.root_identity),
    path_is_file: t(($) => $.meeting_directory.path_conflict), symlink_not_allowed: t(($) => $.meeting_directory.path_conflict), directory_identity_changed: t(($) => $.meeting_directory.path_conflict),
    binding_changed: t(($) => $.meeting_directory.binding_changed), base_reauthorization_required: t(($) => $.meeting_directory.base_reauthorization_required), root_config_changed: t(($) => $.meeting_directory.root_changed), permission_revoked: t(($) => $.meeting_directory.permission_revoked),
    meeting_cancelled: t(($) => $.meeting_directory.meeting_cancelled), meeting_archived: t(($) => $.meeting_directory.meeting_archived),
    task_context_required: t(($) => $.meeting_directory.delegation_unavailable), delegation_unavailable: t(($) => $.meeting_directory.delegation_unavailable), source_run_unavailable: t(($) => $.meeting_directory.delegation_unavailable),
    io_timeout: t(($) => $.meeting_directory.io_failed), io_failed: t(($) => $.meeting_directory.io_failed), directory_retry_required: t(($) => $.meeting_directory.retry_required),
  };
  if (codes.length === 0) return null;
  return <div className="space-y-2 text-caption text-muted-foreground">{[...new Set(codes.map((code) => labels[code] ?? t(($) => $.meeting_directory.unknown_reason)))].map((text) => <p key={text}>{text}</p>)}
    {codes.some((code) => ["prepare_not_configured", "prepare_configuration_invalid", "root_target_changed"].includes(code)) && <details><summary className="cursor-pointer text-primary">{t(($) => $.meeting_directory.configuration)}</summary><p className="mt-2">{t(($) => $.meeting_directory.configuration_hint)}</p></details>}
    <details><summary className="cursor-pointer">{t(($) => $.artifact_runtime.diagnostics)}</summary><ul className="max-h-40 overflow-y-auto break-words">{codes.map((code) => <li key={code}>{code}</li>)}</ul></details>
  </div>;
}

export function CockpitDirectoryTargetView({ value, openable = true }: { value: CockpitDirectoryTarget; openable?: boolean }) {
  const { t } = useT("cockpit");
  return <div className="min-w-0 space-y-2 text-caption"><div className="flex min-w-0 items-start gap-2">{openable ? <LocalPathLink path={value.directory} wrap="truncate" className="min-w-0 flex-1" /> : <p dir="ltr" className="min-w-0 flex-1 line-clamp-2 break-all font-mono">{value.directory}</p>}<CollabPathCopyButton path={value.directory} /></div>
    <details className="space-y-2"><summary className="cursor-pointer text-muted-foreground">{t(($) => $.meeting_directory.details)}</summary><dl className="space-y-2 rounded-md bg-muted/50 p-3 [overflow-wrap:anywhere]">
      <div><dt className="text-muted-foreground">{t(($) => $.meeting_directory.root)}</dt><dd dir="ltr">{value.root_path}</dd></div>
      <div><dt className="text-muted-foreground">{t(($) => $.meeting_directory.boundary)}</dt><dd dir="ltr">{value.prepare_subpath}</dd></div>
      <div><dt className="text-muted-foreground">{t(($) => $.meeting_directory.target)}</dt><dd dir="ltr">{value.directory}</dd></div>
    </dl></details>
  </div>;
}

export function CockpitDirectoryPrincipalView({ value }: { value: CockpitDirectoryPrincipal }) {
  const { t } = useT("cockpit");
  const actor = value.actor_name || t(($) => $.meeting_directory.no_name), authorizer = value.authorizing_user_name || t(($) => $.meeting_directory.no_name);
  return <p className="break-words text-caption text-muted-foreground">{value.source === "human" && value.actor_type === "member" && value.confirmed_by_user_id === value.actor_id
    ? t(($) => $.meeting_directory.human_authorization, { name: actor })
    : value.source === "task_token" && value.actor_type === "agent" ? t(($) => $.meeting_directory.delegated_authorization, { actor, name: authorizer }) : t(($) => $.meeting_directory.unknown)}</p>;
}

export function CockpitDirectoryProgressCounts({ value }: { value: CockpitDirectoryCounts }) {
  const { t } = useT("cockpit"); const label = useDirectoryLabel();
  return <div className="space-y-2 text-caption"><p className="font-medium">{t(($) => $.meeting_directory.summary, { total: value.total, satisfied: value.satisfied })}</p>
    <dl className="flex flex-wrap gap-x-4 gap-y-1">{(["pending", "running", "retry_wait", "needs_attention", "abandoned"] as const).filter((state) => value[state] > 0).map((state) => <div key={state} className="flex gap-1"><dt className="text-muted-foreground">{label(state)}</dt><dd className="tabular-nums">{value[state]}</dd></div>)}</dl>
  </div>;
}

export function CockpitDirectoryPreviewView({ value }: { value: CockpitDirectoryPreview }) {
  const { t } = useT("cockpit"); const locale = useLocale(); const label = useDirectoryLabel(); const [page, setPage] = useState(1);
  const currentPage = Math.min(page, Math.max(1, Math.ceil(value.steps.length / 25))), shown = value.steps.slice((currentPage - 1) * 25, currentPage * 25);
  return <section className="space-y-3" aria-label={t(($) => $.meeting_directory.preview)}>
    <CockpitDirectoryTargetView value={value.target} openable={false} />
    {value.bind_after_base && value.observed_binding.nas_dir !== value.target.directory && <div className="space-y-1 text-caption"><p className="text-muted-foreground">{t(($) => $.meeting_directory.current_binding)}</p><p dir="ltr" className="max-h-20 overflow-y-auto break-all">{value.observed_binding.nas_dir || t(($) => $.common.unset)}</p></div>}
    <p className="text-caption">{t(($) => $.meeting_directory.counts, { ...value.counts })}</p><p className="text-caption text-muted-foreground">{value.bind_after_base ? t(($) => $.meeting_directory.bind_after) : t(($) => $.meeting_directory.binding_kept)}</p>
    {Number.isFinite(Date.parse(value.checked_at)) && <p className="text-caption text-muted-foreground">{t(($) => $.meeting_directory.checked_at, { time: new Date(value.checked_at).toLocaleString(locale) })}</p>}
    {value.principal && <CockpitDirectoryPrincipalView value={value.principal} />}<CockpitDirectoryReasons codes={value.blocked_reasons} />
    {value.steps.length > 25 && <CockpitFlowPaging page={currentPage} shown={shown.length} total={value.steps.length} hasNext={currentPage * 25 < value.steps.length} busy={false} onPrevious={() => setPage(currentPage - 1)} onNext={() => setPage(currentPage + 1)} />}
    <ol className={cn("max-h-[42vh] divide-y divide-border overflow-y-auto rounded-lg border border-border px-3", value.steps.length > 25 && "h-[42vh]")}>
      {shown.map((step) => <li key={step.position} className="space-y-2 py-3 text-caption"><div className="flex flex-wrap items-start gap-2"><p className="min-w-0 flex-1 line-clamp-2 break-words font-medium" title={step.label}>{step.label}</p><span className="text-muted-foreground">{label(step.planned_state)}</span></div>
        <p className="text-muted-foreground">{label(step.kind)}</p><details><summary className="cursor-pointer">{t(($) => $.meeting_directory.details)}</summary><p dir="ltr" className="mt-2 break-all">{step.relative_path}</p></details>
        {step.error_code && <CockpitDirectoryReasons codes={[step.error_code]} />}
      </li>)}
    </ol>
  </section>;
}
