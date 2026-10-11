"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cockpitPreparationOperationOptions, cockpitPreparationEffectsOptions, cockpitPreparationEffectOptions,
  useApplyCockpitPreparationEffect, cockpitPreparationEffectAcknowledged, invalidateCockpitMeetingPreparationFacts,
  cockpitMeetingPreparationDraftKey, useCockpitMeetingPreparationDraftStore, cockpitMeetingAgendaPath, cockpitObjectPath, EMPTY_COCKPIT_SCOPE, cockpitPreparationGrantReplaced, settleCockpitPreparationCommand,
} from "@multica/core/cockpit";
import type { CockpitPreparationEffect, CockpitPreparationOperationHeader } from "@multica/core/types";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useLocale, useT } from "../../i18n";
import { AppLink, useNavigation } from "../../navigation";
import { CockpitFlowError, CockpitFlowPaging } from "./cockpit-task-flow";
import { CockpitPreparationReasons, usePreparationEffectLabel } from "./cockpit-preparation-preview";
import { useCockpitPreparationRequest, CockpitPreparationUnobservedError } from "./use-cockpit-preparation-request";
import { useCockpitCommandContext } from "./use-cockpit-command-context";
import { CockpitPreparationControl } from "./cockpit-preparation-control";
import { CockpitPreparationRun, usePreparationRunStatusLabel } from "./cockpit-preparation-run";
import { CockpitPreparationReauthorization, CockpitPreparationAuthorizationRecord } from "./cockpit-preparation-reauthorization";

const knownStates = new Set(["active", "paused", "needs_attention", "completed"]);
const knownKinds = new Set(["agenda", "preparation_issue", "issue_reference", "material_reference", "cancel_issue", "change_due_date", "link_meeting", "stop_run"]);

export function CockpitPreparationOperation({ wsId, meetingId, operationId, autoStart = false, onAutoStartConsumed, readOnly }: {
  wsId: string; meetingId: string; operationId: string; autoStart?: boolean; onAutoStartConsumed?: () => void; readOnly?: boolean;
}) {
  const { t } = useT("cockpit"); const locale = useLocale(); const client = useQueryClient(); const [cursors, setCursors] = useState([""]);
  const header = useQuery(cockpitPreparationOperationOptions(wsId, meetingId, operationId)); const current = header.data;
  const effects = useQuery(cockpitPreparationEffectsOptions(wsId, meetingId, operationId, { cursor: cursors.at(-1) || undefined, page_size: 25 })); const page = effects.data;
  const apply = useApplyCockpitPreparationEffect(wsId, meetingId, operationId);
  const key = cockpitMeetingPreparationDraftKey(wsId, "effect", meetingId, operationId);
  const request = useCockpitPreparationRequest(key); const capture = useCockpitCommandContext(key);
  const unresolved = request.pending?.kind === "effect" ? request.pending : null;
  const observed = useQuery({ ...cockpitPreparationEffectOptions(wsId, meetingId, operationId, unresolved?.effectId ?? ""), enabled: false });
  const replaced = Boolean(unresolved && observed.data && cockpitPreparationGrantReplaced(unresolved, observed.data));
  const advancing = useRef<symbol | null>(null); const stop = useRef(false); const consumed = useRef(false);
  const listRef = useRef<HTMLUListElement>(null); const jumpRef = useRef<string | null>(null);
  const navigation = useNavigation(); const signature = JSON.stringify([wsId, meetingId, operationId, navigation.pathname, navigation.searchParams.toString()]);
  const lifetime = useRef({ signature, generation: 0 });
  if (lifetime.current.signature !== signature) { lifetime.current = { signature, generation: lifetime.current.generation + 1 }; stop.current = true; advancing.current = null; }
  const identity = lifetime.current.generation;
  const [ui, setUi] = useState({ identity, running: false, message: "", activeLabel: "", problemId: "", locating: false });
  const updateUi = (patch: Partial<Omit<typeof ui, "identity">>) => { if (lifetime.current.generation === identity) setUi((old) => ({ ...(old.identity === identity ? old : { identity, running: false, message: "", activeLabel: "", problemId: "", locating: false }), ...patch })); };
  const running = ui.identity === identity && ui.running, message = ui.identity === identity ? ui.message : "", activeLabel = ui.identity === identity ? ui.activeLabel : "";
  const problemId = ui.identity === identity ? ui.problemId : ""; const locating = ui.identity === identity && ui.locating;
  const setProblemId = (problemId: string) => updateUi({ problemId });
  const setRunning = (running: boolean) => updateUi({ running }); const setMessage = (message: string) => updateUi({ message }); const setActiveLabel = (activeLabel: string) => updateUi({ activeLabel });
  const knownOperation = current?.kind === "apply_template" || current?.kind === "cancel_preparation";
  const allowed = Boolean(!readOnly && knownOperation && current && !header.isError && current.state === "active" && current.can_continue && current.counts.total <= 50);

  const lookup = async () => request.verify(async (command) => {
    if (command.kind !== "effect" || command.operationId !== operationId || command.meetingId !== meetingId) throw new Error(t(($) => $.meeting_templates.unconfirmed));
    const detail = await client.fetchQuery({ ...cockpitPreparationEffectOptions(wsId, meetingId, operationId, command.effectId), staleTime: 0 });
    if (!detail) throw new Error(t(($) => $.meeting_templates.unconfirmed));
    if (cockpitPreparationGrantReplaced(command, detail)) throw new Error(t(($) => $.meeting_preparation.grant_replaced));
    if (!detail.effect.receipt) throw new CockpitPreparationUnobservedError(t(($) => $.meeting_preparation.not_observed));
    if (!cockpitPreparationEffectAcknowledged(detail, operationId, command.effectId, command.body.command_key, command.body.authorization_key, command.body.authorization_revision)) throw new Error(t(($) => $.meeting_templates.unconfirmed));
    await invalidateCockpitMeetingPreparationFacts(client, wsId, meetingId, operationId); return detail;
  });
  const check = async () => { const result = await lookup(); if (result?.stillCurrent()) setMessage(t(($) => $.meeting_preparation.checked)); };
  const advance = async () => {
    if (advancing.current || readOnly) return;
    const token = Symbol("preparation-sequence"); const stillCurrent = capture(); advancing.current = token; stop.current = false; setRunning(true); setMessage(""); setProblemId("");
    try {
      const fresh = await client.fetchQuery({ ...cockpitPreparationOperationOptions(wsId, meetingId, operationId), staleTime: 0 });
      if (!stillCurrent() || stop.current || !fresh || !["apply_template", "cancel_preparation"].includes(fresh.kind) || fresh.state !== "active" || !fresh.can_continue || fresh.counts.total > 50) return;
      const unresolved = useCockpitMeetingPreparationDraftStore.getState().draft.commands[key];
      if (unresolved) {
        // Continuing never silently retries an unresolved write; the separate check action is read-only.
        if (!request.canRetry || unresolved.kind !== "effect") { if (stillCurrent()) setMessage(t(($) => $.meeting_preparation.check_first)); return; }
        const observed = await client.fetchQuery({ ...cockpitPreparationEffectOptions(wsId, meetingId, operationId, unresolved.effectId), staleTime: 0 });
        if (!stillCurrent() || !observed || !observed.effect.can_apply || observed.effect.state !== "pending") return;
        setActiveLabel(observed.effect.label);
        const result = await request.run(unresolved, async (command) => {
          if (command.kind !== "effect") throw new Error(t(($) => $.meeting_templates.unconfirmed));
          return apply.mutateAsync({ effectId: command.effectId, body: command.body });
        });
        if (!result) { setProblemId(unresolved.effectId); const unknown = Boolean(useCockpitMeetingPreparationDraftStore.getState().draft.commands[key]); if (unknown) await lookup(); if (stillCurrent()) setMessage(unknown ? t(($) => $.meeting_preparation.stopped_unknown) : t(($) => $.meeting_preparation.stopped)); return; }
      }
      let cursor: string | undefined; let attempts = 0; let pagesRead = 0; const visited = new Set<string>();
      do {
        if (++pagesRead > 2 || cursor && visited.has(cursor)) throw new Error(t(($) => $.errors.load_failed));
        if (cursor) visited.add(cursor);
        const batch = await client.fetchQuery({ ...cockpitPreparationEffectsOptions(wsId, meetingId, operationId, { page_size: 25, cursor }), staleTime: 0 });
        if (!stillCurrent() || stop.current || !batch || batch.total > 50) break;
        if (batch.next_cursor && batch.items.length === 0) throw new Error(t(($) => $.errors.load_failed));
        for (const row of batch.items) {
          if (!stillCurrent() || stop.current || attempts >= 50) return;
          if (row.state === "applied" || row.state === "skipped") continue;
          setProblemId(row.id);
          const detail = await client.fetchQuery({ ...cockpitPreparationEffectOptions(wsId, meetingId, operationId, row.id), staleTime: 0 });
          if (!stillCurrent() || stop.current || !detail) return;
          const effect = detail.effect;
          if (effect.state === "applied" || effect.state === "skipped") continue;
          if (detail.current.state !== "active" || !detail.current.can_continue || effect.state !== "pending" || !effect.can_apply || !effect.authorization_key || effect.authorization_revision < 1 || !knownKinds.has(effect.kind)) { setMessage(t(($) => $.meeting_preparation.stopped)); return; }
          setActiveLabel(effect.label); attempts += 1;
          const result = await request.run({ kind: "effect", meetingId, operationId, effectId: effect.id, body: { command_key: effect.command_key, authorization_key: effect.authorization_key, authorization_revision: effect.authorization_revision } }, async (command) => {
            if (command.kind !== "effect") throw new Error(t(($) => $.meeting_templates.unconfirmed));
            return apply.mutateAsync({ effectId: command.effectId, body: command.body });
          });
          if (!result) {
            // A fixed receipt can confirm this item after a lost response. It never authorizes automatic continuation.
            const unknown = Boolean(useCockpitMeetingPreparationDraftStore.getState().draft.commands[key]);
            if (unknown) await lookup(); if (stillCurrent()) setMessage(unknown ? t(($) => $.meeting_preparation.stopped_unknown) : t(($) => $.meeting_preparation.stopped)); return;
          }
          if (!result.stillCurrent() || result.result.current.state !== "active") return;
        }
        cursor = batch.next_cursor ?? undefined;
      } while (cursor && attempts < 50 && stillCurrent() && !stop.current);
    } catch (cause) { if (stillCurrent()) setMessage(cause instanceof Error ? cause.message : String(cause)); }
    finally {
      if (advancing.current === token) advancing.current = null;
      if (stillCurrent()) { setRunning(false); setActiveLabel(""); }
    }
  };
  const locate = async () => {
    const target = unresolved?.effectId ?? problemId; if (!target || locating || running) return;
    const stillCurrent = capture(); updateUi({ locating: true });
    try {
      const stack = [""];
      for (let index = 0; index < 2; index++) {
        const found = await client.fetchQuery({ ...cockpitPreparationEffectsOptions(wsId, meetingId, operationId, { page_size: 25, cursor: stack.at(-1) || undefined }), staleTime: 0 });
        if (!stillCurrent()) return;
        if (found.items.some((item) => item.id === target)) { jumpRef.current = target; setCursors([...stack]); return; }
        if (!found.next_cursor || stack.includes(found.next_cursor)) break; stack.push(found.next_cursor);
      }
      setMessage(t(($) => $.meeting_preparation.item_unavailable));
    } catch (cause) { if (stillCurrent()) setMessage(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (stillCurrent()) updateUi({ locating: false }); }
  };
  useEffect(() => {
    if (!jumpRef.current || !listRef.current) return;
    const target = Array.from(listRef.current.children).find((element) => element instanceof HTMLElement && element.dataset.effectId === jumpRef.current);
    if (target instanceof HTMLElement) { target.scrollIntoView({ block: "nearest" }); target.focus({ preventScroll: true }); jumpRef.current = null; }
  }, [page, cursors]);
  useEffect(() => { return () => { stop.current = true; }; }, []);
  const startLatest = useRef(advance); startLatest.current = advance;
  const currentId = current?.id; const hasUnresolved = Boolean(request.pending);
  useEffect(() => {
    if (!autoStart || consumed.current || !currentId) return;
    consumed.current = true; onAutoStartConsumed?.();
    if (allowed && !hasUnresolved) void startLatest.current();
  }, [autoStart, currentId, allowed, hasUnresolved, onAutoStartConsumed]);

  return <section aria-label={t(($) => $.meeting_preparation.title)} className="min-w-0 space-y-3">
    {header.isPending ? <Spinner /> : header.isError || !current ? <CockpitFlowError onRetry={() => void header.refetch()} /> : <>
      <div className="space-y-2 rounded-lg border border-border p-3"><h3 className="text-title-sm font-medium">{current.kind === "apply_template" ? t(($) => $.meeting_preparation.template_application) : current.kind === "cancel_preparation" ? t(($) => $.meeting_preparation.cancellation) : t(($) => $.artifacts.unknown)}</h3>
        <p className="text-caption text-muted-foreground">{current.state === "active" || current.state === "paused" || current.state === "needs_attention" || current.state === "completed" ? t(($) => $.meeting_preparation[`state_${current.state as "active" | "paused" | "needs_attention" | "completed"}`]) : t(($) => $.artifacts.unknown)}</p>
        {current.template_title && <p className="line-clamp-2 break-words text-body" title={current.template_title}>{current.template_title}{current.template_version_number !== null && <> · {t(($) => $.workflow.version, { number: current.template_version_number })}</>}</p>}
        <p className="break-words text-caption text-muted-foreground">{t(($) => $.meeting_preparation.responsible, { name: current.responsible_user_name || (current.responsible_user_id === current.created_by ? current.created_by_name : "") || t(($) => $.meeting_preparation.responsible_unknown) })} · {Number.isFinite(Date.parse(current.created_at)) ? new Date(current.created_at).toLocaleString(locale) : t(($) => $.common.unset)}</p>
        <PreparationCounts value={current} />
        {current.kind === "apply_template" && <p className="text-caption text-muted-foreground">{t(($) => $.meeting_preparation.registration_only)}</p>}
        {current.kind === "cancel_preparation" && <p className="text-caption text-muted-foreground">{t(($) => $.meeting_preparation.cancel_recorded)}</p>}
        {!knownStates.has(current.state) && <p className="text-caption text-muted-foreground">{t(($) => $.artifacts.unknown)}</p>}
        <CockpitPreparationReasons codes={current.blocked_reasons} />
        <div className="flex flex-wrap gap-2">{running ? <Button variant="outline" size="sm" onClick={() => { stop.current = true; setMessage(t(($) => $.meeting_preparation.stopping_here)); }}>{t(($) => $.meeting_preparation.stop_here)}</Button>
          : current.state === "active" && <Button size="sm" disabled={!allowed || request.busy || Boolean(request.pending) && !request.canRetry} onClick={() => void advance()}>{t(($) => $.meeting_preparation.continue)}</Button>}
          <CockpitPreparationControl wsId={wsId} header={current} disabled={readOnly || running || request.busy || !knownOperation || !knownStates.has(current.state)} onResumed={() => void advance()} />
          <Button variant="ghost" size="sm" disabled={running || request.busy} onClick={() => { void header.refetch(); void effects.refetch(); }}>{t(($) => $.meeting_lifecycle.refresh)}</Button>
        </div>
      </div>
      {running && <p role="status" className="flex items-start gap-2 break-words text-caption"><Spinner />{t(($) => $.meeting_preparation.applying, { title: activeLabel })}</p>}
      {request.pending && <div className="space-y-2 text-caption"><p>{t(($) => $.meeting_preparation.check_first)}</p><Button variant="outline" size="sm" disabled={request.busy || running} onClick={() => void check()}>{t(($) => $.meeting_lifecycle.check_command)}</Button></div>}
      {replaced && unresolved && observed.data && <div role="alert" className="space-y-2 rounded-md border border-border p-3 text-caption"><p>{t(($) => $.meeting_preparation.grant_replaced)}</p><CockpitPreparationAuthorizationRecord wsId={wsId} meetingId={meetingId} commandKey={observed.data.effect.authorization_key} /><Button variant="outline" size="sm" disabled={request.busy || running} onClick={() => { settleCockpitPreparationCommand(key, unresolved.body.command_key, unresolved.body); setMessage(t(($) => $.meeting_preparation.grant_dismissed)); }}>{t(($) => $.meeting_preparation.dismiss_expired)}</Button></div>}
      {(unresolved || problemId && current.state !== "completed") && <Button variant="outline" size="sm" disabled={running || request.busy || locating} onClick={() => void locate()}>{locating && <Spinner />}{t(($) => $.meeting_preparation.locate_item)}</Button>}
      {(message || request.error) && <p role="status" className="break-words text-caption">{message || request.error}</p>}
      {effects.isPending ? <Spinner /> : effects.isError || !page ? <CockpitFlowError onRetry={() => void effects.refetch()} /> : <>
        <CockpitFlowPaging page={cursors.length} shown={page.items.length} total={page.total} hasNext={Boolean(page.next_cursor)} busy={effects.isFetching} onPrevious={() => setCursors(cursors.slice(0, -1))} onNext={() => { if (page.next_cursor) setCursors([...cursors, page.next_cursor]); }} />
        <ul ref={listRef} className="max-h-[45vh] divide-y divide-border overflow-y-auto rounded-lg border border-border px-3">{page.items.map((effect) => <PreparationEffectRow key={effect.id} wsId={wsId} meetingId={meetingId} effect={effect} header={current} disabled={readOnly || running || request.busy} />)}</ul>
      </>}
      {cursors.length > 1 && <Button variant="outline" size="sm" onClick={() => setCursors([""])}>{t(($) => $.task_flow.first_page)}</Button>}
    </>}
  </section>;
}

function PreparationCounts({ value }: { value: CockpitPreparationOperationHeader }) {
  const { t } = useT("cockpit");
  return <dl className="flex flex-wrap gap-x-4 gap-y-2 text-caption">{(["applied", "pending", "needs_attention", "skipped"] as const).map((state) => <div key={state} className="flex gap-1"><dt>{t(($) => $.meeting_preparation[state])}</dt><dd className="font-medium tabular-nums">{value.counts[state]}</dd></div>)}</dl>;
}

function PreparationEffectRow({ wsId, meetingId, effect, header, disabled }: { wsId: string; meetingId: string; effect: CockpitPreparationEffect; header: CockpitPreparationOperationHeader; disabled?: boolean }) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths(); const navigation = useNavigation(); const label = usePreparationEffectLabel(); const runStatus = usePreparationRunStatusLabel();
  const receipt = effect.receipt; const state = effect.state === "applied" || effect.state === "pending" || effect.state === "needs_attention" || effect.state === "skipped" ? t(($) => $.meeting_preparation[effect.state as "applied" | "pending" | "needs_attention" | "skipped"]) : t(($) => $.artifacts.unknown);
  return <li tabIndex={-1} data-effect-id={effect.id} aria-label={effect.label} className="space-y-2 py-3 text-caption focus-visible:rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><div className="flex flex-wrap items-start justify-between gap-2"><p className="line-clamp-2 min-w-0 flex-1 break-words font-medium" title={effect.label}>{effect.label}</p><span>{state}</span></div><p className="text-muted-foreground">{label(effect.kind)}</p>
    {receipt?.issue && <AppLink target="_blank" rel="noopener noreferrer" className="break-words text-primary underline" href={paths.issueDetail(receipt.issue.identifier || receipt.issue.id)}>{receipt.issue.identifier} {receipt.issue.title} {t(($) => $.action_flow.new_tab)}</AppLink>}
    {receipt?.agenda_id && effect.kind === "agenda" && <AppLink className="block text-primary underline" href={cockpitMeetingAgendaPath(paths.cockpit(), meetingId, receipt.agenda_id, navigation.searchParams)}>{t(($) => $.meeting_lifecycle.open_current_agenda)}</AppLink>}
    {effect.kind === "link_meeting" && receipt?.target_meeting_id && <AppLink target="_blank" rel="noopener noreferrer" className="block text-primary underline" href={cockpitObjectPath(paths.cockpit(), { kind: "meeting", id: receipt.target_meeting_id, view: "agenda", agendaId: receipt.agenda_id ?? undefined }, EMPTY_COCKPIT_SCOPE)}>{t(($) => $.meeting_disposition.open_target)} {t(($) => $.action_flow.new_tab)}</AppLink>}
    {effect.kind === "stop_run" && receipt && <div className="space-y-2"><p>{runStatus(receipt.run_status ?? "unknown")}</p><p className="text-muted-foreground">{t(($) => $.meeting_disposition.stop_hint)}</p>{receipt.run_id && <CockpitPreparationRun wsId={wsId} runId={receipt.run_id} issueId={receipt.issue_id} />}</div>}
    {effect.kind === "cancel_issue" && receipt && <p className="text-muted-foreground">{t(($) => $.meeting_preparation.actual_cancellations, { wakeups: receipt.stopped_wakeup_total, queued: receipt.cancelled_queue_total })}</p>}
    <CockpitPreparationReasons codes={effect.error_code ? [effect.error_code] : []} targets={effect.targets} />
    {effect.reason && <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-muted-foreground">{effect.reason}</p>}
    {receipt?.changed === false && <p className="text-muted-foreground">{t(($) => $.meeting_preparation.unchanged)}</p>}
    <div className="flex flex-wrap gap-2"><CockpitPreparationReauthorization wsId={wsId} meetingId={meetingId} effect={effect} disabled={disabled || !knownKinds.has(effect.kind)} /><CockpitPreparationControl wsId={wsId} header={header} effect={effect} disabled={disabled || !knownKinds.has(effect.kind)} /></div>
  </li>;
}
