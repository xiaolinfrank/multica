"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  cockpitDirectoryOperationOptions, cockpitDirectoryStepsOptions, cockpitMeetingDirectoryDraftKey, cockpitDirectoryRepairSelection,
  useCockpitMeetingDirectoryDraftStore, setCockpitDirectoryForm, type CockpitDirectoryFormDraft,
} from "@multica/core/cockpit";
import type { CockpitDirectorySummary } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useLocale, useT } from "../../i18n";
import { CockpitFlowError, CockpitFlowPaging } from "./cockpit-task-flow";
import { CockpitDirectoryReasons, CockpitDirectoryTargetView, CockpitDirectoryPrincipalView, CockpitDirectoryProgressCounts, knownDirectoryStates, knownDirectoryStepStates, retryableDirectoryStep, useDirectoryLabel } from "./cockpit-directory-parts";
import { CockpitDirectoryControl } from "./cockpit-directory-control";
import { CockpitDirectoryAttempts } from "./cockpit-directory-attempts";
import { CockpitDirectoryRetry } from "./cockpit-directory-retry";
import { CockpitDirectoryPrepare } from "./cockpit-directory-prepare";

export function CockpitDirectoryOperation({ wsId, summary, operationId, active, readOnly, onCreated, onManageMeeting, refreshSummary }: {
  wsId: string; summary: CockpitDirectorySummary; operationId: string; active: boolean; readOnly?: boolean;
  onCreated: (id: string) => void; onManageMeeting: () => void; refreshSummary: () => void;
}) {
  const { t } = useT("cockpit"); const locale = useLocale(); const label = useDirectoryLabel(); const [page, setPage] = useState(1);
  const meetingId = summary.meeting_id;
  const header = useQuery({ ...cockpitDirectoryOperationOptions(wsId, meetingId, operationId),
    refetchInterval: (query) => active && query.state.status !== "error" && query.state.data?.state === "active" ? 5000 : false });
  const steps = useQuery({ ...cockpitDirectoryStepsOptions(wsId, meetingId, operationId),
    refetchInterval: (query) => active && query.state.status !== "error" && header.data?.state === "active" ? 5000 : false });
  const key = cockpitMeetingDirectoryDraftKey(wsId, meetingId, "retry", operationId);
  const stored = useCockpitMeetingDirectoryDraftStore((state) => state.draft.forms[key]);
  const pending = useCockpitMeetingDirectoryDraftStore((state) => state.draft.commands[key]);
  const current = header.data, data = steps.data;
  const value: Extract<CockpitDirectoryFormDraft, { kind: "retry" }> = stored?.kind === "retry" ? stored : { kind: "retry", observedRevision: current?.revision ?? 0,
    stepIds: pending?.kind === "retry" ? pending.body.step_ids : [], reason: pending?.kind === "retry" ? pending.body.reason : "" };
  const refresh = () => { void header.refetch(); void steps.refetch(); refreshSummary(); };
  const disabled = readOnly || header.isError || steps.isError;
  const select = (stepIds: string[]) => setCockpitDirectoryForm(key, { ...value, stepIds: [...new Set(stepIds)], observedRevision: current?.revision ?? value.observedRevision });
  const currentPage = Math.min(page, Math.max(1, Math.ceil((data?.items.length ?? 0) / 25))), shown = data?.items.slice((currentPage - 1) * 25, currentPage * 25) ?? [];
  const sameBinding = current?.target.root_id === summary.binding_candidate?.root_id && current?.target.relative_directory === summary.binding_candidate?.relative_directory && current?.target.directory === summary.binding_candidate?.directory;
  const repairSelection = current && data ? cockpitDirectoryRepairSelection(current, data) : null;
  return <section className="space-y-3" aria-label={t(($) => $.meeting_directory.open_operation)}>
    {(header.isError || steps.isError) && <CockpitFlowError onRetry={refresh} />}
    {!current ? header.isPending ? <Spinner /> : null : <>
      <div className="space-y-3 rounded-lg border border-border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-title-sm font-medium">{label(current.state)}</h3><Button size="sm" variant="ghost" onClick={refresh}>{t(($) => $.meeting_lifecycle.refresh)}</Button></div>
        <CockpitDirectoryTargetView value={current.target} openable={Boolean(data?.items.some((step) => step.kind === "base" && step.state === "satisfied"))} />
        <CockpitDirectoryProgressCounts value={current.counts} />
        <p className="break-words text-caption text-muted-foreground">{t(($) => $.meeting_preparation.responsible, { name: current.responsible_user_name || t(($) => $.meeting_directory.no_name) })}</p>
        <CockpitDirectoryPrincipalView value={current.source_principal} />
        {Number.isFinite(Date.parse(current.updated_at)) && <p className="text-caption text-muted-foreground">{new Date(current.updated_at).toLocaleString(locale)}</p>}
        {current.state === "active" && <p className="text-caption text-muted-foreground">{t(($) => $.meeting_directory.background)}</p>}
        {current.state === "completed" && <p className="text-caption text-muted-foreground">{t(($) => $.meeting_directory.last_verified)}</p>}
        {summary.binding.nas_dir !== current.target.directory && <p className="text-caption text-muted-foreground">{t(($) => $.meeting_directory.other_binding)}</p>}
        <CockpitDirectoryReasons codes={current.blocked_reasons} />
        {current.blocked_reasons.some((code) => code === "meeting_cancelled" || code === "meeting_archived") && <Button variant="outline" size="sm" onClick={onManageMeeting}>{t(($) => $.meeting_disposition.actions)}</Button>}
        <div className="flex flex-wrap gap-2">{(["pause", "resume", "claim", "abandon"] as const).map((transition) => <CockpitDirectoryControl key={transition} wsId={wsId} header={current} transition={transition} readOnly={disabled} refresh={refresh} />)}
          {current.state === "completed" && <CockpitDirectoryPrepare wsId={wsId} summary={summary} mode="repair" repair={{ operationId, selection: repairSelection }} readOnly={disabled || !sameBinding} refresh={refresh} onCreated={onCreated} onManageMeeting={onManageMeeting} />}
        </div>
      </div>
      {!data ? steps.isPending ? <Spinner /> : null : <>
        {knownDirectoryStates.has(current.state) && <div className="space-y-2"><div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={disabled || Boolean(pending) || !current.can_retry || !data.items.some((step) => retryableDirectoryStep(step))} onClick={() => select(data.items.filter((step) => retryableDirectoryStep(step)).map((step) => step.id))}>{t(($) => $.meeting_directory.select_retryable)}</Button>
          {value.stepIds.length > 0 && <Button size="sm" variant="ghost" disabled={Boolean(pending)} onClick={() => select([])}>{t(($) => $.meeting_directory.clear_selection)}</Button>}
          <CockpitDirectoryRetry wsId={wsId} header={current} steps={data.items} readOnly={disabled} onDone={refresh} />
        </div><p className="text-caption text-muted-foreground">{t(($) => $.meeting_directory.selected_steps, { count: value.stepIds.length })}</p></div>}
        {data.items.length > 25 && <CockpitFlowPaging page={currentPage} shown={shown.length} total={data.total} hasNext={currentPage * 25 < data.items.length} busy={steps.isFetching} onPrevious={() => setPage(currentPage - 1)} onNext={() => setPage(currentPage + 1)} />}
        <ol className="max-h-[48vh] divide-y divide-border overflow-y-auto rounded-lg border border-border px-3">{shown.map((step) => {
          const selected = value.stepIds.includes(step.id), retryable = current.can_retry && knownDirectoryStates.has(current.state) && !["completed", "abandoned"].includes(current.state) && retryableDirectoryStep(step) && knownDirectoryStepStates.has(step.state);
          return <li key={step.id} className="space-y-2 py-3 text-caption"><div className="flex items-start gap-2">{retryable || selected ? <label className="flex min-w-0 flex-1 items-start gap-2"><input type="checkbox" checked={selected} disabled={Boolean(pending) || disabled || !retryable && !selected} onChange={(event) => select(event.target.checked ? [...value.stepIds, step.id] : value.stepIds.filter((id) => id !== step.id))} /><span className="line-clamp-2 min-w-0 break-words font-medium" title={step.label}>{step.label}</span></label> : <p className="min-w-0 flex-1 line-clamp-2 break-words font-medium" title={step.label}>{step.label}</p>}<span className="text-muted-foreground">{label(step.state)}</span></div>
            <p className="text-muted-foreground">{label(step.kind)}{step.outcome && <> · {label(step.outcome)}</>}</p>
            {step.last_observed_at && Number.isFinite(Date.parse(step.last_observed_at)) && <p className="text-muted-foreground">{t(($) => $.meeting_directory.checked_at, { time: new Date(step.last_observed_at).toLocaleString(locale) })}</p>}
            <CockpitDirectoryReasons codes={[...new Set([...step.blocked_reasons, ...(step.last_error_code ? [step.last_error_code] : [])])]} />
            <div className="flex flex-wrap gap-2"><CockpitDirectoryAttempts wsId={wsId} meetingId={meetingId} step={step} /><details><summary className="cursor-pointer py-1 text-muted-foreground">{t(($) => $.meeting_directory.details)}</summary><p dir="ltr" className="max-h-40 overflow-y-auto break-all">{step.relative_path}</p></details></div>
          </li>;
        })}</ol>
      </>}
    </>}
  </section>;
}
