"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cockpitObjectPath, EMPTY_COCKPIT_SCOPE, cockpitMeetingOperationBasisOptions, cockpitMeetingPreparationPath, cockpitAgendaOptions, cockpitAgendaDetailOptions, cockpitMeetingLifecycleOptions, cockpitMeetingAgendaPath,
  cockpitRelationViewKey, EMPTY_COCKPIT_AGENDA_CONTEXT, useCockpitScopeViewStore,
  cockpitMeetingContextPath, cockpitScope, cockpitMeetingAgendaDraftKey, useCockpitMeetingAgendaDraftStore,
  updateCockpitAgendaDraft, rebaseCockpitAgendaDraft, clearCockpitAgendaDraft, cockpitSelectedMemberOptions,
  setCockpitMeetingFormDraft, clearCockpitMeetingFormDraft, type CockpitMeetingFormDraft, type CockpitAgendaDraft,
} from "@multica/core/cockpit";
import { useWorkspacePaths } from "@multica/core/paths";
import type { CockpitAgendaDetail, CockpitAgendaPurpose, CockpitMeetingLifecycleHeader } from "@multica/core/types";
import { Button, buttonVariants } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@multica/ui/components/ui/dialog";
import { AppLink, useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { CockpitFlowError, CockpitFlowPaging, useCockpitSearch } from "./cockpit-task-flow";
import { CockpitMeetingOccurrence, CockpitMeetingMaterialsConfirmation } from "./cockpit-meeting-lifecycle";
import { CockpitReviewerSelect } from "./cockpit-reviewer-select";
import { CockpitNodeIssuePicker, useCockpitSelectedNodeIssueOption } from "./cockpit-node-issue-picker";
import { CockpitMeetingCommandRecovery } from "./cockpit-meeting-command-recovery";
import { useCockpitMeetingCommand } from "./use-cockpit-meeting-command";
import { CockpitAgendaReferences } from "./cockpit-agenda-references";
import { CockpitMeetingTemplateApplication } from "./cockpit-meeting-template-application";
import { CockpitPreparationOperation } from "./cockpit-preparation-operation";
import { CockpitMeetingInputs } from "./cockpit-meeting-inputs";
import { CockpitPreparationHistory } from "./cockpit-preparation-history";
import { CockpitPreparationReasons } from "./cockpit-preparation-preview";
import { createSafeId } from "@multica/core/utils";

const purposes: CockpitAgendaPurpose[] = ["planning", "goal_review", "boundary_confirmation", "question_clarification", "solution_discussion", "direction_decision"];
const isPurpose = (value: string): value is CockpitAgendaPurpose => purposes.some((purpose) => purpose === value);
const size = (value: string) => new TextEncoder().encode(value).length;

export function CockpitMeetingAgenda({ wsId, meetingId, accountId, inputsAvailable = false, readOnly, templatesAvailable = false, dispositionAvailable = false, directoryPreparationAvailable = false, authorizedPreparationId, onPreparationAuthorizationConsumed }: { wsId: string; meetingId: string; accountId?: string; inputsAvailable?: boolean; readOnly?: boolean; templatesAvailable?: boolean; dispositionAvailable?: boolean; directoryPreparationAvailable?: boolean; authorizedPreparationId?: string | null; onPreparationAuthorizationConsumed?: () => void }) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths(); const navigation = useNavigation(); const client = useQueryClient();
  const viewKey = cockpitRelationViewKey(wsId, "agenda", meetingId);
  const view = useCockpitScopeViewStore((state) => state.agendas[viewKey] ?? EMPTY_COCKPIT_AGENDA_CONTEXT);
  const [create, setCreate] = useState(false); const dialogBusy = useRef(false); const [autoStart, setAutoStart] = useState<string | null>(null);
  const text = view.query, removed = view.includeRemoved;
  const q = useCockpitSearch(text); const changing = q !== text.trim();
  const signature = JSON.stringify([q, removed]); const cursors = view.cursorKey === signature ? view.cursors : [""];
  const setCursors = (cursors: string[]) => useCockpitScopeViewStore.getState().updateAgenda(viewKey, { cursorKey: signature, cursors });
  const generation = useRef(useCockpitScopeViewStore.getState().sessionGeneration);
  const restoreList = useCallback((element: HTMLUListElement | null) => { if (element) element.scrollTop = useCockpitScopeViewStore.getState().agendas[viewKey]?.scrollTop ?? 0; }, [viewKey]);
  const pendingCreate = useCockpitMeetingAgendaDraftStore((state) => state.draft.commands[cockpitMeetingAgendaDraftKey(wsId, meetingId, "new-agenda")]);
  const lifecycle = useQuery(cockpitMeetingLifecycleOptions(wsId, meetingId));
  const query = useQuery(cockpitAgendaOptions(wsId, meetingId, { q, include_removed: removed, cursor: cursors.at(-1) || undefined, page_size: 25 })); const page = query.data;
  const selectedId = navigation.searchParams.get("meeting") === meetingId ? navigation.searchParams.get("agenda") : null;
  const operationId = navigation.searchParams.get("meeting") === meetingId ? navigation.searchParams.get("preparation") : null;
  const preparationAvailable = templatesAvailable || dispositionAvailable;
  const basis = useQuery({ ...cockpitMeetingOperationBasisOptions(wsId, meetingId), enabled: preparationAvailable });
  const canAddPreparation = !preparationAvailable ? undefined : !basis.isError && basis.data?.availability === "available" && basis.data.can_add_preparation;
  useEffect(() => { if (operationId && autoStart && operationId !== autoStart) setAutoStart(null); }, [operationId, autoStart]);
  const href = (agendaId: string | null) => cockpitMeetingAgendaPath(paths.cockpit(), meetingId, agendaId, navigation.searchParams);
  const resourcesHref = cockpitMeetingContextPath(paths.cockpit(), meetingId, cockpitScope(navigation.searchParams), navigation.searchParams, "resources");
  const workflowHref = cockpitMeetingContextPath(paths.cockpit(), meetingId, cockpitScope(navigation.searchParams), navigation.searchParams, "minutes_review");
  const firstPage = async () => { await client.invalidateQueries({ queryKey: cockpitAgendaOptions(wsId, meetingId, { q, include_removed: removed, page_size: 25 }).queryKey }); setCursors([""]); };
  return <section aria-label={t(($) => $.meeting_lifecycle.title)} className="min-w-0 space-y-4">
    {lifecycle.isPending ? <Spinner /> : lifecycle.isError || !lifecycle.data ? <CockpitFlowError onRetry={() => void lifecycle.refetch()} /> : <>
      <CockpitMeetingOccurrence wsId={wsId} header={lifecycle.data} refresh={() => void lifecycle.refetch()} readOnly={readOnly} />
      {operationId && preparationAvailable ? <div className="space-y-3"><AppLink className={buttonVariants({ variant: "outline", size: "sm" })} href={cockpitMeetingPreparationPath(paths.cockpit(), meetingId, null, navigation.searchParams)} onClick={() => { setAutoStart(null); onPreparationAuthorizationConsumed?.(); }}>{t(($) => $.meeting_preparation.close)}</AppLink>
        <CockpitPreparationOperation key={`${wsId}:${meetingId}:${operationId}`} wsId={wsId} meetingId={meetingId} operationId={operationId} directoryPreparationAvailable={directoryPreparationAvailable} autoStart={autoStart === operationId || authorizedPreparationId === operationId} onAutoStartConsumed={() => { setAutoStart(null); onPreparationAuthorizationConsumed?.(); }} readOnly={readOnly} />
      </div> : selectedId ? <div className="space-y-3"><AppLink className={buttonVariants({ variant: "outline", size: "sm" })} href={href(null)}>{t(($) => $.meeting_lifecycle.close)}</AppLink>
        <CockpitAgendaReader key={`${wsId}:${meetingId}:${selectedId}`} wsId={wsId} meetingId={meetingId} agendaId={selectedId} accountId={accountId} inputsAvailable={inputsAvailable} resourcesHref={resourcesHref} readOnly={readOnly} canAddPreparation={canAddPreparation} />
      </div> : <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-title-sm font-medium">{t(($) => $.meeting_lifecycle.agenda)}</h3>
          <Dialog open={create} onOpenChange={(next) => { if (next || !dialogBusy.current) setCreate(next); }}><DialogTrigger render={<Button size="sm" disabled={!pendingCreate && (readOnly || !lifecycle.data.can_edit_agenda)} />}>{t(($) => $.meeting_lifecycle.add)}</DialogTrigger>
            {create && <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{t(($) => $.meeting_lifecycle.add)}</DialogTitle></DialogHeader>
              <CockpitAgendaEditor key={`${wsId}:${meetingId}:new`} wsId={wsId} meetingId={meetingId} header={lifecycle.data} readOnly={readOnly} onBusyChange={(busy) => { dialogBusy.current = busy; }} onSaved={(id) => { setCreate(false); navigation.push(href(id)); }} />
            </DialogContent>}
          </Dialog></div>
        <label className="block space-y-1 text-caption">{t(($) => $.meeting_lifecycle.search)}<Input value={text} name="meeting-agenda-search" autoComplete="off" onChange={(event) => { useCockpitScopeViewStore.getState().updateAgenda(viewKey, { query: event.target.value }); }} /></label>
        <label className="flex items-center gap-2 text-caption"><input type="checkbox" checked={removed} onChange={(event) => { useCockpitScopeViewStore.getState().updateAgenda(viewKey, { includeRemoved: event.target.checked }); }} />{t(($) => $.meeting_lifecycle.show_removed)}</label>
        {query.isPending || changing ? <Spinner /> : query.isError || !page ? <CockpitFlowError onRetry={() => void query.refetch()} /> : <>
          <CockpitFlowPaging page={cursors.length} shown={page.items.length} total={page.total} hasNext={Boolean(page.next_cursor)} busy={query.isFetching} onPrevious={() => setCursors(cursors.slice(0, -1))} onNext={() => { if (page.next_cursor) setCursors([...cursors, page.next_cursor]); }} />
          <ul ref={restoreList} onScroll={(event) => { if (useCockpitScopeViewStore.getState().sessionGeneration === generation.current) useCockpitScopeViewStore.getState().updateAgenda(viewKey, { scrollTop: event.currentTarget.scrollTop }); }} className="max-h-[45vh] divide-y divide-border overflow-y-auto overscroll-contain">{page.items.map((item) => <li key={item.id} className="space-y-1 py-3"><AppLink href={href(item.id)} title={item.title} aria-label={t(($) => $.meeting_lifecycle.open, { title: item.title })} className="line-clamp-2 break-words text-body font-medium hover:underline">{item.title}</AppLink>
            <div className="flex flex-wrap gap-x-3 gap-y-1 break-words text-caption text-muted-foreground">{item.removed_at && <span>{t(($) => $.meeting_lifecycle.removed)}</span>}{item.node_id && <span>{item.node_code} {item.node_title}</span>}{item.facilitator_name && <span>{item.facilitator_name}</span>}</div>
          </li>)}</ul>{page.items.length === 0 && <p className="text-caption text-muted-foreground">{q ? t(($) => $.task_flow.no_matches) : t(($) => $.meeting_lifecycle.empty)}</p>}
        </>}
        {cursors.length > 1 && <Button type="button" size="sm" variant="outline" onClick={() => void firstPage()}>{t(($) => $.meeting_lifecycle.refresh_first)}</Button>}
      </section>}
      {preparationAvailable && !operationId && <div className="space-y-2">
        {templatesAvailable && <CockpitMeetingTemplateApplication wsId={wsId} meetingId={meetingId} resourcesHref={resourcesHref} disabled={Boolean(readOnly) || basis.isError || basis.data?.availability !== "available" || basis.data.apply_template.state !== "allowed"} onCreated={(id, advance) => { setAutoStart(advance ? id : null); navigation.push(cockpitMeetingPreparationPath(paths.cockpit(), meetingId, id, navigation.searchParams)); }} />}
        {basis.isError && <CockpitFlowError onRetry={() => void basis.refetch()} />}
        {templatesAvailable && basis.data?.apply_template.state === "blocked" && <CockpitPreparationReasons codes={basis.data.apply_template.reason_codes} targets={basis.data.targets} />}
        <CockpitPreparationHistory wsId={wsId} meetingId={meetingId} />
      </div>}
      <CockpitMeetingMaterialsConfirmation wsId={wsId} header={lifecycle.data} resourcesHref={resourcesHref} workflowHref={workflowHref} readOnly={readOnly} />
    </>}
  </section>;
}

function CockpitAgendaReader({ wsId, meetingId, agendaId, accountId, inputsAvailable, resourcesHref, readOnly, canAddPreparation }: { wsId: string; meetingId: string; agendaId: string; accountId?: string; inputsAvailable?: boolean; resourcesHref: string; readOnly?: boolean; canAddPreparation?: boolean }) {
  const query = useQuery(cockpitAgendaDetailOptions(wsId, meetingId, agendaId));
  if (query.isPending) return <Spinner />;
  if (query.isError || !query.data) return <CockpitFlowError onRetry={() => void query.refetch()} />;
  return <div className="space-y-4"><CockpitAgendaEditor wsId={wsId} meetingId={meetingId} agenda={query.data} readOnly={readOnly} refresh={() => void query.refetch()} />
    {inputsAvailable && accountId && <CockpitMeetingInputs wsId={wsId} accountId={accountId} meetingId={meetingId} agendaId={agendaId} targetLabel={query.data.title} readOnly={readOnly || Boolean(query.data.removed_at)} />}
    <CockpitAgendaReferences wsId={wsId} meetingId={meetingId} agenda={query.data} resourcesHref={resourcesHref} readOnly={readOnly || query.data.purposes.some((purpose) => !isPurpose(purpose))} canAddPreparation={canAddPreparation} />
  </div>;
}

function CockpitAgendaEditor({ wsId, meetingId, agenda, header, readOnly, onSaved, refresh, onBusyChange }: { wsId: string; meetingId: string; agenda?: CockpitAgendaDetail; header?: CockpitMeetingLifecycleHeader; readOnly?: boolean; onSaved?: (id: string) => void; refresh?: () => void; onBusyChange?: (busy: boolean) => void }) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths(); const key = cockpitMeetingAgendaDraftKey(wsId, meetingId, agenda?.id ?? "new-agenda");
  const initial: CockpitAgendaDraft = { observedRevision: agenda?.revision ?? header?.agenda_revision ?? 0, title: agenda?.title ?? "", purposes: agenda?.purposes.filter(isPurpose) ?? [], desiredOutcome: agenda?.desired_outcome ?? "", notes: agenda?.notes ?? "", facilitatorId: agenda?.facilitator_user_id ?? "", nodeId: agenda?.node_id ?? "" };
  const stored = useCockpitMeetingAgendaDraftStore((state) => state.draft.agendas[key]); const value = stored ?? initial;
  const command = useCockpitMeetingCommand(wsId, meetingId, key); const selectedNode = useCockpitSelectedNodeIssueOption(value.nodeId);
  useEffect(() => { onBusyChange?.(command.busy); return () => onBusyChange?.(false); }, [command.busy, onBusyChange]);
  const facilitator = useQuery(cockpitSelectedMemberOptions(wsId, value.facilitatorId));
  const revision = agenda?.revision ?? header?.agenda_revision ?? 0; const changed = value.observedRevision !== revision;
  const unknown = agenda?.purposes.filter((purpose) => !isPurpose(purpose)) ?? [];
  const writable = !readOnly && !agenda?.removed_at && (agenda ? agenda.can_edit : header?.can_edit_agenda) && unknown.length === 0;
  const invalid = !value.title.trim() || size(value.title.trim()) > 500 || size(value.desiredOutcome) > 16000 || size(value.notes) > 65536;
  const invalidSelection = Boolean(value.nodeId && (selectedNode.isPending || selectedNode.isFetching || selectedNode.isError || !selectedNode.option)) || Boolean(value.facilitatorId && (facilitator.isPending || facilitator.isFetching || facilitator.isError || !facilitator.data?.items.some((item) => item.id === value.facilitatorId)));
  const disabled = Boolean(command.pending) || command.busy || !writable;
  const change = (patch: Partial<Omit<CockpitAgendaDraft, "observedRevision">>) => updateCockpitAgendaDraft(key, initial, patch);
  const save = async () => {
    if (command.busy || !command.pending && (!writable || changed || invalid || invalidSelection)) return;
    const body = { command_key: createSafeId(), expected_revision: value.observedRevision, title: value.title.trim(), purposes: value.purposes, desired_outcome: value.desiredOutcome, notes: value.notes, facilitator_user_id: value.facilitatorId || null, node_id: value.nodeId || null };
    const response = await command.run(command.pending ?? (agenda ? { kind: "agenda_update", agendaId: agenda.id, body } : { kind: "agenda_create", body }));
    if (response) { clearCockpitAgendaDraft(key, value); if (response.stillCurrent() && response.result.receipt.agenda_id) onSaved?.(response.result.receipt.agenda_id); }
  };
  return <section className="space-y-4" aria-label={t(($) => $.meeting_lifecycle.agenda)}>
    {agenda?.removed_at && <p className="text-caption text-muted-foreground">{t(($) => $.meeting_lifecycle.removed)}</p>}
    {unknown.map((purpose) => <p key={purpose} role="status" className="text-caption text-muted-foreground">{t(($) => $.meeting_lifecycle.unknown_purpose, { purpose })}</p>)}
    <label className="block space-y-1 text-caption">{t(($) => $.meeting_lifecycle.agenda_title)}<Input value={value.title} disabled={disabled} onChange={(event) => change({ title: event.target.value })} /></label>
    <fieldset disabled={disabled} className="space-y-2"><legend className="mb-2 text-caption">{t(($) => $.meeting_lifecycle.purposes)}</legend><div className="flex flex-wrap gap-x-4 gap-y-2">{purposes.map((purpose) => <label key={purpose} className="flex items-center gap-2 text-caption"><input type="checkbox" checked={value.purposes.includes(purpose)} onChange={(event) => change({ purposes: event.target.checked ? [...value.purposes, purpose] : value.purposes.filter((item) => item !== purpose) })} />{t(($) => $.meeting_lifecycle[purpose])}</label>)}</div></fieldset>
    <label className="block space-y-1 text-caption">{t(($) => $.meeting_lifecycle.desired_outcome)}<Textarea className="max-h-56 resize-y overflow-y-auto" value={value.desiredOutcome} disabled={disabled} onChange={(event) => change({ desiredOutcome: event.target.value })} /></label>
    <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-2"><CockpitReviewerSelect wsId={wsId} value={value.facilitatorId} disabled={disabled} onChange={(facilitatorId) => change({ facilitatorId })} label={t(($) => $.meeting_lifecycle.facilitator)} emptyLabel={t(($) => $.common.unset)} missingLabel={t(($) => $.meeting_lifecycle.facilitator_missing)} />
      {value.facilitatorId && <Button type="button" size="xs" variant="ghost" disabled={disabled} onClick={() => change({ facilitatorId: "" })}>{t(($) => $.meeting_lifecycle.no_facilitator)}</Button>}</div>
      <div className="space-y-2"><p className="text-caption">{t(($) => $.meeting_lifecycle.node)}</p><CockpitNodeIssuePicker value={selectedNode.option} disabled={disabled} onUpdate={(node) => change({ nodeId: node?.node_id ?? "" })} />
        {selectedNode.isError && <CockpitFlowError onRetry={() => void selectedNode.refetch()} />}
        {value.nodeId && <div className="space-y-1 text-caption">{!selectedNode.isPending && !selectedNode.option && <p className="text-muted-foreground">{t(($) => $.meeting_lifecycle.node_unavailable)}</p>}
          <AppLink target="_blank" rel="noopener noreferrer" className="text-primary underline" href={cockpitObjectPath(paths.cockpit(), { kind: "node", id: value.nodeId, view: "details" }, EMPTY_COCKPIT_SCOPE)}>{t(($) => $.meeting_lifecycle.repair_node)} {t(($) => $.action_flow.new_tab)}</AppLink>
          <Button size="xs" variant="ghost" disabled={disabled} onClick={() => change({ nodeId: "" })}>{t(($) => $.meeting_lifecycle.clear_node)}</Button></div>}
      </div></div>
    <p className="text-caption text-muted-foreground">{t(($) => $.meeting_lifecycle.node_optional)}</p>
    <label className="block space-y-1 text-caption">{t(($) => $.meeting_lifecycle.notes)}<Textarea className="min-h-40 max-h-[45vh] resize-y overflow-y-auto" value={value.notes} disabled={disabled} onChange={(event) => change({ notes: event.target.value })} /></label><p className="text-caption text-muted-foreground">{t(($) => $.meeting_lifecycle.notes_hint)}</p>
    {changed && !command.pending && <div role="alert" className="space-y-2 rounded-md border border-border p-3 text-caption"><p>{t(($) => $.meeting_lifecycle.changed)}</p>
      {agenda && <details><summary className="cursor-pointer">{t(($) => $.meeting_lifecycle.refresh)}</summary><p className="whitespace-pre-wrap break-words">{agenda.title}</p><p className="whitespace-pre-wrap break-words">{agenda.desired_outcome}</p><p className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words">{agenda.notes}</p></details>}
      <Button type="button" size="sm" variant="outline" disabled={!writable} onClick={() => { if (!stored) updateCockpitAgendaDraft(key, initial, {}); rebaseCockpitAgendaDraft(key, revision); }}>{t(($) => $.meeting_lifecycle.rebase)}</Button>{refresh && <Button type="button" size="sm" variant="ghost" onClick={refresh}>{t(($) => $.meeting_lifecycle.refresh)}</Button>}</div>}
    {invalid && stored && <p role="alert" className="text-caption text-destructive">{t(($) => $.meeting_lifecycle.size_error)}</p>}
    <CockpitMeetingCommandRecovery command={command} onConfirmed={() => clearCockpitAgendaDraft(key, value)} onCurrentConfirmed={(result) => { if (result.receipt.agenda_id) onSaved?.(result.receipt.agenda_id); }} />
    {command.error && <p role="alert" className="break-words text-caption text-destructive">{command.error}</p>}
    <div className="flex flex-wrap justify-between gap-2"><Button onClick={() => void save()} disabled={command.busy || !command.pending && (!writable || changed || invalid || invalidSelection)} aria-busy={command.busy}>{command.busy && <Spinner />}{command.pending ? t(($) => $.meeting_lifecycle.retry_command) : t(($) => $.meeting_lifecycle.save)}</Button>
      {agenda && <CockpitAgendaRemove wsId={wsId} meetingId={meetingId} agenda={agenda} readOnly={readOnly} />}</div>
  </section>;
}

function CockpitAgendaRemove({ wsId, meetingId, agenda, readOnly }: { wsId: string; meetingId: string; agenda: CockpitAgendaDetail; readOnly?: boolean }) {
  const { t } = useT("cockpit"); const [open, setOpen] = useState(false); const dialogBusy = useRef(false);
  const pending = useCockpitMeetingAgendaDraftStore((state) => state.draft.commands[cockpitMeetingAgendaDraftKey(wsId, meetingId, `remove:${agenda.id}`)]);
  return <Dialog open={open} onOpenChange={(next) => { if (next || !dialogBusy.current) setOpen(next); }}><DialogTrigger render={<Button size="sm" variant="ghost" disabled={!pending && (readOnly || !agenda.can_remove || Boolean(agenda.removed_at))} />}>{t(($) => $.meeting_lifecycle.remove)}</DialogTrigger>
    {open && <AgendaRemoveForm wsId={wsId} meetingId={meetingId} agenda={agenda} onDone={() => setOpen(false)} onBusyChange={(busy) => { dialogBusy.current = busy; }} />}
  </Dialog>;
}
function AgendaRemoveForm({ wsId, meetingId, agenda, onDone, onBusyChange }: { wsId: string; meetingId: string; agenda: CockpitAgendaDetail; onDone: () => void; onBusyChange: (busy: boolean) => void }) {
  const { t } = useT("cockpit"); const command = useCockpitMeetingCommand(wsId, meetingId, cockpitMeetingAgendaDraftKey(wsId, meetingId, `remove:${agenda.id}`));
  useEffect(() => { onBusyChange(command.busy); return () => onBusyChange(false); }, [command.busy, onBusyChange]);
  const pending = command.pending?.kind === "agenda_remove" ? command.pending : null;
  const formKey = cockpitMeetingAgendaDraftKey(wsId, meetingId, `remove-form:${agenda.id}`);
  const [initial] = useState<Extract<CockpitMeetingFormDraft, { kind: "remove" }>>(() => ({ kind: "remove", observedRevision: pending?.body.expected_revision ?? agenda.revision, reason: pending?.body.reason ?? "" }));
  const stored = useCockpitMeetingAgendaDraftStore((state) => state.draft.forms[formKey]); const value = stored?.kind === "remove" ? stored : initial;
  const { observedRevision: revision, reason } = value;
  const setReason = (reason: string) => setCockpitMeetingFormDraft(formKey, { ...value, reason });
  const save = async () => { if (command.busy || !pending && (!reason.trim() || revision !== agenda.revision)) return;
    setCockpitMeetingFormDraft(formKey, value);
    const response = await command.run(pending ?? { kind: "agenda_remove", agendaId: agenda.id, body: { command_key: createSafeId(), expected_revision: revision, reason: reason.trim() } }); if (response) { clearCockpitMeetingFormDraft(formKey, value); if (response.stillCurrent()) onDone(); } };
  return <DialogContent><DialogHeader><DialogTitle>{t(($) => $.meeting_lifecycle.remove)}</DialogTitle><DialogDescription>{t(($) => $.meeting_lifecycle.remove_hint)}</DialogDescription></DialogHeader>
    <label className="space-y-1 text-caption">{t(($) => $.meeting_lifecycle.reason)}<Textarea className="max-h-56 resize-y overflow-y-auto" value={reason} disabled={Boolean(pending) || command.busy} onChange={(event) => setReason(event.target.value)} /></label>
    {revision !== agenda.revision && !pending && <div role="alert" className="space-y-2 text-caption"><p>{t(($) => $.meeting_lifecycle.changed)}</p><Button size="sm" variant="outline" onClick={() => setCockpitMeetingFormDraft(formKey, { ...value, observedRevision: agenda.revision })}>{t(($) => $.meeting_lifecycle.rebase)}</Button></div>}{command.error && <p role="alert" className="break-words text-caption text-destructive">{command.error}</p>}
    <CockpitMeetingCommandRecovery command={command} onConfirmed={() => clearCockpitMeetingFormDraft(formKey, value)} onCurrentConfirmed={onDone} />
    <Button variant="destructive" disabled={command.busy || !pending && (!reason.trim() || revision !== agenda.revision)} onClick={() => void save()}>{pending ? t(($) => $.meeting_lifecycle.retry_command) : t(($) => $.meeting_lifecycle.remove)}</Button>
  </DialogContent>;
}
