"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useControlCockpitPreparationOperation, cockpitLifecycleCommandOptions, cockpitPreparationCommandAcknowledged,
  cockpitMeetingPreparationDraftKey, useCockpitMeetingPreparationDraftStore, setCockpitPreparationForm, clearCockpitPreparationForm,
  invalidateCockpitMeetingPreparationFacts, type CockpitPreparationFormDraft,
} from "@multica/core/cockpit";
import type { CockpitPreparationEffect, CockpitPreparationOperationHeader, CockpitPreparationControlTransition } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@multica/ui/components/ui/dialog";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useT } from "../../i18n";
import { useCockpitPreparationRequest } from "./use-cockpit-preparation-request";

export function CockpitPreparationControl({ wsId, header, effect, disabled, onResumed }: {
  wsId: string; header: CockpitPreparationOperationHeader; effect?: CockpitPreparationEffect; disabled?: boolean; onResumed?: () => void;
}) {
  const { t } = useT("cockpit"); const [transition, setTransition] = useState<CockpitPreparationControlTransition | null>(null); const busy = useRef(false);
  const commands = useCockpitMeetingPreparationDraftStore((state) => state.draft.commands);
  const keyFor = (transition: CockpitPreparationControlTransition) => cockpitMeetingPreparationDraftKey(wsId, "control", header.meeting_id, header.id, transition, effect?.id ?? "");
  const choices: CockpitPreparationControlTransition[] = effect ? ["skip"] : ["pause", "resume", "claim"];
  const allowed = (choice: CockpitPreparationControlTransition) => !disabled && (choice === "skip" ? effect?.can_skip && (effect.state === "pending" || effect.state === "needs_attention")
    : choice === "pause" ? header.can_pause && header.state === "active"
      : choice === "resume" ? header.can_resume && (header.state === "paused" || header.state === "needs_attention") : header.can_claim && header.state !== "completed");
  return <Dialog open={transition !== null} onOpenChange={(open) => { if (!open && !busy.current) setTransition(null); }}>
    {choices.filter((choice) => allowed(choice) || commands[keyFor(choice)]).map((choice) => <DialogTrigger key={choice} render={<Button type="button" variant="outline" size="sm" disabled={Boolean(disabled) && !commands[keyFor(choice)]} />} onClick={() => setTransition(choice)}>{t(($) => $.meeting_preparation[choice])}</DialogTrigger>)}
    {transition && <ControlForm key={keyFor(transition)} wsId={wsId} header={header} effect={effect} transition={transition} draftKey={keyFor(transition)} permitted={Boolean(allowed(transition))} onBusy={(value) => { busy.current = value; }} onDone={(resume) => { setTransition(null); if (resume) onResumed?.(); }} />}
  </Dialog>;
}

function ControlForm({ wsId, header, effect, transition, draftKey, permitted, onBusy, onDone }: {
  wsId: string; header: CockpitPreparationOperationHeader; effect?: CockpitPreparationEffect; transition: CockpitPreparationControlTransition;
  draftKey: string; permitted: boolean; onBusy: (busy: boolean) => void; onDone: (resume: boolean) => void;
}) {
  const { t } = useT("cockpit"); const client = useQueryClient(); const request = useCockpitPreparationRequest(draftKey);
  const mutation = useControlCockpitPreparationOperation(wsId, header.meeting_id, header.id); const original = request.pending?.kind === "control" ? request.pending : null;
  const [initial] = useState<Extract<CockpitPreparationFormDraft, { kind: "control" }>>(() => ({ kind: "control", observedRevision: original?.body.expected_revision ?? header.revision,
    transition, effectId: effect?.id ?? null, reason: original?.body.reason ?? "" }));
  const stored = useCockpitMeetingPreparationDraftStore((state) => state.draft.forms[draftKey]); const value = stored?.kind === "control" ? stored : initial;
  const changed = value.observedRevision !== header.revision;
  useEffect(() => { onBusy(request.busy); return () => onBusy(false); }, [request.busy, onBusy]);
  const save = async () => {
    if (request.busy || !permitted || original && !request.canRetry || !original && (!value.reason.trim() || changed)) return;
    setCockpitPreparationForm(draftKey, value);
    const result = await request.run(original ?? { kind: "control", meetingId: header.meeting_id, operationId: header.id,
      body: { command_key: crypto.randomUUID(), expected_revision: value.observedRevision, transition: value.transition, effect_id: value.effectId, reason: value.reason.trim() } }, async (command) => {
      if (command.kind !== "control") throw new Error(t(($) => $.meeting_templates.unconfirmed)); return mutation.mutateAsync(command.body);
    });
    if (result) { clearCockpitPreparationForm(draftKey, value); if (result.stillCurrent()) onDone(transition === "resume"); }
  };
  const verify = async () => {
    const result = await request.verify(async (command) => {
      if (command.kind !== "control") throw new Error(t(($) => $.meeting_templates.unconfirmed));
      const detail = await client.fetchQuery({ ...cockpitLifecycleCommandOptions(wsId, header.meeting_id, command.body.command_key), staleTime: 0 });
      if (!detail || !cockpitPreparationCommandAcknowledged(detail, `preparation_${command.body.transition}`, command.body, header.id)) throw new Error(t(($) => $.meeting_templates.unconfirmed));
      await invalidateCockpitMeetingPreparationFacts(client, wsId, header.meeting_id, header.id); return detail;
    });
    if (result) { clearCockpitPreparationForm(draftKey, value); if (result.stillCurrent()) onDone(false); }
  };
  return <DialogContent className="max-h-[85dvh] overflow-y-auto"><DialogHeader><DialogTitle>{t(($) => $.meeting_preparation[transition])}</DialogTitle><DialogDescription>{t(($) => $.meeting_preparation[`${transition}_hint`])}</DialogDescription></DialogHeader>
    {effect && <p className="line-clamp-3 break-words text-caption" title={effect.label}>{effect.label}</p>}
    <label className="block space-y-1 text-caption">{t(($) => $.meeting_lifecycle.reason)}<Textarea value={value.reason} className="max-h-56 resize-y overflow-y-auto" disabled={request.busy || Boolean(original)} onChange={(event) => setCockpitPreparationForm(draftKey, { ...value, reason: event.target.value })} /></label>
    {changed && !original && <div role="alert" className="space-y-2 text-caption"><p>{t(($) => $.meeting_preparation.changed)}</p><Button size="sm" variant="outline" disabled={!permitted} onClick={() => setCockpitPreparationForm(draftKey, { ...value, observedRevision: header.revision })}>{t(($) => $.meeting_lifecycle.rebase)}</Button></div>}
    {original && <div className="space-y-2 text-caption"><p>{t(($) => $.meeting_lifecycle.pending_hint)}</p><Button size="sm" variant="outline" disabled={request.busy} onClick={() => void verify()}>{t(($) => $.meeting_lifecycle.check_command)}</Button></div>}
    {request.error && <p role="alert" className="break-words text-caption text-destructive">{request.error}</p>}
    <DialogFooter><DialogClose render={<Button variant="outline" disabled={request.busy} />}>{t(($) => $.task_create.cancel)}</DialogClose><Button disabled={request.busy || !permitted || Boolean(original) && !request.canRetry || !original && (!value.reason.trim() || changed)} onClick={() => void save()}>{request.busy && <Spinner />}{original ? t(($) => $.meeting_lifecycle.retry_command) : t(($) => $.meeting_lifecycle.confirm)}</Button></DialogFooter>
  </DialogContent>;
}
