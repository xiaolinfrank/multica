"use client";

import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@multica/core/api";
import {
  advanceCockpitInputForm, clearCockpitInputForm, cockpitInputDraftKey, cockpitInputTransferOptions,
  cockpitInputVersionOptions,
  cockpitInputDetailOptions,
  emptyCockpitInputForm, setCockpitInputForm, useCockpitInputDraftStore, useUploadCockpitInputBytes,
  type CockpitInputFormDraft,
} from "@multica/core/cockpit";
import type { CockpitInputCapabilities, CockpitInputHeader, CockpitInputVersionMetadata } from "@multica/core/types/cockpit-input";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { toast } from "sonner";
import { useT } from "../../i18n";
import { useNavigation } from "../../navigation";
import { formatBytes } from "../../common/format-bytes";
import { CockpitInputFileField } from "./cockpit-input-file-field";
import { CockpitInputTransferStatus } from "./cockpit-input-transfer-status";
import { CockpitInputCommandRecovery } from "./cockpit-input-command-recovery";
import { useCockpitCommandContext } from "./use-cockpit-command-context";
import { useCockpitInputRequest, type CockpitInputAcknowledgement } from "./use-cockpit-input-request";
import { CockpitFlowError } from "./cockpit-task-flow";
import { CockpitInputEndRegistration } from "./cockpit-input-end-registration";
import { CockpitInputProblem } from "./cockpit-input-problem";
import { createSafeId } from "@multica/core/utils";

export function CockpitInputUploadForm({ wsId, accountId, meetingId, existingInput, recoveryVersion, agendaId = null, projectId = null, originIssueId = null, targetLabel, capabilities, canAdd, onOpenVersion, onCancel }: {
  wsId: string;
  accountId: string;
  meetingId?: string;
  existingInput?: CockpitInputHeader;
  recoveryVersion?: CockpitInputVersionMetadata;
  agendaId?: string | null;
  projectId?: string | null;
  originIssueId?: string | null;
  targetLabel: string;
  capabilities: CockpitInputCapabilities;
  canAdd: boolean;
  onOpenVersion: (inputId: string, versionId?: string) => void;
  onCancel: () => void;
}) {
  const { t } = useT("cockpit");
  const client = useQueryClient();
  const key = recoveryVersion ? cockpitInputDraftKey(wsId, accountId, "recover-input-version", recoveryVersion.inputId, recoveryVersion.id)
    : existingInput ? cockpitInputDraftKey(wsId, accountId, "input-version", existingInput.id) : cockpitInputDraftKey(wsId, accountId, "upload", meetingId || "", agendaId || "");
  const initial = useRef<{ key: string; value: CockpitInputFormDraft } | null>(null);
  if (!initial.current || initial.current.key !== key) initial.current = { key, value: { ...emptyCockpitInputForm(createSafeId(), agendaId),
    ...(existingInput ? { inputId: existingInput.id, inputRevision: existingInput.revision, title: existingInput.title, description: existingInput.description } : {}),
    ...(recoveryVersion ? { inputId: recoveryVersion.inputId, versionId: recoveryVersion.id, transferId: recoveryVersion.latestTransferId,
      declaration: recoveryVersion.sizeBytes !== null || recoveryVersion.declaredSizeBytes !== null
        ? { filename: recoveryVersion.filename, contentType: recoveryVersion.contentType, sizeBytes: recoveryVersion.sizeBytes ?? recoveryVersion.declaredSizeBytes!, lastModified: 0 } : null } : {}),
  } };
  const stored = useCockpitInputDraftStore((state) => state.draft.forms[key]);
  const draft = stored ?? initial.current.value;
  const [stopping, setStopping] = useState(false);
  const [fileSelection, setFileSelection] = useState<{ generation: string; file: File } | null>(null);
  const file = fileSelection?.generation === draft.generation ? fileSelection.file : null;
  const request = useCockpitInputRequest(wsId, key);
  const upload = useUploadCockpitInputBytes(wsId);
  const captureContext = useCockpitCommandContext(`${key}:${draft.generation}`);
  const navigation = useNavigation();
  const signature = JSON.stringify([key, draft.generation, navigation.pathname, navigation.searchParams.toString()]);
  const epoch = useRef({ signature, generation: 0 });
  if (epoch.current.signature !== signature) epoch.current = { signature, generation: epoch.current.generation + 1 };
  const generation = epoch.current.generation;
  const flowLock = useRef<{ generation: number; token: symbol } | null>(null);
  const [flow, setFlow] = useState({ generation, busy: false, error: "" });
  const busy = flow.generation === generation && flow.busy;
  const error = flow.generation === generation ? flow.error : "";
  const setError = (message: string) => setFlow((value) => ({ generation, busy: value.generation === generation && value.busy, error: message }));
  const transfer = useQuery({ ...cockpitInputTransferOptions(wsId, draft.inputId || "", draft.versionId || "", draft.transferId || ""),
    enabled: Boolean(draft.inputId && draft.versionId && draft.transferId) });
  const version = useQuery({ ...cockpitInputVersionOptions(wsId, draft.inputId || "", draft.versionId || ""), enabled: Boolean(draft.inputId && draft.versionId) });
  const header = useQuery({ ...cockpitInputDetailOptions(wsId, draft.inputId || ""), enabled: Boolean(draft.inputId) });
  const readForbidden = [header.error, version.error, transfer.error].some((cause) => cause instanceof ApiError && cause.status === 403);
  const headerChanged = Boolean(!draft.versionId && header.data && draft.inputRevision !== header.data.revision && !busy);
  const modes = !version.isError ? version.data?.version.allowedRestartModes ?? [] : [];
  const sourceIsUpload = version.data?.version.source.kind === "upload";
  const needsFile = !draft.versionId || transfer.data?.canUpload || modes.includes("upload_matching_bytes") || sourceIsUpload && modes.includes("retry_source");
  const locked = busy || request.busy || Boolean(request.pending);
  const initialAllowed = capabilities.directUploadAvailable && (existingInput ? existingInput.canSubmit : canAdd && capabilities.canCreate);

  const update = (patch: Partial<CockpitInputFormDraft>) => { setCockpitInputForm(key, { ...draft, ...patch }); setError(""); };
  function record(ack: CockpitInputAcknowledgement, value: CockpitInputFormDraft): CockpitInputFormDraft {
    const response = ack.acknowledged;
    let patch: Partial<CockpitInputFormDraft> = {};
    if (response.kind === "create") patch = { inputId: response.result.receipt.inputId, inputRevision: response.result.receipt.inputRevision };
    if (response.kind === "version") patch = { inputId: response.result.receipt.inputId, inputRevision: response.result.receipt.inputRevision,
      versionId: response.result.receipt.versionId, transferId: response.result.receipt.transferId, transferRevision: response.result.receipt.transferRevision };
    if (response.kind === "restart") patch = { transferId: response.result.receipt.transferId, transferRevision: response.result.receipt.revision };
    advanceCockpitInputForm(key, value.generation, patch);
    return { ...value, ...patch };
  }

  function openFixed(value: CockpitInputFormDraft, stillCurrent: () => boolean, acknowledged = false) {
    if (!value.inputId || !value.versionId) return;
    clearCockpitInputForm(key, value);
    if (stillCurrent()) { if (acknowledged) toast.success(t(($) => $.input_materials.version_confirmed)); onOpenVersion(value.inputId, value.versionId); }
  }

  async function continueTransfer(value: CockpitInputFormDraft, selected: File | null, stillCurrent: () => boolean) {
    if (!value.inputId || !value.versionId || !value.transferId) return;
    const options = cockpitInputTransferOptions(wsId, value.inputId, value.versionId, value.transferId);
    let current = await client.fetchQuery({ ...options, staleTime: 0 });
    if (!stillCurrent()) return;
    if (!["initial", "retry_source", "upload_matching_bytes"].includes(current.mode)) { setError(t(($) => $.input_materials.unknown_state)); return; }
    if (current.state === "verified") { openFixed(value, stillCurrent); return; }
    if (current.canUpload && current.state === "awaiting_bytes") {
      if (!selected) { setError(t(($) => $.input_materials.reselect_hint)); return; }
      if (selected.size > capabilities.maxFileBytes) { setError(t(($) => $.input_materials.file_too_large, { size: formatBytes(capabilities.maxFileBytes) })); return; }
      if (selected.size !== current.expectedBytes) {
        setError(t(($) => $.input_materials.reselect_mismatch)); return;
      }
      await upload.mutateAsync({ inputId: value.inputId, versionId: value.versionId, transferId: value.transferId, revision: current.revision, file: selected });
      if (!stillCurrent()) return;
      current = await client.fetchQuery({ ...options, staleTime: 0 });
    }
    if (!stillCurrent()) return;
    if (current.canFinalize && current.state === "awaiting_finalize" && current.contentHash) {
      const ack = await request.run({ kind: "finalize", inputId: value.inputId, versionId: value.versionId, transferId: value.transferId,
        body: { commandKey: createSafeId(), expectedRevision: current.revision, expectedContentHash: current.contentHash } });
      if (ack?.acknowledged.kind === "finalize") openFixed(value, ack.stillCurrent, true);
    } else if (current.state === "verified") openFixed(value, stillCurrent);
  }

  async function submit() {
    if (flowLock.current?.generation === generation || request.pending || readForbidden || headerChanged || (!draft.versionId && !initialAllowed)) return;
    if (!draft.versionId && (!file || !draft.title.trim() || file.size > capabilities.maxFileBytes)) return;
    if (new TextEncoder().encode(draft.title.trim()).length > 512 || new TextEncoder().encode(draft.description).length > 16000) {
      setError(t(($) => $.input_materials.text_too_long)); return;
    }
    if (draft.declaration && (new TextEncoder().encode(draft.declaration.filename).length > 255 || draft.declaration.contentType.length > 255)) {
      setError(t(($) => $.input_materials.filename_too_long)); return;
    }
    const token = Symbol("input-upload-flow"); flowLock.current = { generation, token }; setFlow({ generation, busy: true, error: "" });
    const stillCurrent = captureContext();
    let value = draft;
    setCockpitInputForm(key, value);
    try {
      if (!value.inputId) {
        const ack = await request.run({ kind: "create", body: { commandKey: createSafeId(), title: value.title.trim(), description: value.description, projectId, originIssueId } });
        if (!ack) return;
        value = record(ack, value);
        if (!ack.stillCurrent()) return;
      }
      if (!value.versionId && value.inputId && value.inputRevision !== null && value.source) {
        const ack = await request.run({ kind: "version", inputId: value.inputId, body: { commandKey: createSafeId(), expectedRevision: value.inputRevision,
          source: value.source, initialReference: meetingId ? { referenceKey: createSafeId(), meetingId, agendaId: value.agendaId, purpose: value.purpose } : null } });
        if (!ack) return;
        value = record(ack, value);
        if (!ack.stillCurrent()) return;
      }
      await continueTransfer(value, file, stillCurrent);
    } catch (cause) {
      if (stillCurrent()) setError(cause instanceof Error ? cause.message : t(($) => $.input_materials.error_unknown));
    } finally {
      if (flowLock.current?.token === token) {
        flowLock.current = null;
        if (stillCurrent()) setFlow((value) => value.generation === generation ? { ...value, busy: false } : value);
      }
    }
  }

  async function recover(mode: "lookup" | "submit") {
    if (flowLock.current?.generation === generation || !request.pending || mode === "submit" && readForbidden) return;
    const value = draft;
    const ack = mode === "lookup" ? await request.verify() : await request.run(request.pending);
    if (!ack) return;
    const next = record(ack, value);
    if (ack.acknowledged.kind === "finalize") openFixed(next, ack.stillCurrent, true);
  }

  async function restart(mode: "retry_source" | "upload_matching_bytes") {
    if (flowLock.current?.generation === generation || request.pending || readForbidden || !draft.inputId || !draft.versionId || !modes.includes(mode)) return;
    const requiresFile = mode === "upload_matching_bytes" || sourceIsUpload;
    if (requiresFile && (!file || file.size > capabilities.maxFileBytes)) return;
    const expectedSize = version.data?.version.sizeBytes ?? version.data?.version.declaredSizeBytes;
    if (requiresFile && expectedSize !== null && expectedSize !== undefined && file?.size !== expectedSize) { setError(t(($) => $.input_materials.reselect_mismatch)); return; }
    const token = Symbol("input-upload-restart"); flowLock.current = { generation, token }; setFlow({ generation, busy: true, error: "" });
    const stillCurrent = captureContext();
    setCockpitInputForm(key, draft);
    try {
      const latest = await client.fetchQuery({ ...cockpitInputVersionOptions(wsId, draft.inputId, draft.versionId), staleTime: 0 });
      if (!stillCurrent()) return;
      if (!latest.version.allowedRestartModes.includes(mode) || latest.version.latestTransferId !== draft.transferId) { setError(t(($) => $.input_materials.error_transfer_changed)); return; }
      const ack = await request.run({ kind: "restart", inputId: draft.inputId, versionId: draft.versionId,
        body: { commandKey: createSafeId(), expectedRevision: latest.version.revision, previousTransferId: draft.transferId,
          mode, reason: "" } });
      if (!ack) return;
      const next = record(ack, draft);
      if (ack.stillCurrent()) await continueTransfer(next, file, ack.stillCurrent);
    } catch (cause) {
      if (stillCurrent()) setError(cause instanceof Error ? cause.message : t(($) => $.input_materials.error_unknown));
    } finally {
      if (flowLock.current?.token === token) { flowLock.current = null; if (stillCurrent()) setFlow((value) => value.generation === generation ? { ...value, busy: false } : value); }
    }
  }

  async function abandon() {
    if (flowLock.current?.generation === generation || request.pending || readForbidden || !draft.inputId || !draft.versionId || !draft.transferId || !draft.note.trim()) return;
    const token = Symbol("input-upload-stop"); flowLock.current = { generation, token }; setFlow({ generation, busy: true, error: "" });
    const stillCurrent = captureContext(); setCockpitInputForm(key, draft);
    try {
      const current = await client.fetchQuery({ ...cockpitInputTransferOptions(wsId, draft.inputId, draft.versionId, draft.transferId), staleTime: 0 });
      if (!stillCurrent()) return;
      if (!current.canAbandon) { setError(t(($) => $.input_materials.error_transfer_changed)); return; }
      const ack = await request.run({ kind: "abandon", inputId: draft.inputId, versionId: draft.versionId, transferId: draft.transferId,
        body: { commandKey: createSafeId(), expectedRevision: current.revision, reason: draft.note.trim() } });
      if (ack?.acknowledged.kind === "abandon" && ack.stillCurrent()) setStopping(false);
    } catch (cause) {
      if (stillCurrent()) setError(cause instanceof Error ? cause.message : t(($) => $.input_materials.error_unknown));
    } finally {
      if (flowLock.current?.token === token) { flowLock.current = null; if (stillCurrent()) setFlow((value) => value.generation === generation ? { ...value, busy: false } : value); }
    }
  }

  return <section className="min-w-0 space-y-4" aria-label={t(($) => $.input_materials.upload)}>
    <p className="break-words rounded-lg bg-muted/50 p-3 text-caption [overflow-wrap:anywhere]">{targetLabel}</p>
    {needsFile && <CockpitInputFileField file={file} retainedFile={draft.declaration ? { name: draft.declaration.filename, size: draft.declaration.sizeBytes } : null}
      maxBytes={capabilities.maxFileBytes} intent={recoveryVersion ? "recover" : "upload"} disabled={locked} onSelect={(selected) => {
        setFileSelection({ generation: draft.generation, file: selected });
        if (!draft.versionId) update({ title: draft.title || selected.name,
          declaration: { filename: selected.name, contentType: selected.type || "application/octet-stream", sizeBytes: selected.size, lastModified: selected.lastModified },
          source: { kind: "upload", upload: { filename: selected.name, contentType: selected.type || "application/octet-stream", sizeBytes: selected.size, clientSha256: null }, nasFile: null, attachment: null, artifactVersion: null } });
        else setError("");
      }} />}
    {recoveryVersion && !sourceIsUpload && modes.includes("retry_source") && modes.includes("upload_matching_bytes") && <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.recovery_file_optional)}</p>}
    {!recoveryVersion && <label className="block space-y-1 text-caption"><span>{t(($) => $.input_materials.name)}</span>
      <Input name="input_title" autoComplete="off" maxLength={512} value={draft.title} disabled={locked || Boolean(draft.inputId)} onChange={(event) => update({ title: event.target.value })} />
    </label>}
    {meetingId && <label className="block space-y-1 text-caption"><span>{t(($) => $.input_materials.purpose)}</span>
      <Select value={draft.purpose} items={{ material: t(($) => $.input_materials.purpose_material), recording: t(($) => $.input_materials.purpose_recording), supporting: t(($) => $.input_materials.purpose_supporting) }}
        disabled={locked || Boolean(draft.versionId)} onValueChange={(purpose) => { if (purpose === "material" || purpose === "recording" || purpose === "supporting") update({ purpose }); }}>
        <SelectTrigger className="w-full" aria-label={t(($) => $.input_materials.purpose)}><SelectValue /></SelectTrigger><SelectContent>
          <SelectItem value="material">{t(($) => $.input_materials.purpose_material)}</SelectItem>
          <SelectItem value="recording">{t(($) => $.input_materials.purpose_recording)}</SelectItem>
          <SelectItem value="supporting">{t(($) => $.input_materials.purpose_supporting)}</SelectItem>
        </SelectContent>
      </Select>
    </label>}
    {!recoveryVersion && <details><summary className="cursor-pointer text-caption text-muted-foreground">{t(($) => $.input_materials.description_optional)}</summary>
      <Textarea className="mt-2" name="input_description" aria-label={t(($) => $.input_materials.description_optional)} rows={3} disabled={locked || Boolean(draft.inputId)} value={draft.description} onChange={(event) => update({ description: event.target.value })} />
    </details>}
    {transfer.data && <CockpitInputTransferStatus state={transfer.data.state} receivedBytes={transfer.data.receivedBytes} expectedBytes={transfer.data.expectedBytes} error={transfer.data.errorMessage || undefined}
      recovery={<Button type="button" variant="outline" size="sm" disabled={locked || transfer.isFetching} onClick={() => void transfer.refetch()}>{t(($) => $.input_materials.check_transfer)}</Button>} />}
    {transfer.data && <CockpitInputProblem codes={transfer.data.blockedReasons} />}
    {transfer.data?.canAbandon && <div className="space-y-2">
      {stopping ? <div className="space-y-2 rounded-lg border border-border p-3"><p className="text-caption text-muted-foreground">{t(($) => $.input_materials.stop_attempt_hint)}</p>
        <label className="block space-y-1 text-caption">{t(($) => $.input_materials.stop_reason)}<Textarea value={draft.note} maxLength={2000} disabled={locked} onChange={(event) => update({ note: event.target.value })} /></label>
        <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" onClick={() => setStopping(false)}>{t(($) => $.task_create.cancel)}</Button><Button type="button" size="sm" variant="destructive" disabled={locked || readForbidden || !draft.note.trim()} onClick={() => void abandon()}>{t(($) => $.input_materials.stop_attempt)}</Button></div>
      </div> : <Button type="button" size="sm" variant="ghost" disabled={locked || readForbidden} onClick={() => setStopping(true)}>{t(($) => $.input_materials.stop_attempt)}</Button>}
    </div>}
    {(modes.includes("retry_source") || modes.includes("upload_matching_bytes")) && <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {modes.includes("retry_source") && <Button type="button" variant="outline" size="sm" disabled={locked || readForbidden || sourceIsUpload && (!file || file.size > capabilities.maxFileBytes)} onClick={() => void restart("retry_source")}>
          {sourceIsUpload ? t(($) => $.input_materials.restart_upload) : t(($) => $.input_materials.retry_original_source)}
        </Button>}
        {modes.includes("upload_matching_bytes") && (!sourceIsUpload || !modes.includes("retry_source")) && <Button type="button" variant="outline" size="sm" disabled={locked || readForbidden || !file || file.size > capabilities.maxFileBytes} onClick={() => void restart("upload_matching_bytes")}>{t(($) => $.input_materials.provide_matching_copy)}</Button>}
      </div>
      {modes.includes("upload_matching_bytes") && <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.restore_fixed_copy_hint)}</p>}
    </div>}
    {version.data && draft.versionId && version.data.version.latestTransferId !== draft.transferId && <div className="space-y-2 text-caption"><p>{t(($) => $.input_materials.error_transfer_changed)}</p><Button type="button" variant="outline" size="sm" disabled={locked || readForbidden} onClick={() => update({ transferId: version.data!.version.latestTransferId, transferRevision: null })}>{t(($) => $.input_materials.inspect_current_attempt)}</Button></div>}
    {transfer.isError && <CockpitFlowError onRetry={() => void transfer.refetch()} />}
    {header.isError && <CockpitFlowError onRetry={() => void header.refetch()} />}
    {draft.inputId && readForbidden && <p role="status" className="text-caption text-muted-foreground">{t(($) => $.input_materials.registered_permission_changed)}</p>}
    {headerChanged && header.data && <div role="alert" className="space-y-2 text-caption"><p>{t(($) => $.input_materials.header_changed)}</p>
      <p className="break-words [overflow-wrap:anywhere]">{header.data.title}</p>
      <Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => update({ inputRevision: header.data!.revision })}>{t(($) => $.input_materials.use_current_header)}</Button>
    </div>}
    {!draft.inputId && !initialAllowed && <>{capabilities.unavailableReason ? <CockpitInputProblem codes={[capabilities.unavailableReason]} /> : <p role="status" className="text-caption text-muted-foreground">{t(($) => $.input_materials.add_unavailable)}</p>}</>}
    <CockpitInputCommandRecovery pending={Boolean(request.pending)} busy={busy || request.busy} canRetry={request.canRetry && !readForbidden} onVerify={() => void recover("lookup")} onRetry={() => void recover("submit")} />
    {(error || request.error) && <p role="alert" className="break-words text-caption text-destructive [overflow-wrap:anywhere]">{error || request.error}</p>}
    <div className="flex flex-wrap justify-end gap-2">
      {meetingId && !existingInput && !recoveryVersion && <CockpitInputEndRegistration wsId={wsId} accountId={accountId} meetingId={meetingId} draftKey={key} draft={draft} disabled={locked} onEnded={onCancel} />}
      <Button type="button" variant="outline" onClick={onCancel}>{t(($) => $.input_materials.return_materials)}</Button>
      {draft.inputId && transfer.data?.state !== "verified" && <Button type="button" variant="outline" onClick={() => onOpenVersion(draft.inputId!, draft.versionId || undefined)}>{t(($) => $.input_materials.open_registered)}</Button>}
      {(!draft.transferId || transfer.data?.canUpload || transfer.data?.canFinalize || transfer.data?.state === "verified") && <Button type="button"
        disabled={locked || readForbidden || headerChanged || !draft.versionId && (!initialAllowed || !file || !draft.title.trim() || file.size > capabilities.maxFileBytes)} aria-busy={busy || request.busy} onClick={() => void submit()}>
        {(busy || request.busy) && <Spinner aria-hidden="true" />}{transfer.data?.state === "verified" ? t(($) => $.input_materials.open_fixed) : transfer.data?.canFinalize ? t(($) => $.input_materials.finish_registration)
          : draft.inputId ? t(($) => $.input_materials.continue_upload) : t(($) => $.input_materials.upload_and_fix)}
      </Button>}
    </div>
  </section>;
}
