"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cockpitObjectPath, cockpitArtifactPath, EMPTY_COCKPIT_SCOPE, cockpitLifecycleCommandOptions, cockpitLifecycleCommandsOptions, cockpitMeetingAgendaDraftKey, useCockpitMeetingAgendaDraftStore, setCockpitMeetingFormDraft, clearCockpitMeetingFormDraft, type CockpitMeetingFormDraft } from "@multica/core/cockpit";
import type { CockpitMeetingLifecycleHeader, CockpitOccurrenceTransition, CockpitOccurrenceView, CockpitLifecycleCommandDetail } from "@multica/core/types";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button, buttonVariants } from "@multica/ui/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@multica/ui/components/ui/dialog";
import { Input } from "@multica/ui/components/ui/input";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useLocale, useT } from "../../i18n";
import { AppLink } from "../../navigation";
import { useMeetingOccurrenceLabel } from "./use-meeting-occurrence-label";
import { CockpitFlowError, CockpitFlowPaging } from "./cockpit-task-flow";
import { CockpitMeetingCommandRecovery } from "./cockpit-meeting-command-recovery";
import { useCockpitMeetingCommand } from "./use-cockpit-meeting-command";

const knownStates = new Set(["unconfirmed", "scheduled", "in_progress", "ended"]);
const localInput = (value: string | null | undefined) => {
  if (!value) return ""; const date = new Date(value); if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const displayTime = (value: string, locale: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(locale) : value;

export function CockpitOccurrenceTimes({ value }: { value: CockpitOccurrenceView }) {
  const locale = useLocale();
  const { t } = useT("cockpit");
  return <dl className="grid gap-2 text-caption sm:grid-cols-2">
    <div><dt className="text-muted-foreground">{t(($) => $.meeting_lifecycle.actual_started)}</dt><dd>{value.actual_started_at ? displayTime(value.actual_started_at, locale) : t(($) => $.common.unset)}</dd></div>
    <div><dt className="text-muted-foreground">{t(($) => $.meeting_lifecycle.actual_ended)}</dt><dd>{value.actual_ended_at ? displayTime(value.actual_ended_at, locale) : t(($) => $.common.unset)}</dd></div>
  </dl>;
}

export function CockpitMeetingOccurrence({ wsId, header, refresh, readOnly }: { wsId: string; header: CockpitMeetingLifecycleHeader; refresh: () => void; readOnly?: boolean }) {
  const locale = useLocale();
  const { t } = useT("cockpit"); const [open, setOpen] = useState(false); const [history, setHistory] = useState(false);
  const [transition, setTransition] = useState<CockpitOccurrenceTransition>("schedule"); const dialogBusy = useRef(false);
  const value = header.occurrence;
  const occurrenceLabel = useMeetingOccurrenceLabel(); const stateLabel = occurrenceLabel(value.state);
  const command = useCockpitMeetingCommand(wsId, header.meeting_id, cockpitMeetingAgendaDraftKey(wsId, header.meeting_id, "occurrence"));
  const allowed = knownStates.has(value.state) && !readOnly;
  const drafts = useCockpitMeetingAgendaDraftStore((state) => state.draft.forms);
  const hasDraft = (action: CockpitOccurrenceTransition) => Boolean(drafts[cockpitMeetingAgendaDraftKey(wsId, header.meeting_id, `occurrence-form:${action}`)]);
  return <Dialog open={open} onOpenChange={(next) => { if (next || !dialogBusy.current) setOpen(next); }}><section aria-label={t(($) => $.meeting_lifecycle.occurrence)} className="space-y-3 rounded-lg border border-border p-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-body font-medium">{stateLabel}</h3>
        <div className="flex flex-wrap gap-2">{command.pending?.kind === "occurrence" ? <DialogTrigger render={<Button size="sm" variant="outline" />} onClick={() => setTransition(command.pending?.kind === "occurrence" ? command.pending.body.transition : "schedule")}>{t(($) => $.meeting_lifecycle.retry_command)}</DialogTrigger>
          : ([{ action: "schedule", permitted: header.can_schedule }, { action: "start", permitted: header.can_start }, { action: "end", permitted: header.can_end }] as const)
            .filter((entry) => allowed && entry.permitted || hasDraft(entry.action)).map((entry) => <DialogTrigger key={entry.action} render={<Button size="sm" variant={entry.action === "end" ? "default" : "outline"} />} onClick={() => setTransition(entry.action)}>{allowed && entry.permitted ? t(($) => $.meeting_lifecycle[entry.action]) : t(($) => $.meeting_lifecycle.resume_draft, { action: t(($) => $.meeting_lifecycle[entry.action]) })}</DialogTrigger>)}
        </div>
        {open && <CockpitOccurrenceForm key={`${header.meeting_id}:${transition}`} wsId={wsId} header={header} transition={transition} onDone={() => setOpen(false)} refresh={refresh} readOnly={readOnly} onBusyChange={(value) => { dialogBusy.current = value; }} />}
    </div>
    {value.ended_at ? <p className="text-caption text-muted-foreground">{t(($) => $.meeting_lifecycle.confirmed_ended, { time: displayTime(value.ended_at, locale) })}</p>
      : value.started_confirmed_at && <p className="text-caption text-muted-foreground">{t(($) => $.meeting_lifecycle.confirmed_started, { time: displayTime(value.started_confirmed_at, locale) })}</p>}
    {header.blocked_reasons.some((entry) => entry.action === "occurrence" && entry.code === "workflow_manager_required") && <p className="text-caption text-muted-foreground">{t(($) => $.meeting_lifecycle.manager_required)}</p>}
    {header.blocked_reasons.some((entry) => entry.code === "human_required") && <p className="text-caption text-muted-foreground">{t(($) => $.meeting_lifecycle.human_required)}</p>}
    <details className="space-y-3"><summary className="cursor-pointer text-caption text-muted-foreground">{t(($) => $.meeting_lifecycle.time_details)}</summary>
      <CockpitOccurrenceTimes value={value} />
      {value.ended_source === "legacy_confirmation" && <p className="text-caption text-muted-foreground">{t(($) => $.meeting_lifecycle.legacy_confirmation)}</p>}
      <div className="flex flex-wrap gap-2">{(allowed && header.can_correct_times || hasDraft("correct_times")) && <DialogTrigger render={<Button type="button" size="sm" variant="outline" />} onClick={() => setTransition("correct_times")}>{t(($) => $.meeting_lifecycle.correct_times)}</DialogTrigger>}
        <Button type="button" size="sm" variant="ghost" aria-expanded={history} onClick={() => setHistory(!history)}>{t(($) => $.meeting_lifecycle.history)}</Button></div>
      {history && <CockpitMeetingCommandHistory wsId={wsId} meetingId={header.meeting_id} />}
    </details>
  </section></Dialog>;
}

function CockpitOccurrenceForm({ wsId, header, transition, onDone, refresh, readOnly, onBusyChange }: { wsId: string; header: CockpitMeetingLifecycleHeader; transition: CockpitOccurrenceTransition; onDone: () => void; refresh: () => void; readOnly?: boolean; onBusyChange: (busy: boolean) => void }) {
  const { t } = useT("cockpit"); const command = useCockpitMeetingCommand(wsId, header.meeting_id, cockpitMeetingAgendaDraftKey(wsId, header.meeting_id, "occurrence"));
  useEffect(() => { onBusyChange(command.busy); return () => onBusyChange(false); }, [command.busy, onBusyChange]);
  const original = command.pending?.kind === "occurrence" ? command.pending.body : undefined;
  const formKey = cockpitMeetingAgendaDraftKey(wsId, header.meeting_id, `occurrence-form:${transition}`);
  const [initial] = useState<Extract<CockpitMeetingFormDraft, { kind: "occurrence" }>>(() => ({ kind: "occurrence", transition,
    observedRevision: original?.expected_revision ?? header.lifecycle_revision, start: localInput(original ? original.actual_started_at : header.occurrence.actual_started_at),
    end: localInput(original ? original.actual_ended_at : header.occurrence.actual_ended_at), reason: original?.reason ?? "" }));
  const stored = useCockpitMeetingAgendaDraftStore((state) => state.draft.forms[formKey]);
  const value = stored?.kind === "occurrence" ? stored : initial;
  const { start, end, reason, observedRevision: observed } = value;
  const change = (patch: Partial<typeof value>) => setCockpitMeetingFormDraft(formKey, { ...value, ...patch });
  const changed = observed !== header.lifecycle_revision;
  const currentTransition = original?.transition ?? transition;
  const startTime = start ? new Date(start).getTime() : null; const endTime = end ? new Date(end).getTime() : null;
  const invalidTime = startTime !== null && (!Number.isFinite(startTime) || startTime > Date.now()) || endTime !== null && (!Number.isFinite(endTime) || endTime > Date.now()) || startTime !== null && endTime !== null && startTime > endTime;
  const permitted = knownStates.has(header.occurrence.state) && (currentTransition === "schedule" ? header.can_schedule : currentTransition === "start" ? header.can_start : currentTransition === "end" ? header.can_end : header.can_correct_times);
  const save = async () => {
    if (command.busy || !original && (changed || invalidTime || readOnly || !permitted || !knownStates.has(header.occurrence.state) || currentTransition === "correct_times" && !reason.trim())) return;
    const body = original ?? { expected_revision: observed, command_key: crypto.randomUUID(), transition: currentTransition,
      ...(currentTransition !== "schedule" ? { actual_started_at: start === localInput(header.occurrence.actual_started_at) ? header.occurrence.actual_started_at : start ? new Date(start).toISOString() : null } : {}),
      ...(currentTransition === "end" || currentTransition === "correct_times" && header.occurrence.state === "ended" ? { actual_ended_at: end === localInput(header.occurrence.actual_ended_at) ? header.occurrence.actual_ended_at : end ? new Date(end).toISOString() : null } : {}),
      ...(currentTransition === "correct_times" ? { reason: reason.trim() } : {}) };
    setCockpitMeetingFormDraft(formKey, value);
    const response = await command.run({ kind: "occurrence", body }); if (response) { clearCockpitMeetingFormDraft(formKey, value); if (response.stillCurrent()) onDone(); }
  };
  return <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg"><DialogHeader><DialogTitle>{t(($) => $.meeting_lifecycle[currentTransition])}</DialogTitle><DialogDescription>{t(($) => $.meeting_lifecycle.occurrence_hint)}</DialogDescription></DialogHeader>
    <CockpitMeetingCommandRecovery command={command} onConfirmed={() => clearCockpitMeetingFormDraft(formKey, value)} onCurrentConfirmed={onDone} />
    {currentTransition !== "schedule" && <div className="space-y-3"><p className="text-caption text-muted-foreground">{t(($) => $.meeting_lifecycle.time_hint)}</p>
      <label className="block space-y-1 text-caption">{t(($) => $.meeting_lifecycle.actual_started)}<Input type="datetime-local" value={start} disabled={Boolean(original) || command.busy} onChange={(event) => change({ start: event.target.value })} /></label>
      {(currentTransition === "end" || currentTransition === "correct_times" && header.occurrence.state === "ended") && <label className="block space-y-1 text-caption">{t(($) => $.meeting_lifecycle.actual_ended)}<Input type="datetime-local" value={end} disabled={Boolean(original) || command.busy} onChange={(event) => change({ end: event.target.value })} /></label>}
      {invalidTime && !original && <p role="alert" className="text-caption text-destructive">{t(($) => $.meeting_lifecycle.time_invalid)}</p>}
    </div>}
    {currentTransition === "correct_times" && <label className="space-y-1 text-caption">{t(($) => $.meeting_lifecycle.reason)}<Textarea className="max-h-56 resize-y overflow-y-auto" value={reason} disabled={Boolean(original) || command.busy} onChange={(event) => change({ reason: event.target.value })} /></label>}
    {changed && !original && <div role="alert" className="space-y-2 text-caption"><p>{t(($) => $.meeting_lifecycle.changed)}</p><CockpitOccurrenceTimes value={header.occurrence} /><Button variant="outline" size="sm" onClick={refresh}>{t(($) => $.meeting_lifecycle.refresh)}</Button><Button variant="outline" size="sm" disabled={!permitted || readOnly} onClick={() => change({ observedRevision: header.lifecycle_revision })}>{t(($) => $.meeting_lifecycle.rebase)}</Button></div>}
    {command.error && <p role="alert" className="break-words text-caption text-destructive">{command.error}</p>}
    <DialogFooter><DialogClose render={<Button variant="outline" disabled={command.busy} />}>{t(($) => $.task_create.cancel)}</DialogClose><Button onClick={() => void save()} disabled={command.busy || !original && (changed || invalidTime || readOnly || !permitted || currentTransition === "correct_times" && !reason.trim())} aria-busy={command.busy}>{command.busy && <Spinner />}{original ? t(($) => $.meeting_lifecycle.retry_command) : t(($) => $.meeting_lifecycle.confirm)}</Button></DialogFooter>
  </DialogContent>;
}

export function CockpitMeetingMaterialsConfirmation({ wsId, header, resourcesHref, workflowHref, readOnly }: { wsId: string; header: CockpitMeetingLifecycleHeader; resourcesHref: string; workflowHref: string; readOnly?: boolean }) {
  const { t } = useT("cockpit"); const command = useCockpitMeetingCommand(wsId, header.meeting_id, cockpitMeetingAgendaDraftKey(wsId, header.meeting_id, "materials"));
  const ready = header.materials?.ready === true;
  const save = () => { if (command.busy || !command.pending && (readOnly || !header.can_confirm_materials || !header.materials)) return;
    void command.run(command.pending ?? { kind: "materials", body: { command_key: crypto.randomUUID(), expected_revision: header.materials?.workflow_revision ?? 0, materials_ready: !ready } }); };
  return <section className="space-y-3 rounded-lg border border-border p-3" aria-label={t(($) => $.meeting_lifecycle.materials)}>
    <h3 className="text-body font-medium">{t(($) => $.meeting_lifecycle.materials)}</h3><p className="text-caption text-muted-foreground">{t(($) => $.meeting_lifecycle.materials_hint)}</p>
    <div className="flex flex-wrap gap-2"><AppLink className={buttonVariants({ variant: "outline", size: "sm" })} href={resourcesHref}>{t(($) => $.meeting_lifecycle.open_materials)}</AppLink><AppLink className={buttonVariants({ variant: "ghost", size: "sm" })} href={workflowHref}>{t(($) => $.meeting_lifecycle.open_workflow)}</AppLink></div>
    {!header.materials ? <p className="text-caption text-muted-foreground">{t(($) => $.meeting_lifecycle.workflow_needed)}</p> : <>
      <label className="flex items-start gap-2 text-caption"><input type="checkbox" checked={ready} disabled={command.busy || Boolean(command.pending) || readOnly || !header.can_confirm_materials} onChange={save} className="mt-0.5 size-4 accent-primary" />{t(($) => $.meeting_lifecycle.materials_ready)}</label>
      {header.materials.released && <p className="text-caption text-muted-foreground">{t(($) => $.meeting_lifecycle.released)}</p>}
      {!header.can_confirm_materials && !header.materials.released && <p className="text-caption text-muted-foreground">{t(($) => $.meeting_lifecycle.manager_required)}</p>}
    </>}
    {command.pending && <div className="space-y-2"><CockpitMeetingCommandRecovery command={command} /><Button onClick={save} size="sm" variant="outline" disabled={command.busy}>{t(($) => $.meeting_lifecycle.retry_command)}</Button></div>}
    {command.error && <p role="alert" className="break-words text-caption text-destructive">{command.error}</p>}
  </section>;
}

function useMeetingCommandLabel() {
  const { t } = useT("cockpit");
  const labels: Record<string, string> = {
    schedule: t(($) => $.meeting_lifecycle.schedule), start: t(($) => $.meeting_lifecycle.start), end: t(($) => $.meeting_lifecycle.end), correct_times: t(($) => $.meeting_lifecycle.correct_times),
    materials: t(($) => $.meeting_lifecycle.materials), agenda_create: t(($) => $.meeting_lifecycle.add), agenda_update: t(($) => $.meeting_lifecycle.save), agenda_remove: t(($) => $.meeting_lifecycle.remove),
    reference_attach: t(($) => $.meeting_lifecycle.attach), reference_remove: t(($) => $.meeting_lifecycle.unlink), preparation_issue_create: t(($) => $.meeting_lifecycle.create_preparation),
  };
  return (action: string) => labels[action] ?? t(($) => $.meeting_lifecycle.unknown_action, { action });
}

function CockpitMeetingCommandHistory({ wsId, meetingId }: { wsId: string; meetingId: string }) {
  const locale = useLocale();
  const label = useMeetingCommandLabel();
  const { t } = useT("cockpit"); const client = useQueryClient(); const [cursors, setCursors] = useState([""]); const [selected, setSelected] = useState("");
  const options = cockpitLifecycleCommandsOptions(wsId, meetingId, { cursor: cursors.at(-1) || undefined, page_size: 25 }); const query = useQuery(options); const page = query.data;
  const detail = useQuery({ ...cockpitLifecycleCommandOptions(wsId, meetingId, selected), enabled: Boolean(selected) });
  const refresh = async () => { await client.invalidateQueries({ queryKey: cockpitLifecycleCommandsOptions(wsId, meetingId, { page_size: 25 }).queryKey }); setCursors([""]); };
  return <div className="space-y-3">{query.isPending ? <Spinner /> : query.isError || !page ? <CockpitFlowError onRetry={() => void query.refetch()} /> : <>
    <ul className="max-h-72 divide-y divide-border overflow-y-auto">{page.items.map((item) => <li key={item.command_key} className="space-y-1 py-2 text-caption"><Button variant="ghost" size="sm" className="h-auto max-w-full whitespace-normal text-left" onClick={() => setSelected(item.command_key)}>{label(item.action)}</Button><p className="break-words text-muted-foreground">{item.actor_name || item.actor_id} · {displayTime(item.created_at, locale)}</p></li>)}</ul>
    {page.items.length === 0 && <p className="text-caption text-muted-foreground">{t(($) => $.meeting_lifecycle.history_empty)}</p>}
    <CockpitFlowPaging page={cursors.length} shown={page.items.length} total={page.total} hasNext={Boolean(page.next_cursor)} busy={query.isFetching} onPrevious={() => setCursors(cursors.slice(0, -1))} onNext={() => { if (page.next_cursor) setCursors([...cursors, page.next_cursor]); }} />
  </>}{cursors.length > 1 && <Button size="sm" variant="outline" onClick={() => void refresh()}>{t(($) => $.task_flow.first_page)}</Button>}
    <Dialog open={Boolean(selected)} onOpenChange={(open) => { if (!open) setSelected(""); }}><DialogContent className="max-h-[85dvh] overflow-y-auto"><DialogHeader><DialogTitle>{t(($) => $.meeting_lifecycle.history_detail)}</DialogTitle></DialogHeader>
      {detail.isPending ? <Spinner /> : detail.isError || !detail.data ? <CockpitFlowError onRetry={() => void detail.refetch()} /> : <div className="space-y-4"><h4 className="text-body font-medium">{label(detail.data.action)}</h4><p className="text-caption text-muted-foreground">{detail.data.actor_name || detail.data.actor_id} · {displayTime(detail.data.created_at, locale)}</p>
        <MeetingCommandResult detail={detail.data} />
        {detail.data.receipt.previous_occurrence && <section className="space-y-2"><h4 className="text-caption font-medium">{t(($) => $.meeting_lifecycle.before)}</h4><CockpitOccurrenceTimes value={detail.data.receipt.previous_occurrence} /></section>}
        {detail.data.receipt.occurrence && <section className="space-y-2"><h4 className="text-caption font-medium">{t(($) => $.meeting_lifecycle.after)}</h4><CockpitOccurrenceTimes value={detail.data.receipt.occurrence} /></section>}
        {detail.data.receipt.reason && <div><h4 className="text-caption font-medium">{t(($) => $.meeting_lifecycle.reason)}</h4><p className="whitespace-pre-wrap break-words text-body">{detail.data.receipt.reason}</p></div>}
      </div>}
    </DialogContent></Dialog>
  </div>;
}

function MeetingCommandResult({ detail }: { detail: CockpitLifecycleCommandDetail }) {
  const locale = useLocale();
  const { t } = useT("cockpit"); const paths = useWorkspacePaths(); const occurrenceLabel = useMeetingOccurrenceLabel();
  const receipt = detail.receipt, reference = receipt.reference;
  const agendaHref = receipt.agenda_id ? cockpitObjectPath(paths.cockpit(), { kind: "meeting", id: detail.meeting_id, view: "agenda", agendaId: receipt.agenda_id }) : null;
  const issue = reference?.issue;
  const targetHref = reference?.kind === "artifact_reference" && reference.artifact_id && reference.version_id ? cockpitArtifactPath(paths.cockpit(), reference.artifact_id, EMPTY_COCKPIT_SCOPE, reference.version_id)
    : issue ? paths.issueDetail(issue.identifier || issue.id) : receipt.issue_id ? paths.issueDetail(receipt.issue_id) : reference?.kind === "issue" ? paths.issueDetail(reference.target_id) : null;
  const targetLabel = issue ? `${issue.identifier} ${issue.title}` : reference?.label || receipt.issue_id || reference?.target_id;
  return <div className="space-y-3 text-caption">
    {receipt.occurrence && <div className="space-y-1"><p>{occurrenceLabel(receipt.occurrence.state)}</p>{receipt.occurrence.ended_at ? <p className="text-muted-foreground">{t(($) => $.meeting_lifecycle.confirmed_ended, { time: displayTime(receipt.occurrence.ended_at, locale) })}</p> : receipt.occurrence.started_confirmed_at && <p className="text-muted-foreground">{t(($) => $.meeting_lifecycle.confirmed_started, { time: displayTime(receipt.occurrence.started_confirmed_at, locale) })}</p>}</div>}
    {receipt.materials && <p>{receipt.materials.ready ? t(($) => $.meeting_lifecycle.materials_confirmed) : t(($) => $.meeting_lifecycle.materials_cleared)}</p>}
    {receipt.agenda && <div className="space-y-1"><p className="break-words font-medium">{receipt.agenda.title}</p>{receipt.agenda.removed_at && <p className="text-muted-foreground">{t(($) => $.meeting_lifecycle.removed)}</p>}</div>}
    {targetLabel && <div className="space-y-1">{targetHref ? <AppLink href={targetHref} target="_blank" rel="noopener noreferrer" className="break-words text-primary underline">{targetLabel} {t(($) => $.action_flow.new_tab)}</AppLink> : <p className="break-words">{targetLabel}</p>}
      {reference?.kind === "artifact_reference" && reference.version_number !== null && <p className="text-muted-foreground">{t(($) => $.workflow.version, { number: reference.version_number })}</p>}
      {reference?.removed_at && <p className="text-muted-foreground">{t(($) => $.artifact_runtime.reference_removed)}</p>}
    </div>}
    {agendaHref && <AppLink href={agendaHref} target="_blank" rel="noopener noreferrer" className="inline-block text-primary underline">{t(($) => $.meeting_lifecycle.open_current_agenda)} {t(($) => $.action_flow.new_tab)}</AppLink>}
  </div>;
}
