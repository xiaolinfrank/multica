"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { advanceCockpitInputForm, clearCockpitInputForm, cockpitInputDraftKey, emptyCockpitInputForm, setCockpitInputForm, useCockpitInputDraftStore, cockpitInputDetailOptions, cockpitInputSelectedAttachmentOptions, cockpitArtifactVersionOptions, cockpitArtifactPath, EMPTY_COCKPIT_SCOPE, type CockpitInputFormDraft } from "@multica/core/cockpit";
import type { CockpitInputCapabilities } from "@multica/core/types/cockpit-input";
import { useWorkspacePaths } from "@multica/core/paths";
import { AppLink } from "../../navigation";
import { ArtifactStatus } from "./cockpit-artifact-status";
import { CockpitSourceContextLinks } from "./cockpit-source-context-links";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { toast } from "sonner";
import { useT } from "../../i18n";
import { CockpitInputSourcePicker } from "./cockpit-input-source-picker";
import { CockpitInputCommandRecovery } from "./cockpit-input-command-recovery";
import { useCockpitInputRequest, type CockpitInputAcknowledgement } from "./use-cockpit-input-request";
import { useCockpitCommandContext } from "./use-cockpit-command-context";
import { CockpitInputEndRegistration } from "./cockpit-input-end-registration";
import { CockpitInputProblem } from "./cockpit-input-problem";
import { CockpitFlowError } from "./cockpit-task-flow";
import { createSafeId } from "@multica/core/utils";

export function CockpitInputSourceForm({ wsId, accountId, meetingId, agendaId = null, targetLabel, capabilities, canAdd, onOpenVersion, onCancel }: {
  wsId: string; accountId: string; meetingId: string; agendaId?: string | null; targetLabel: string; capabilities: CockpitInputCapabilities; canAdd: boolean;
  onOpenVersion: (inputId: string, versionId?: string) => void; onCancel: () => void;
}) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths();
  const key = cockpitInputDraftKey(wsId, accountId, "source-input", meetingId, agendaId || "");
  const initial = useRef(emptyCockpitInputForm(createSafeId(), agendaId));
  const stored = useCockpitInputDraftStore((state) => state.draft.forms[key]); const draft = stored ?? initial.current;
  const request = useCockpitInputRequest(wsId, key); const capture = useCockpitCommandContext(key);
  const [busy, setBusy] = useState(false); const lock = useRef(false); const [picking, setPicking] = useState(false);
  const currentHeader = useQuery({ ...cockpitInputDetailOptions(wsId, draft.inputId || ""), enabled: Boolean(draft.inputId) });
  const attachmentSource = draft.source?.attachment;
  const artifactSource = draft.source?.artifactVersion;
  const attachment = useQuery({ ...cockpitInputSelectedAttachmentOptions(wsId, attachmentSource?.issueId || "", attachmentSource?.attachmentId || ""), enabled: draft.source?.kind === "attachment" && Boolean(attachmentSource) });
  const artifact = useQuery({ ...cockpitArtifactVersionOptions(wsId, artifactSource?.artifactId || "", artifactSource?.versionId || ""), enabled: draft.source?.kind === "artifact_version" && Boolean(artifactSource) });
  const sourceReady = draft.source?.kind === "attachment" ? !attachment.isError && Boolean(attachment.data) && capabilities.fileCaptureAvailable
    : draft.source?.kind === "artifact_version" && !artifact.isError && artifact.data?.version.capture_status === "ready" && Boolean(artifact.data.version.content_hash);
  const changed = Boolean(draft.inputId && currentHeader.data && currentHeader.data.revision !== draft.inputRevision);
  const allowed = canAdd && capabilities.canCreate && !currentHeader.isError && (!draft.inputId || currentHeader.data?.canSubmit === true);
  const locked = busy || request.busy || Boolean(request.pending);
  const titleValid = Boolean(draft.title.trim()) && new TextEncoder().encode(draft.title.trim()).length <= 512;
  const eligible = allowed && titleValid && !changed && sourceReady && Boolean(draft.source && ["attachment", "artifact_version"].includes(draft.source.kind));
  function record(ack: CockpitInputAcknowledgement, value: CockpitInputFormDraft) {
    const result = ack.acknowledged;
    if (!ack.stillCurrent()) return null;
    const patch = result.kind === "create" ? { inputId: result.result.receipt.inputId, inputRevision: result.result.receipt.inputRevision }
      : result.kind === "version" ? { inputId: result.result.receipt.inputId, versionId: result.result.receipt.versionId, inputRevision: result.result.receipt.inputRevision } : null;
    if (!patch) return null;
    advanceCockpitInputForm(key, value.generation, patch);
    return useCockpitInputDraftStore.getState().draft.forms[key] ?? null;
  }
  function open(value: CockpitInputFormDraft) {
    if (!value.inputId || !value.versionId) return;
    clearCockpitInputForm(key, value); toast.success(t(($) => $.input_materials.registered_capture_pending)); onOpenVersion(value.inputId, value.versionId);
  }
  async function submit() {
    if (lock.current || locked || !eligible) return;
    lock.current = true; setBusy(true); const current = capture();
    let value = draft; setCockpitInputForm(key, value);
    try {
      if (!value.inputId) {
        const ack = await request.run({ kind: "create", body: { commandKey: createSafeId(), title: value.title.trim(), description: value.description, projectId: null, originIssueId: null } });
        if (!ack || !current()) return; const next = record(ack, value); if (!next) return; value = next;
        if (ack.acknowledged.kind === "create" && !ack.acknowledged.result.current) return;
      }
      if (!value.versionId && value.inputId && value.inputRevision !== null && value.source) {
        const ack = await request.run({ kind: "version", inputId: value.inputId, body: { commandKey: createSafeId(), expectedRevision: value.inputRevision, source: value.source } });
        if (!ack || !current()) return; const next = record(ack, value); if (!next) return; value = next;
      }
      if (current()) open(value);
    } finally { lock.current = false; if (current()) setBusy(false); }
  }
  async function recover(mode: "lookup" | "submit") {
    const ack = mode === "lookup" ? await request.verify() : request.pending ? await request.run(request.pending) : null;
    if (!ack) return; const next = record(ack, draft); if (next?.versionId) open(next);
  }
  return <section className="min-w-0 space-y-4"><p className="break-words rounded-lg bg-muted/50 p-3 text-caption">{targetLabel}</p>
    {!draft.source || picking ? <CockpitInputSourcePicker wsId={wsId} disabled={locked || !allowed} fileCaptureAvailable={capabilities.fileCaptureAvailable} onSelect={({ source, title }) => { setCockpitInputForm(key, { ...draft, source, title: draft.inputId ? draft.title : title }); setPicking(false); }} /> : <>
      <label className="block space-y-1 text-caption">{t(($) => $.input_materials.name)}<Input value={draft.title} disabled={locked || Boolean(draft.inputId)} maxLength={512} onChange={(event) => setCockpitInputForm(key, { ...draft, title: event.target.value })} /></label>
      <div className="space-y-2 rounded-lg bg-muted/50 p-3 text-caption"><p className="text-muted-foreground">{draft.source.kind === "attachment" ? t(($) => $.input_materials.source_attachment) : t(($) => $.input_materials.source_artifact)}</p>
        {draft.source.kind === "attachment" && (attachment.isPending ? <p role="status">{t(($) => $.workflow.loading)}</p> : attachment.isError ? <CockpitFlowError onRetry={() => void attachment.refetch()} /> : attachment.data ? <><p className="break-words">{attachment.data.filename}</p><CockpitSourceContextLinks wsId={wsId} issueId={attachment.data.issueId} runId={null} /></> : null)}
        {draft.source.kind === "artifact_version" && (artifact.isPending ? <p role="status">{t(($) => $.workflow.loading)}</p> : artifact.isError ? <CockpitFlowError onRetry={() => void artifact.refetch()} /> : artifact.data && artifactSource ? <>
          <AppLink href={cockpitArtifactPath(paths.cockpit(), artifactSource.artifactId, EMPTY_COCKPIT_SCOPE, artifactSource.versionId)} target="_blank" rel="noopener noreferrer" className="text-primary underline">{t(($) => $.workflow.version, { number: artifact.data.version.version_number })} · {artifact.data.version.filename || t(($) => $.input_materials.open_source_artifact)} · {t(($) => $.action_flow.new_tab)}</AppLink>
          <ArtifactStatus status={artifact.data.version.decision} /><CockpitSourceContextLinks wsId={wsId} issueId={artifact.data.version.producer_issue_id || null} runId={artifact.data.version.producer_run_id} />
        </> : null)}
      </div>
      {!draft.versionId && <Button type="button" variant="outline" size="sm" disabled={locked || !allowed} onClick={() => setPicking(true)}>{t(($) => $.input_materials.choose_other_source)}</Button>}
    </>}
    <label className="block space-y-1 text-caption">{t(($) => $.input_materials.purpose)}<Select value={draft.purpose} disabled={locked || Boolean(draft.versionId)} items={{ material: t(($) => $.input_materials.purpose_material), recording: t(($) => $.input_materials.purpose_recording), supporting: t(($) => $.input_materials.purpose_supporting) }} onValueChange={(purpose) => { if (purpose === "material" || purpose === "recording" || purpose === "supporting") setCockpitInputForm(key, { ...draft, purpose }); }}>
      <SelectTrigger className="w-full" aria-label={t(($) => $.input_materials.purpose)}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="material">{t(($) => $.input_materials.purpose_material)}</SelectItem><SelectItem value="recording">{t(($) => $.input_materials.purpose_recording)}</SelectItem><SelectItem value="supporting">{t(($) => $.input_materials.purpose_supporting)}</SelectItem></SelectContent></Select></label>
    {currentHeader.isError && <CockpitFlowError onRetry={() => void currentHeader.refetch()} />}
    {changed && <div role="alert" className="space-y-2 text-caption"><p>{t(($) => $.input_materials.header_changed)}</p><p className="break-words font-medium [overflow-wrap:anywhere]">{currentHeader.data?.title}</p><Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => { if (currentHeader.data) setCockpitInputForm(key, { ...draft, inputRevision: currentHeader.data.revision }); }}>{t(($) => $.input_materials.use_current_header)}</Button></div>}
    {currentHeader.data && <CockpitInputProblem codes={currentHeader.data.blockedReasons} />}
    <CockpitInputCommandRecovery pending={Boolean(request.pending)} busy={busy || request.busy} canRetry={request.canRetry} onVerify={() => void recover("lookup")} onRetry={() => void recover("submit")} />
    {request.error && <p role="alert" className="break-words text-caption text-destructive">{request.error}</p>}
    {!allowed && <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.add_unavailable)}</p>}
    <div className="flex flex-wrap justify-end gap-2">{draft.inputId && <Button type="button" variant="outline" onClick={() => onOpenVersion(draft.inputId!, draft.versionId || undefined)}>{t(($) => $.input_materials.open_registered)}</Button>}<CockpitInputEndRegistration wsId={wsId} accountId={accountId} meetingId={meetingId} draftKey={key} draft={draft} disabled={locked} onEnded={onCancel} /><Button type="button" variant="outline" onClick={onCancel}>{t(($) => $.input_materials.return_materials)}</Button>
      <Button type="button" disabled={locked || !eligible} aria-busy={busy || request.busy} onClick={() => void submit()}>{t(($) => $.input_materials.register_source)}</Button></div>
  </section>;
}
