"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cockpitMeetingTemplateVersionOptions, cockpitMeetingLifecycleOptions, cockpitLifecycleCommandOptions,
  usePreviewCockpitTemplateApplication, useApplyCockpitMeetingTemplate, cockpitPreparationCommandAcknowledged,
  cockpitExistingPreparationOperation, invalidateCockpitMeetingPreparationFacts,
  cockpitMeetingPreparationDraftKey, useCockpitMeetingPreparationDraftStore, setCockpitPreparationForm, clearCockpitPreparationForm,
  parseCockpitTemplateEditorDraft, rememberCockpitPreparationInstance, type CockpitTemplateApplicationDraft,
} from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@multica/ui/components/ui/dialog";
import { useT } from "../../i18n";
import { CockpitFlowError } from "./cockpit-task-flow";
import { CockpitMeetingTemplateBrowser } from "./cockpit-meeting-templates";
import { CockpitMeetingTemplateBindings, emptyMeetingTemplateBinding } from "./cockpit-meeting-template-bindings";
import { CockpitPreparationPreview } from "./cockpit-preparation-preview";
import { useCockpitPreparationRequest, useCockpitPreparationConfirmation } from "./use-cockpit-preparation-request";

export function CockpitMeetingTemplateApplication({ wsId, meetingId, resourcesHref, disabled, onCreated }: {
  wsId: string; meetingId: string; resourcesHref: string; disabled: boolean; onCreated: (operationId: string, autoStart: boolean) => void;
}) {
  const { t } = useT("cockpit"); const [open, setOpen] = useState(false); const busy = useRef(false);
  const key = cockpitMeetingPreparationDraftKey(wsId, "application", meetingId);
  const form = useCockpitMeetingPreparationDraftStore((state) => state.draft.forms[key]);
  const pending = useCockpitMeetingPreparationDraftStore((state) => state.draft.commands[key]);
  return <Dialog open={open} onOpenChange={(next) => { if (next || !busy.current) setOpen(next); }}><DialogTrigger render={<Button size="sm" variant="outline" disabled={disabled && !form && !pending} />}>{form || pending ? t(($) => $.meeting_templates.resume_application) : t(($) => $.meeting_templates.use)}</DialogTrigger>
    {open && <DialogContent className="flex max-h-[88dvh] flex-col overflow-hidden sm:max-w-3xl"><DialogHeader><DialogTitle>{t(($) => $.meeting_templates.use)}</DialogTitle></DialogHeader><div className="min-h-0 overflow-y-auto overscroll-contain">
      <ApplicationForm key={`${wsId}:${meetingId}`} wsId={wsId} meetingId={meetingId} resourcesHref={resourcesHref} disabled={disabled} onBusy={(value) => { busy.current = value; }} onCreated={(id, autoStart) => { setOpen(false); onCreated(id, autoStart); }} />
    </div></DialogContent>}
  </Dialog>;
}

function ApplicationForm({ wsId, meetingId, resourcesHref, disabled, onBusy, onCreated }: {
  wsId: string; meetingId: string; resourcesHref: string; disabled: boolean; onBusy: (value: boolean) => void; onCreated: (id: string, autoStart: boolean) => void;
}) {
  const { t } = useT("cockpit"); const client = useQueryClient(); const key = cockpitMeetingPreparationDraftKey(wsId, "application", meetingId);
  const stored = useCockpitMeetingPreparationDraftStore((state) => state.draft.forms[key]); const value = stored?.kind === "application" ? stored : null;
  const request = useCockpitPreparationRequest(key); const pending = request.pending?.kind === "application" ? request.pending : null;
  const [choosing, setChoosing] = useState(!value && !pending); const [stage, setStage] = useState<"inputs" | "preview">("inputs");
  const { confirmed, setConfirmed, reviewRequired, previewAccepted, showError } = useCockpitPreparationConfirmation(request.cause);
  const [previewError, setPreviewError] = useState(""); const previewLock = useRef(false);
  const preview = usePreviewCockpitTemplateApplication(wsId, meetingId); const apply = useApplyCockpitMeetingTemplate(wsId, meetingId);
  const lifecycle = useQuery(cockpitMeetingLifecycleOptions(wsId, meetingId));
  const version = useQuery({ ...cockpitMeetingTemplateVersionOptions(wsId, value?.templateId ?? "", value?.template_version_id ?? ""), enabled: Boolean(value) });
  const config = version.data ? parseCockpitTemplateEditorDraft({ kind: "template", observedRevision: 0, title: version.data.title, description: version.data.description, active: version.data.active, config: version.data.config })?.config : null;
  const busy = request.busy || preview.isPending;
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  const change = (next: CockpitTemplateApplicationDraft) => { setCockpitPreparationForm(key, next); preview.reset(); setConfirmed(false); };
  const makePreview = async () => {
    if (!value || disabled || pending || previewLock.current || !config) return;
    previewLock.current = true; setPreviewError(""); setConfirmed(false);
    try { const result = await preview.mutateAsync({ template_version_id: value.template_version_id, bindings: value.bindings }); if (!result) throw new Error(t(($) => $.errors.load_failed)); setStage("preview"); previewAccepted(); }
    catch (cause) { setPreviewError(cause instanceof Error ? cause.message : String(cause)); }
    finally { previewLock.current = false; }
  };
  const save = async () => {
    if (busy || !value || pending && (!request.canRetry || disabled) || !pending && (disabled || lifecycle.isError || !confirmed || !preview.data?.can_confirm || preview.data.lifecycle_revision !== lifecycle.data?.lifecycle_revision)) return;
    const proposal = preview.data;
    const response = await request.run(pending ?? { kind: "application", meetingId, body: { command_key: crypto.randomUUID(), expected_revision: proposal!.lifecycle_revision,
      template_version_id: value.template_version_id, bindings: value.bindings, context_token: proposal!.context_token } }, async (command) => {
      if (command.kind !== "application") throw new Error("meeting_preparation_command_scope_changed"); return apply.mutateAsync(command.body);
    });
    if (response) { clearCockpitPreparationForm(key, value); if (response.stillCurrent()) { rememberCockpitPreparationInstance(key, response.result.receipt.operation_id); onCreated(response.result.receipt.operation_id, true); } }
  };
  const verify = async () => {
    const response = await request.verify(async (command) => {
      if (command.kind !== "application") throw new Error("meeting_preparation_command_scope_changed");
      const detail = await client.fetchQuery({ ...cockpitLifecycleCommandOptions(wsId, meetingId, command.body.command_key), staleTime: 0 });
      if (!detail || !cockpitPreparationCommandAcknowledged(detail, "template_apply", command.body) || !detail.receipt.preparation) throw new Error(t(($) => $.meeting_templates.unconfirmed));
      await invalidateCockpitMeetingPreparationFacts(client, wsId, meetingId, detail.receipt.preparation.operation_id);
      return detail.receipt.preparation;
    });
    if (response) { if (value) clearCockpitPreparationForm(key, value); if (response.stillCurrent()) { rememberCockpitPreparationInstance(key, response.result.operation_id); onCreated(response.result.operation_id, false); } }
  };
  const observed = request.observedCommand?.kind === "application" ? request.observedCommand : null;
  const existingOperation = observed ? cockpitExistingPreparationOperation(request.cause, { workspaceId: wsId, meetingId, templateVersionId: observed.body.template_version_id, commandKey: observed.body.command_key }) : null;
  if (choosing && !pending) return <CockpitMeetingTemplateBrowser wsId={wsId} readOnly={disabled} onBusy={onBusy} onSelect={(template, selected) => {
    change({ kind: "application", templateId: template.id, template_version_id: selected.id, bindings: selected.config.slots.map((slot) => emptyMeetingTemplateBinding(slot.slot_id)) }); setChoosing(false); setStage("inputs");
  }} />;
  return <section className="space-y-3">
    {pending ? <div className="space-y-2 text-caption"><p>{t(($) => $.meeting_lifecycle.pending_hint)}</p><Button size="sm" variant="outline" disabled={busy} onClick={() => void verify()}>{t(($) => $.meeting_lifecycle.check_command)}</Button></div>
      : <Button size="sm" variant="outline" disabled={busy} onClick={() => setChoosing(true)}>{t(($) => $.meeting_templates.change_template)}</Button>}
    {version.isPending && value ? <Spinner /> : version.isError || value && !version.data ? <CockpitFlowError onRetry={() => void version.refetch()} /> : version.data && <>
      <h3 className="line-clamp-3 break-words text-title-sm font-medium" title={version.data.title}>{version.data.title}</h3><p className="text-caption text-muted-foreground">{t(($) => $.workflow.version, { number: version.data.number })}</p>
      {!config ? <p className="text-caption">{t(($) => $.meeting_templates.unsupported)}</p> : stage === "inputs" && value ? <>
        <CockpitMeetingTemplateBindings wsId={wsId} meetingId={meetingId} config={config} value={value.bindings} onChange={(bindings) => change({ ...value, bindings })} disabled={busy || Boolean(pending) || disabled} resourcesHref={resourcesHref} />
        <Button disabled={busy || Boolean(pending) || disabled || !value.bindings.some((binding) => binding.selected)} onClick={() => void makePreview()}>{t(($) => $.meeting_templates.preview)}</Button>
      </> : preview.data && <>
        <CockpitPreparationPreview slots={config?.slots} effects={preview.data.effects} selectedTotal={preview.data.selected_total} blockedReasons={preview.data.blocked_reasons} />
        <label className="flex items-start gap-2 text-caption"><input type="checkbox" checked={confirmed} disabled={busy || Boolean(pending) || reviewRequired || !preview.data.can_confirm} onChange={(event) => setConfirmed(event.target.checked)} />{t(($) => $.meeting_templates.confirm_effects)}</label>
        {preview.data.lifecycle_revision !== lifecycle.data?.lifecycle_revision && <p role="alert" className="text-caption">{t(($) => $.meeting_templates.preview_changed)}</p>}
        <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy || Boolean(pending)} onClick={() => { setStage("inputs"); setConfirmed(false); preview.reset(); }}>{t(($) => $.meeting_templates.edit_choices)}</Button><Button variant="outline" disabled={busy || Boolean(pending)} onClick={() => void makePreview()}>{t(($) => $.meeting_templates.preview_again)}</Button>
          <Button disabled={busy || Boolean(pending) || disabled || lifecycle.isError || !confirmed || !preview.data.can_confirm || preview.data.lifecycle_revision !== lifecycle.data?.lifecycle_revision} onClick={() => void save()}>{t(($) => $.meeting_templates.apply)}</Button></div>
      </>}
    </>}
    {pending && <Button disabled={busy || disabled || !request.canRetry} onClick={() => void save()}>{t(($) => $.meeting_lifecycle.retry_command)}</Button>}
    {lifecycle.isError && <CockpitFlowError onRetry={() => void lifecycle.refetch()} />}
    {existingOperation && <Button size="sm" variant="outline" onClick={() => onCreated(existingOperation, false)}>{t(($) => $.meeting_templates.open_existing)}</Button>}
    {reviewRequired && <p role="alert" className="text-caption">{t(($) => $.meeting_preparation.review_again_required)}</p>}
    {((showError && request.error) || previewError) && <p role="alert" className="break-words text-caption text-destructive">{(showError && request.error) || previewError}</p>}
  </section>;
}
