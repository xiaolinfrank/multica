"use client";

import { useEffect, useRef, useState } from "react";
import { errorCode } from "@multica/core/api";
import {
  cockpitMeetingDirectoryDraftKey, useCockpitMeetingDirectoryDraftStore, setCockpitDirectoryForm, clearCockpitDirectoryForm,
  usePreviewCockpitDirectoryRetry, type CockpitDirectoryFormDraft,
} from "@multica/core/cockpit";
import type { CockpitDirectoryOperationHeader, CockpitDirectoryStepMetadata } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@multica/ui/components/ui/dialog";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useT } from "../../i18n";
import { CockpitDirectoryPreviewView, CockpitDirectoryReasons, knownDirectoryStates, supportsDirectoryPreview, retryableDirectoryStep } from "./cockpit-directory-parts";
import { useCockpitDirectoryCommand } from "./use-cockpit-directory-command";
import { useCockpitPreparationConfirmation } from "./use-cockpit-preparation-request";

export function CockpitDirectoryRetry({ wsId, header, steps, readOnly, onDone }: {
  wsId: string; header: CockpitDirectoryOperationHeader; steps: CockpitDirectoryStepMetadata[]; readOnly?: boolean; onDone: () => void;
}) {
  const { t } = useT("cockpit"); const [open, setOpen] = useState(false); const key = cockpitMeetingDirectoryDraftKey(wsId, header.meeting_id, "retry", header.id);
  const request = useCockpitDirectoryCommand(wsId, header.meeting_id, key, header.id); const original = request.pending?.kind === "retry" ? request.pending : null;
  const stored = useCockpitMeetingDirectoryDraftStore((state) => state.draft.forms[key]);
  const value: Extract<CockpitDirectoryFormDraft, { kind: "retry" }> = stored?.kind === "retry" ? stored : { kind: "retry", stepIds: original?.body.step_ids ?? [], reason: original?.body.reason ?? "", observedRevision: original?.body.expected_revision ?? header.revision };
  const preview = usePreviewCockpitDirectoryRetry(wsId, header.meeting_id, header.id); const lock = useRef(false); const [error, setError] = useState("");
  const { confirmed, setConfirmed, reviewRequired, previewAccepted, showError } = useCockpitPreparationConfirmation(request.cause);
  const permitted = !readOnly && knownDirectoryStates.has(header.state) && !["completed", "abandoned"].includes(header.state) && header.can_retry;
  const invalid = value.stepIds.length === 0 || value.stepIds.some((id) => !steps.some((step) => step.id === id && retryableDirectoryStep(step)));
  const base = steps.find((step) => step.kind === "base" && retryableDirectoryStep(step));
  const needsBase = [...header.blocked_reasons, ...(preview.data?.blocked_reasons ?? []), errorCode(preview.error)].includes("base_reauthorization_required");
  const previewButton = useRef<HTMLButtonElement>(null); const [focusPreview, setFocusPreview] = useState(false);
  useEffect(() => { if (focusPreview) { previewButton.current?.focus(); setFocusPreview(false); } }, [focusPreview]);
  const changed = Boolean(preview.data && preview.data.operation_revision !== header.revision);
  const busy = request.busy || preview.isPending;
  const makePreview = async () => {
    if (lock.current || busy || original || !permitted || invalid) return;
    lock.current = true; setError(""); setConfirmed(false); setCockpitDirectoryForm(key, value);
    try { const result = await preview.mutateAsync({ step_ids: value.stepIds }); if (!result) throw new Error(t(($) => $.errors.load_failed)); previewAccepted(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { lock.current = false; }
  };
  const save = async () => {
    if (request.busy || !permitted || original && !request.canRetry || !original && (!confirmed || changed || invalid || !preview.data?.can_confirm || !supportsDirectoryPreview(preview.data.steps)) || new TextEncoder().encode(value.reason.trim()).length > 16000) return;
    setCockpitDirectoryForm(key, value);
    const response = await request.run(original ?? { kind: "retry", meetingId: header.meeting_id, operationId: header.id,
      body: { command_key: crypto.randomUUID(), expected_revision: preview.data!.operation_revision, context_token: preview.data!.context_token, step_ids: value.stepIds, reason: value.reason.trim() } });
    if (response) { clearCockpitDirectoryForm(key, value); if (response.stillCurrent()) { setOpen(false); onDone(); } }
  };
  const verify = async () => { const response = await request.verify(); if (response) { clearCockpitDirectoryForm(key, value); if (response.stillCurrent()) { setOpen(false); onDone(); } } };
  return <Dialog open={open} onOpenChange={(next) => { if (!request.busy) { if (next) { setConfirmed(false); preview.reset(); setError(""); } setOpen(next); } }}><DialogTrigger render={<Button size="sm" variant="outline" disabled={!original && (!permitted || invalid)} />}>{t(($) => $.meeting_directory.retry_selected, { count: value.stepIds.length })}</DialogTrigger>
    <DialogContent className="flex max-h-[88dvh] flex-col overflow-hidden sm:max-w-2xl"><DialogHeader><DialogTitle>{t(($) => $.meeting_directory.retry)}</DialogTitle></DialogHeader>
      <div className="min-h-0 space-y-3 overflow-y-auto overscroll-contain"><p className="text-caption text-muted-foreground">{t(($) => $.meeting_directory.retry_hint)}</p>
        {!permitted && <CockpitDirectoryReasons codes={header.blocked_reasons} />}
        <ol className="max-h-40 list-inside list-decimal overflow-y-auto text-caption">{value.stepIds.map((id) => <li key={id} className="break-words">{steps.find((step) => step.id === id)?.label ?? id}</li>)}</ol>
        {invalid && !original && <p role="alert" className="text-caption">{t(($) => $.meeting_directory.selection_changed)}</p>}
        {needsBase && !original && <div className="space-y-2 text-caption"><p>{t(($) => $.meeting_directory.base_reauthorization_required)}</p>{base && !value.stepIds.includes(base.id) && <Button variant="outline" size="sm" disabled={busy || !permitted} onClick={() => { setCockpitDirectoryForm(key, { ...value, stepIds: [...value.stepIds, base.id], observedRevision: header.revision }); preview.reset(); setConfirmed(false); setError(""); setFocusPreview(true); }}>{t(($) => $.meeting_directory.select_base)}</Button>}</div>}
        <label className="block space-y-1 text-caption">{t(($) => $.meeting_directory.optional_reason)}<Textarea className="max-h-40 resize-y overflow-y-auto" disabled={busy || Boolean(original)} value={value.reason} onChange={(event) => setCockpitDirectoryForm(key, { ...value, reason: event.target.value })} /></label>
        {new TextEncoder().encode(value.reason.trim()).length > 16000 && <p role="alert" className="text-caption text-destructive">{t(($) => $.meeting_directory.reason_limit)}</p>}
        {original ? <div className="space-y-2 text-caption"><p>{t(($) => $.meeting_lifecycle.pending_hint)}</p><Button variant="outline" size="sm" disabled={request.busy} onClick={() => void verify()}>{t(($) => $.meeting_lifecycle.check_command)}</Button></div> : <>
          <Button ref={previewButton} size="sm" variant="outline" disabled={busy || !permitted || invalid} onClick={() => void makePreview()}>{preview.isPending && <Spinner />}{t(($) => $.meeting_templates.preview_again)}</Button>
          {preview.data && <><CockpitDirectoryPreviewView value={preview.data} /><label className="flex items-start gap-2 text-caption"><input type="checkbox" checked={confirmed} disabled={busy || reviewRequired || invalid || changed || !preview.data.can_confirm || !supportsDirectoryPreview(preview.data.steps)} onChange={(event) => setConfirmed(event.target.checked)} />{t(($) => $.meeting_directory.confirm_retry)}</label></>}
        </>}
        {(changed || reviewRequired) && <p role="alert" className="text-caption">{t(($) => $.meeting_preparation.review_again_required)}</p>}
        {(error || showError && request.error) && <p role="alert" className="break-words text-caption text-destructive">{error || (request.error.startsWith("directory_command_") ? t(($) => $.task_flow.unconfirmed) : request.error)}</p>}
      </div>
      <DialogFooter><DialogClose render={<Button variant="outline" disabled={request.busy} />}>{t(($) => $.task_create.cancel)}</DialogClose><Button disabled={busy || !permitted || Boolean(original) && !request.canRetry || !original && (!confirmed || changed || invalid || !preview.data?.can_confirm || !supportsDirectoryPreview(preview.data.steps)) || new TextEncoder().encode(value.reason.trim()).length > 16000} onClick={() => void save()}>{request.busy && <Spinner />}{original ? t(($) => $.meeting_lifecycle.retry_command) : t(($) => $.meeting_lifecycle.confirm)}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
