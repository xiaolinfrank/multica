"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cockpitPreparationAuthorizationPreviewOptions, useReauthorizeCockpitPreparationEffect, cockpitLifecycleCommandOptions,
  cockpitPreparationCommandAcknowledged, invalidateCockpitMeetingPreparationFacts, cockpitMeetingPreparationDraftKey,
  useCockpitMeetingPreparationDraftStore, setCockpitPreparationForm, clearCockpitPreparationForm, type CockpitPreparationFormDraft,
} from "@multica/core/cockpit";
import type { CockpitDispositionIssue, CockpitDispositionRun, CockpitPreparationResolvedScope, CockpitPreparationAuthorization, CockpitPreparationEffect } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@multica/ui/components/ui/dialog";
import { useLocale, useT } from "../../i18n";
import { useWorkspacePaths } from "@multica/core/paths";
import { AppLink } from "../../navigation";
import { useStatusLabel } from "../../issues/utils/status-label";
import { CockpitFlowError } from "./cockpit-task-flow";
import { CockpitPreparationReasons } from "./cockpit-preparation-preview";
import { usePreparationRunStatusLabel, CockpitPreparationRun } from "./cockpit-preparation-run";
import { useCockpitPreparationRequest, useCockpitPreparationConfirmation } from "./use-cockpit-preparation-request";
import { createSafeId } from "@multica/core/utils";

export function CockpitPreparationReauthorization({ wsId, meetingId, effect, disabled }: {
  wsId: string; meetingId: string; effect: CockpitPreparationEffect; disabled?: boolean;
}) {
  const { t } = useT("cockpit"); const [open, setOpen] = useState(false); const busy = useRef(false);
  const key = cockpitMeetingPreparationDraftKey(wsId, "reauthorization", meetingId, effect.operation_id, effect.id);
  const pending = useCockpitMeetingPreparationDraftStore((state) => state.draft.commands[key]);
  const permitted = !disabled && effect.can_reauthorize && effect.state === "needs_attention" && !effect.receipt;
  if (!permitted && !pending) return null;
  return <Dialog open={open} onOpenChange={(next) => { if (next || !busy.current) setOpen(next); }}><DialogTrigger render={<Button size="sm" variant="outline" disabled={!pending && !permitted} />}>{t(($) => $.meeting_preparation.reauthorize)}</DialogTrigger>
    {open && <ReauthorizationForm key={`${wsId}:${meetingId}:${effect.id}`} wsId={wsId} meetingId={meetingId} effect={effect} draftKey={key} permitted={Boolean(permitted)} onBusy={(value) => { busy.current = value; }} onDone={() => setOpen(false)} />}
  </Dialog>;
}

function ReauthorizationForm({ wsId, meetingId, effect, draftKey, permitted, onBusy, onDone }: {
  wsId: string; meetingId: string; effect: CockpitPreparationEffect; draftKey: string; permitted: boolean; onBusy: (value: boolean) => void; onDone: () => void;
}) {
  const { t } = useT("cockpit"); const client = useQueryClient(); const [sessionId] = useState(() => createSafeId());
  const request = useCockpitPreparationRequest(draftKey); const original = request.pending?.kind === "reauthorization" ? request.pending : null;
  const { confirmed, setConfirmed, reviewRequired, previewAccepted, showError } = useCockpitPreparationConfirmation(request.cause);
  const [initial] = useState<Extract<CockpitPreparationFormDraft, { kind: "reauthorization" }>>(() => ({ kind: "reauthorization", effectId: effect.id, observedRevision: effect.revision, reason: original?.body.reason ?? "" }));
  const stored = useCockpitMeetingPreparationDraftStore((state) => state.draft.forms[draftKey]); const value = stored?.kind === "reauthorization" ? stored : initial;
  const base = cockpitPreparationAuthorizationPreviewOptions(wsId, meetingId, effect.operation_id, effect.id);
  const snapshot = useQuery({ queryKey: [...base.queryKey, "review-session", sessionId], queryFn: () => client.fetchQuery({ ...base, staleTime: 0 }), enabled: false, staleTime: Infinity, retry: false });
  const { refetch } = snapshot;
  useEffect(() => { void refetch(); }, [refetch]);
  const refreshPreview = async () => { setConfirmed(false); const result = await refetch(); if (result.isSuccess && result.data) previewAccepted(); };
  const mutation = useReauthorizeCockpitPreparationEffect(wsId, meetingId, effect.operation_id);
  const busy = request.busy || snapshot.isFetching; useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  const preview = snapshot.data; const changed = preview && preview.effect_revision !== effect.revision;
  const save = async () => {
    if (busy || !permitted || original && !request.canRetry || !original && (!confirmed || !preview?.can_confirm || changed || snapshot.isError || !value.reason.trim())) return;
    setCockpitPreparationForm(draftKey, value);
    const result = await request.run(original ?? { kind: "reauthorization", meetingId, operationId: effect.operation_id, effectId: effect.id,
      body: { command_key: createSafeId(), expected_revision: preview!.effect_revision, context_token: preview!.context_token, reason: value.reason.trim() } }, async (command) => {
      if (command.kind !== "reauthorization") throw new Error(t(($) => $.meeting_preparation.check_first)); return mutation.mutateAsync({ effectId: command.effectId, body: command.body });
    });
    if (result) { clearCockpitPreparationForm(draftKey, value); if (result.stillCurrent()) onDone(); }
  };
  const verify = async () => {
    const result = await request.verify(async (command) => {
      if (command.kind !== "reauthorization") throw new Error(t(($) => $.meeting_preparation.check_first));
      const detail = await client.fetchQuery({ ...cockpitLifecycleCommandOptions(wsId, meetingId, command.body.command_key), staleTime: 0 });
      if (!detail || !cockpitPreparationCommandAcknowledged(detail, "preparation_reauthorize", command.body, effect.operation_id, effect.id)) throw new Error(t(($) => $.meeting_preparation.check_first));
      await invalidateCockpitMeetingPreparationFacts(client, wsId, meetingId, effect.operation_id); return detail;
    });
    if (result) { clearCockpitPreparationForm(draftKey, value); if (result.stillCurrent()) onDone(); }
  };
  return <DialogContent className="flex max-h-[88dvh] flex-col overflow-hidden sm:max-w-2xl"><DialogHeader><DialogTitle>{t(($) => $.meeting_preparation.reauthorize)}</DialogTitle><DialogDescription>{t(($) => $.meeting_preparation.reauthorize_hint)}</DialogDescription></DialogHeader>
    <div className="min-h-0 space-y-3 overflow-y-auto overscroll-contain"><p className="line-clamp-3 break-words text-body font-medium" title={effect.label}>{effect.label}</p>
      {snapshot.isPending ? <Spinner /> : snapshot.isError || !preview ? <CockpitFlowError onRetry={() => void refreshPreview()} /> : <>
        <CockpitPreparationImpactComparison wsId={wsId} previous={preview.previous_authorization.impact} current={preview.current_impact} previousRun={preview.previous_authorization.selected_run} currentRun={preview.current_run} previousScope={preview.previous_authorization.scope} currentScope={preview.current_scope} />
        <CockpitPreparationReasons codes={preview.blocked_reasons} targets={preview.targets} />
        <label className="flex items-start gap-2 text-caption"><input type="checkbox" checked={confirmed} disabled={busy || Boolean(original) || reviewRequired || !permitted || !preview.can_confirm || Boolean(changed)} onChange={(event) => setConfirmed(event.target.checked)} />{t(($) => $.meeting_preparation.confirm_reauthorization)}</label>
        {changed && <p role="alert" className="text-caption">{t(($) => $.meeting_preparation.changed)}</p>}
        <Button size="sm" variant="outline" disabled={busy || Boolean(original)} onClick={() => void refreshPreview()}>{t(($) => $.meeting_lifecycle.refresh)}</Button>
      </>}
      <label className="block space-y-1 text-caption">{t(($) => $.meeting_lifecycle.reason)}<Textarea className="max-h-48 resize-y overflow-y-auto" value={value.reason} disabled={busy || Boolean(original)} onChange={(event) => setCockpitPreparationForm(draftKey, { ...value, reason: event.target.value })} /></label>
      {original && <div className="space-y-2 text-caption"><p>{t(($) => $.meeting_lifecycle.pending_hint)}</p><Button variant="outline" size="sm" disabled={request.busy} onClick={() => void verify()}>{t(($) => $.meeting_lifecycle.check_command)}</Button></div>}
      {reviewRequired && <p role="alert" className="text-caption">{t(($) => $.meeting_preparation.review_again_required)}</p>}
      {showError && request.error && <p role="alert" className="break-words text-caption text-destructive">{request.error}</p>}
    </div>
    <DialogFooter><DialogClose render={<Button variant="outline" disabled={request.busy} />}>{t(($) => $.task_create.cancel)}</DialogClose><Button disabled={busy || !permitted || Boolean(original) && !request.canRetry || !original && (!confirmed || !preview?.can_confirm || Boolean(changed) || snapshot.isError || !value.reason.trim())} onClick={() => void save()}>{request.busy && <Spinner />}{original ? t(($) => $.meeting_lifecycle.retry_command) : t(($) => $.meeting_preparation.confirm_current_impact)}</Button></DialogFooter>
  </DialogContent>;
}

export function CockpitPreparationImpactComparison({ wsId, previous, current, previousRun, currentRun, previousScope, currentScope }: {
  wsId: string; previous: CockpitDispositionIssue | null; current: CockpitDispositionIssue | null;
  previousRun?: CockpitDispositionRun | null; currentRun?: CockpitDispositionRun | null; previousScope?: CockpitPreparationResolvedScope | null; currentScope?: CockpitPreparationResolvedScope | null;
}) {
  const { t } = useT("cockpit"); const status = useStatusLabel(wsId); const paths = useWorkspacePaths(); const runStatus = usePreparationRunStatusLabel();
  if (!previous && !current && !previousRun && !currentRun && !previousScope && !currentScope) return <p className="text-caption text-muted-foreground">{t(($) => $.meeting_preparation.fixed_intent)}</p>;
  return <div className="grid gap-3 sm:grid-cols-2">{([{ key: "before", value: previous, run: previousRun, scope: previousScope }, { key: "after", value: current, run: currentRun, scope: currentScope }] as const).map(({ key, value, run, scope }) => <section key={key} className="space-y-2 rounded-md border border-border p-3 text-caption"><h3 className="font-medium">{t(($) => $.meeting_lifecycle[key])}</h3>
    {value && <><p className="break-words">{value.issue.identifier} {value.issue.title}</p><p>{status(value.issue.status)} · {value.issue.assignee_name || value.issue.assignee_id || t(($) => $.workflow.unassigned)}</p><p>{t(($) => $.task_flow.due_date)}: {value.issue.due_date || t(($) => $.common.unset)}</p>
      <p>{t(($) => $.meeting_preparation.impact_counts, { ordinary: value.ordinary_wakeup_count, system: value.system_rule_count, queued: value.unstarted_wakeup_run_count })}</p>
      <p>{t(($) => $.meeting_disposition.active_runs, { count: value.active_run_count })}</p>
      {value.evaluates_parent_rules && <div className="space-y-1"><p>{t(($) => $.meeting_preparation.parent_rules)}</p>{value.parent_issue_id && <AppLink target="_blank" rel="noopener noreferrer" href={paths.issueDetail(value.parent_issue_id)} className="text-primary underline">{t(($) => $.meeting_preparation.open_parent)} {t(($) => $.action_flow.new_tab)}</AppLink>}</div>}
    </>}
    {run && <div className="space-y-1 break-words"><p>{run.agent_name || run.agent_id}</p><p>{runStatus(run.status)}</p><p className="text-muted-foreground">{t(($) => $.meeting_disposition.stop_hint)}</p><CockpitPreparationRun wsId={wsId} runId={run.id} issueId={run.issue_id} /></div>}
    {scope && <dl className="space-y-1 break-words"><div><dt className="text-muted-foreground">{t(($) => $.meeting_lifecycle.node)}</dt><dd>{scope.node_title || scope.node_id || t(($) => $.common.unset)}</dd></div><div><dt className="text-muted-foreground">{t(($) => $.binding.project)}</dt><dd>{scope.project_title || scope.project_id || t(($) => $.common.unset)}</dd></div><div><dt className="text-muted-foreground">{t(($) => $.binding.module)}</dt><dd>{scope.module_title || scope.module_id || t(($) => $.common.unset)}</dd></div></dl>}
    {!value && !run && !scope && <p>{t(($) => $.common.unset)}</p>}
  </section>)}</div>;
}

export function CockpitPreparationAuthorizationRecord({ wsId, meetingId, commandKey }: { wsId: string; meetingId: string; commandKey: string }) {
  const { t } = useT("cockpit"); const locale = useLocale(); const [open, setOpen] = useState(false);
  const query = useQuery({ ...cockpitLifecycleCommandOptions(wsId, meetingId, commandKey), enabled: open }); const detail = query.data;
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger render={<Button variant="outline" size="sm" />}>{t(($) => $.meeting_preparation.latest_authorization)}</DialogTrigger>
    <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{t(($) => $.meeting_preparation.latest_authorization)}</DialogTitle></DialogHeader>
      {query.isPending ? <Spinner /> : query.isError || !detail ? <CockpitFlowError onRetry={() => void query.refetch()} /> : <>
        <p className="text-caption text-muted-foreground">{detail.actor_name || detail.actor_id} · {new Date(detail.created_at).toLocaleString(locale)}</p>
        {detail.receipt.preparation && <AuthorizationRecordBody wsId={wsId} before={detail.receipt.preparation.previous_authorization} after={detail.receipt.preparation.authorization} />}
        <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-caption">{detail.receipt.reason}</p>
      </>}
    </DialogContent>
  </Dialog>;
}
function AuthorizationRecordBody({ wsId, before, after }: { wsId: string; before: CockpitPreparationAuthorization | null; after: CockpitPreparationAuthorization | null }) {
  return <CockpitPreparationImpactComparison wsId={wsId} previous={before?.impact ?? null} current={after?.impact ?? null} previousRun={before?.selected_run} currentRun={after?.selected_run} previousScope={before?.scope} currentScope={after?.scope} />;
}
