"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  usePreviewCockpitMeetingCancellation, useCancelCockpitMeeting, useAppendCockpitMeetingDisposition, cockpitLifecycleCommandOptions, cockpitPreparationCommandAcknowledged,
  cockpitMeetingPreparationDraftKey, useCockpitMeetingPreparationDraftStore, setCockpitPreparationForm, clearCockpitPreparationForm,
  rememberCockpitPreparationInstance, invalidateCockpitMeetingPreparationFacts, type CockpitPreparationFormDraft,
} from "@multica/core/cockpit";
import type { CockpitMeetingOperationBasis } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useT } from "../../i18n";
import { CockpitCancellationItems } from "./cockpit-meeting-cancellation-items";
import { CockpitPreparationPreview, CockpitPreparationReasons } from "./cockpit-preparation-preview";
import { CockpitMeetingPendingResponsibilities } from "./cockpit-meeting-disposition";
import { CockpitDirectoryCancellationPreview } from "./cockpit-directory-cancellation";
import { useCockpitPreparationRequest, useCockpitPreparationConfirmation } from "./use-cockpit-preparation-request";
import { createSafeId } from "@multica/core/utils";

export function CockpitMeetingCancellation({ wsId, basis, disabled, onBusy, onCreated, append = false }: {
  wsId: string; basis: CockpitMeetingOperationBasis; disabled: boolean; append?: boolean; onBusy: (busy: boolean) => void; onCreated: (operationId: string, autoStart: boolean) => void;
}) {
  const { t } = useT("cockpit"); const client = useQueryClient(); const meetingId = basis.meeting_id;
  const commandKind = append ? "append_disposition" : "cancellation";
  const key = cockpitMeetingPreparationDraftKey(wsId, commandKind, meetingId); const request = useCockpitPreparationRequest(key); const pending = request.pending?.kind === commandKind ? request.pending : null;
  const { confirmed, setConfirmed, reviewRequired, previewAccepted, showError } = useCockpitPreparationConfirmation(request.cause);
  const [initial] = useState<Extract<CockpitPreparationFormDraft, { kind: "cancellation" }>>(() => ({ kind: "cancellation", reason: pending?.body.reason ?? "", issues: pending?.body.issues ?? [], run_ids: pending?.body.run_ids ?? [] }));
  const stored = useCockpitMeetingPreparationDraftStore((state) => state.draft.forms[key]); const value = stored?.kind === "cancellation" ? stored : initial;
  const [stage, setStage] = useState<"choices" | "preview">("choices"); const [error, setError] = useState(""); const previewLock = useRef(false);
  const preview = usePreviewCockpitMeetingCancellation(wsId, meetingId); const cancel = useCancelCockpitMeeting(wsId, meetingId); const appendDisposition = useAppendCockpitMeetingDisposition(wsId, meetingId);
  const permitted = !disabled && basis.availability === "available" && basis[append ? "append_disposition" : "cancel"].state === "allowed";
  const busy = request.busy || preview.isPending; useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  const update = (next: typeof value) => { setCockpitPreparationForm(key, next); preview.reset(); setConfirmed(false); };
  const makePreview = async () => {
    if (previewLock.current || pending || !permitted || !value.reason.trim() || value.issues.length + value.run_ids.length > 50) return;
    previewLock.current = true; setError(""); setConfirmed(false);
    try { const result = await preview.mutateAsync({ reason: value.reason.trim(), issues: value.issues, run_ids: value.run_ids }); if (!result) throw new Error(t(($) => $.errors.load_failed)); setStage("preview"); previewAccepted(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { previewLock.current = false; }
  };
  const save = async () => {
    if (busy || !permitted || pending && !request.canRetry || !pending && (!confirmed || !preview.data?.can_confirm || preview.data.lifecycle_revision !== basis.lifecycle_revision)) return;
    setCockpitPreparationForm(key, value);
    const result = await request.run(pending ?? { kind: commandKind, meetingId, body: { command_key: createSafeId(), expected_revision: preview.data!.lifecycle_revision,
      context_token: preview.data!.context_token, reason: value.reason.trim(), issues: value.issues, run_ids: value.run_ids } }, async (command) => {
      if (command.kind !== "cancellation" && command.kind !== "append_disposition") throw new Error(t(($) => $.meeting_preparation.check_first)); return command.kind === "append_disposition" ? appendDisposition.mutateAsync(command.body) : cancel.mutateAsync(command.body);
    });
    if (result) { clearCockpitPreparationForm(key, value); if (result.stillCurrent()) { rememberCockpitPreparationInstance(key, result.result.receipt.operation_id); onCreated(result.result.receipt.operation_id, true); } }
  };
  const verify = async () => {
    const result = await request.verify(async (command) => {
      if (command.kind !== "cancellation" && command.kind !== "append_disposition") throw new Error(t(($) => $.meeting_preparation.check_first));
      const detail = await client.fetchQuery({ ...cockpitLifecycleCommandOptions(wsId, meetingId, command.body.command_key), staleTime: 0 });
      if (!detail || !cockpitPreparationCommandAcknowledged(detail, command.kind === "append_disposition" ? "preparation_dispose" : "cancel", command.body) || !detail.receipt.preparation) throw new Error(t(($) => $.meeting_preparation.check_first));
      await invalidateCockpitMeetingPreparationFacts(client, wsId, meetingId, detail.receipt.preparation.operation_id); return detail.receipt.preparation;
    });
    if (result) { clearCockpitPreparationForm(key, value); if (result.stillCurrent()) { rememberCockpitPreparationInstance(key, result.result.operation_id); onCreated(result.result.operation_id, false); } }
  };
  return <section className="space-y-3"><p className="text-caption text-muted-foreground">{append ? t(($) => $.meeting_disposition.append_hint) : t(($) => $.meeting_disposition.cancel_hint)}</p>
    <label className="block space-y-1 text-caption">{t(($) => $.meeting_lifecycle.reason)}<Textarea className="max-h-40 resize-y overflow-y-auto" value={value.reason} disabled={busy || Boolean(pending) || stage === "preview"} onChange={(event) => update({ ...value, reason: event.target.value })} /></label>
    {!permitted && <CockpitPreparationReasons codes={basis[append ? "append_disposition" : "cancel"].reason_codes} targets={basis.targets} />}
    {pending && <div className="space-y-2 text-caption"><p>{t(($) => $.meeting_lifecycle.pending_hint)}</p><Button size="sm" variant="outline" disabled={busy} onClick={() => void verify()}>{t(($) => $.meeting_lifecycle.check_command)}</Button></div>}
    {stage === "choices" ? <><CockpitCancellationItems wsId={wsId} meetingId={meetingId} value={value} onChange={update} disabled={busy || Boolean(pending)} />
      <Button disabled={busy || Boolean(pending) || !permitted || !value.reason.trim() || value.issues.length + value.run_ids.length > 50} onClick={() => void makePreview()}>{append ? t(($) => $.meeting_disposition.append_preview) : t(($) => $.meeting_disposition.preview)}</Button></> : preview.data && <>
      <CockpitPreparationPreview effects={preview.data.effects} selectedTotal={preview.data.selected_total} blockedReasons={preview.data.blocked_reasons} />
      {!append && preview.data.directory_impact && <CockpitDirectoryCancellationPreview meetingId={meetingId} value={preview.data.directory_impact} />}
      <div className="space-y-1 rounded-lg border border-border p-3 text-caption"><p>{t(($) => $.meeting_disposition.kept_issues, { count: preview.data.unselected_issue_total })}</p><p>{t(($) => $.meeting_disposition.kept_runs, { count: preview.data.unselected_run_total })}</p></div>
      <CockpitMeetingPendingResponsibilities basis={basis} />
      <label className="flex items-start gap-2 text-caption"><input type="checkbox" checked={confirmed} disabled={busy || Boolean(pending) || reviewRequired || !preview.data.can_confirm} onChange={(event) => setConfirmed(event.target.checked)} />{append ? t(($) => $.meeting_disposition.confirm_append) : t(($) => $.meeting_disposition.confirm_cancel)}</label>
      {preview.data.lifecycle_revision !== basis.lifecycle_revision && <p role="alert" className="text-caption">{t(($) => $.meeting_preparation.reason_context)}</p>}
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy || Boolean(pending)} onClick={() => { setStage("choices"); setConfirmed(false); preview.reset(); }}>{t(($) => $.meeting_disposition.back_actions)}</Button><Button variant="outline" disabled={busy || Boolean(pending) || !permitted} onClick={() => void makePreview()}>{t(($) => $.meeting_lifecycle.refresh)}</Button>
        <Button variant="destructive" disabled={busy || Boolean(pending) || !permitted || !confirmed || !preview.data.can_confirm || preview.data.lifecycle_revision !== basis.lifecycle_revision} onClick={() => void save()}>{append ? t(($) => $.meeting_disposition.append_disposition) : t(($) => $.meeting_disposition.cancel)}</Button></div>
    </>}
    {pending && <Button disabled={busy || !permitted || !request.canRetry} onClick={() => void save()}>{request.busy && <Spinner />}{t(($) => $.meeting_lifecycle.retry_command)}</Button>}
    {reviewRequired && <p role="alert" className="text-caption">{t(($) => $.meeting_preparation.review_again_required)}</p>}
    {((showError && request.error) || error) && <p role="alert" className="break-words text-caption text-destructive">{(showError && request.error) || error}</p>}
  </section>;
}
