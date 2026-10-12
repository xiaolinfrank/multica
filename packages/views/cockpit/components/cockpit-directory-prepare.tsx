"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  cockpitDirectoryRootsOptions, cockpitDirectoryRootOptions, usePreviewCockpitMeetingDirectory, cockpitExistingDirectoryOperation,
  cockpitMeetingDirectoryDraftKey, useCockpitMeetingDirectoryDraftStore, setCockpitDirectoryForm, clearCockpitDirectoryForm,
  type CockpitDirectoryPrepareDraft, type CockpitDirectoryRepairSelection,
} from "@multica/core/cockpit";
import type { CockpitDirectorySummary } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@multica/ui/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { Input } from "@multica/ui/components/ui/input";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useT } from "../../i18n";
import { CockpitFlowError } from "./cockpit-task-flow";
import { CockpitDirectoryReasons, CockpitDirectoryPreviewView, supportsDirectoryPreview } from "./cockpit-directory-parts";
import { useCockpitDirectoryCommand } from "./use-cockpit-directory-command";
import { useCockpitPreparationConfirmation } from "./use-cockpit-preparation-request";
import { createSafeId } from "@multica/core/utils";

const partitions = ["会议纪要与录音转写", "会议材料", "照片"];
type RepairContext = { operationId: string; selection: CockpitDirectoryRepairSelection | null };

export function CockpitDirectoryPrepare({ wsId, summary, readOnly, mode = "prepare", repair, onCreated, refresh, onManageMeeting }: {
  wsId: string; summary: CockpitDirectorySummary; readOnly?: boolean; onCreated: (operationId: string) => void; refresh: () => void; onManageMeeting: () => void;
} & ({ mode?: "prepare"; repair?: never } | { mode: "repair"; repair: RepairContext })) {
  const { t } = useT("cockpit"); const [open, setOpen] = useState(false); const writing = useRef(false);
  const key = cockpitMeetingDirectoryDraftKey(wsId, summary.meeting_id, "prepare", mode, ...(mode === "repair" ? [repair!.operationId] : []));
  const pending = useCockpitMeetingDirectoryDraftStore((state) => state.draft.commands[key]);
  const draft = useCockpitMeetingDirectoryDraftStore((state) => state.draft.forms[key]);
  const repairAvailable = mode !== "repair" || Boolean(repair?.selection);
  return <><Dialog open={open} onOpenChange={(next) => { if (!writing.current) setOpen(next); }}><DialogTrigger render={<Button variant="outline" size="sm" disabled={!pending && !draft && (readOnly || !summary.capabilities.can_preview || !repairAvailable)} />}>{t(($) => $.meeting_directory[mode === "repair" ? "repair" : "prepare"])}</DialogTrigger>
    {open && <PrepareForm key={key} wsId={wsId} summary={summary} mode={mode} repair={repair} draftKey={key} readOnly={readOnly} onBusy={(busy) => { writing.current = busy; }} refresh={refresh} onManageMeeting={() => { setOpen(false); onManageMeeting(); }} onCreated={(id) => { setOpen(false); onCreated(id); }} />}
  </Dialog>{!repairAvailable && <div className="space-y-1 text-caption"><p>{t(($) => $.meeting_directory.repair_scope_unavailable)}</p><Button variant="outline" size="sm" onClick={refresh}>{t(($) => $.meeting_lifecycle.refresh)}</Button></div>}</>;
}

function PrepareForm({ wsId, summary, mode, repair, draftKey, readOnly, onBusy, onCreated, refresh, onManageMeeting }: {
  wsId: string; summary: CockpitDirectorySummary; mode: "prepare" | "repair"; repair?: RepairContext; draftKey: string; readOnly?: boolean; onBusy: (busy: boolean) => void; onCreated: (id: string) => void; refresh: () => void; onManageMeeting: () => void;
}) {
  const { t } = useT("cockpit"); const request = useCockpitDirectoryCommand(wsId, summary.meeting_id, draftKey);
  const pending = request.pending?.kind === "prepare" ? request.pending : null;
  const [initial] = useState<CockpitDirectoryPrepareDraft>(() => pending ? { kind: "prepare", mode: pending.body.mode, rootId: pending.body.root_id, relativeDirectory: pending.body.relative_directory, partitions: pending.body.partitions,
    observedNasDir: pending.body.observed_nas_dir, observedBindingRevision: pending.body.observed_binding_revision, bindAfterBase: pending.body.bind_after_base }
    : { kind: "prepare", mode, rootId: mode === "repair" ? repair?.selection?.rootId ?? "" : summary.binding_candidate?.root_id ?? "",
      relativeDirectory: mode === "repair" ? repair?.selection?.relativeDirectory ?? "" : summary.binding_candidate?.relative_directory ?? "",
      partitions: mode === "repair" ? repair?.selection?.partitions ?? [] : partitions,
      observedNasDir: summary.binding.nas_dir, observedBindingRevision: summary.binding.revision, bindAfterBase: mode !== "repair" && !summary.binding.nas_dir });
  const stored = useCockpitMeetingDirectoryDraftStore((state) => state.draft.forms[draftKey]); const value = stored?.kind === "prepare" ? stored : initial;
  const roots = useQuery({ ...cockpitDirectoryRootsOptions(wsId), enabled: summary.capabilities.can_preview && !pending, staleTime: 0 });
  const root = useQuery({ ...cockpitDirectoryRootOptions(wsId, value.rootId), enabled: Boolean(value.rootId) && summary.capabilities.can_preview && !pending, staleTime: 0 });
  const preview = usePreviewCockpitMeetingDirectory(wsId, summary.meeting_id); const lock = useRef(false);
  const [error, setError] = useState(""); const [stage, setStage] = useState<"fields" | "preview">("fields");
  const { confirmed, setConfirmed, reviewRequired, previewAccepted, showError } = useCockpitPreparationConfirmation(request.cause);
  const changed = value.observedBindingRevision !== summary.binding.revision || value.observedNasDir !== summary.binding.nas_dir;
  const repairAvailable = mode !== "repair" || Boolean(repair?.selection && value.rootId === repair.selection.rootId && value.relativeDirectory === repair.selection.relativeDirectory && JSON.stringify(value.partitions) === JSON.stringify(repair.selection.partitions));
  const allowed = !readOnly && summary.capabilities.available && summary.capabilities.can_preview && repairAvailable;
  const busy = request.busy || preview.isPending;
  useEffect(() => { onBusy(request.busy); return () => onBusy(false); }, [request.busy, onBusy]);
  const update = (next: CockpitDirectoryPrepareDraft) => { setCockpitDirectoryForm(draftKey, next); preview.reset(); setConfirmed(false); setError(""); };
  const makePreview = async () => {
    if (lock.current || busy || pending || !allowed || changed || !root.data || root.isError || !value.relativeDirectory.trim()) return;
    lock.current = true; setConfirmed(false); setError(""); setCockpitDirectoryForm(draftKey, value);
    try {
      const result = await preview.mutateAsync({ mode: value.mode, root_id: value.rootId, relative_directory: value.relativeDirectory.trim(), partitions: value.partitions,
        observed_nas_dir: value.observedNasDir, observed_binding_revision: value.observedBindingRevision, bind_after_base: value.bindAfterBase });
      if (!result) throw new Error(t(($) => $.errors.load_failed)); setStage("preview"); previewAccepted();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { lock.current = false; }
  };
  const save = async () => {
    if (request.busy || !allowed || !summary.capabilities.can_create || pending && !request.canRetry || !pending && (!confirmed || changed || !preview.data?.can_confirm || !supportsDirectoryPreview(preview.data.steps))) return;
    const result = await request.run(pending ?? { kind: "prepare", meetingId: summary.meeting_id, body: { mode: value.mode, root_id: value.rootId,
      relative_directory: preview.data!.target.relative_directory, partitions: value.partitions, observed_nas_dir: value.observedNasDir, observed_binding_revision: value.observedBindingRevision,
      bind_after_base: value.bindAfterBase, command_key: createSafeId(), expected_revision: value.observedBindingRevision, context_token: preview.data!.context_token } });
    if (result) { clearCockpitDirectoryForm(draftKey, value); if (result.stillCurrent()) onCreated(result.receipt.directory_operation_id); }
  };
  const verify = async () => { const result = await request.verify(); if (result) { clearCockpitDirectoryForm(draftKey, value); if (result.stillCurrent()) onCreated(result.receipt.directory_operation_id); } };
  const original = request.observedCommand?.kind === "prepare" ? request.observedCommand : null;
  const existing = original ? cockpitExistingDirectoryOperation(request.cause, { workspaceId: wsId, meetingId: summary.meeting_id, rootId: original.body.root_id, commandKey: original.body.command_key }) : null;
  return <DialogContent className="flex max-h-[88dvh] flex-col overflow-hidden sm:max-w-2xl"><DialogHeader><DialogTitle>{t(($) => $.meeting_directory[mode === "repair" ? "repair" : "prepare"])}</DialogTitle></DialogHeader>
    <div className="min-h-0 space-y-3 overflow-y-auto overscroll-contain">
      {pending && <div className="space-y-2 text-caption"><p>{t(($) => $.meeting_lifecycle.pending_hint)}</p><Button variant="outline" size="sm" disabled={request.busy} onClick={() => void verify()}>{t(($) => $.meeting_lifecycle.check_command)}</Button></div>}
      {!allowed && <CockpitDirectoryReasons codes={summary.blocked_reasons} />}
      {mode === "repair" && <p className="text-caption text-muted-foreground">{t(($) => $.meeting_directory.repair_scope)}</p>}
      {!repairAvailable && !pending && <div className="space-y-1 text-caption"><p>{t(($) => $.meeting_directory.repair_scope_unavailable)}</p><Button variant="outline" size="sm" onClick={refresh}>{t(($) => $.meeting_lifecycle.refresh)}</Button></div>}
      {summary.blocked_reasons.some((code) => code === "meeting_cancelled" || code === "meeting_archived") && <Button variant="outline" size="sm" disabled={request.busy} onClick={onManageMeeting}>{t(($) => $.meeting_disposition.actions)}</Button>}
      {stage === "fields" && pending ? <div className="space-y-2 text-caption"><p dir="ltr" className="line-clamp-2 break-all font-mono">{pending.body.relative_directory}</p><details><summary className="cursor-pointer">{t(($) => $.meeting_directory.details)}</summary><p className="break-all">{pending.body.root_id}</p><p dir="ltr" className="break-all">{pending.body.relative_directory}</p><ul>{pending.body.partitions.map((partition) => <li key={partition}>{partition}</li>)}</ul></details></div> : stage === "fields" ? <>
        <p className="text-caption text-muted-foreground">{t(($) => $.meeting_directory.preview_hint)}</p>
        {roots.isPending && allowed ? <Spinner /> : roots.isError ? <CockpitFlowError onRetry={() => void roots.refetch()} /> : roots.data && <label className="block space-y-1 text-caption">{t(($) => $.meeting_directory.root)}
          <Select value={value.rootId} disabled={busy || Boolean(pending) || !allowed || mode === "repair"} items={roots.data.items.map((item) => ({ value: item.root_id, label: item.root_path }))} onValueChange={(rootId) => { if (rootId) update({ ...value, rootId }); }}>
            <SelectTrigger aria-label={t(($) => $.meeting_directory.root)} className="w-full"><SelectValue placeholder={t(($) => $.common.unset)} /></SelectTrigger><SelectContent>{roots.data.items.map((item) => <SelectItem key={item.root_id} value={item.root_id}>{item.root_path}</SelectItem>)}</SelectContent>
          </Select>
        </label>}
        {roots.data?.items.length === 0 && <CockpitDirectoryReasons codes={["prepare_not_configured"]} />}
        {value.rootId && (root.isPending && allowed ? <Spinner /> : root.isError ? <CockpitFlowError onRetry={() => void root.refetch()} /> : root.data && <div className="space-y-2 text-caption"><h3 className="font-medium">{t(($) => $.meeting_directory.boundary)}</h3>
          {root.data.prepare_subpaths.length === 0 ? <CockpitDirectoryReasons codes={["prepare_not_configured"]} /> : <ul className="max-h-40 list-inside list-disc overflow-y-auto break-all">{root.data.prepare_subpaths.map((path) => <li key={path} dir="ltr">{path}</li>)}</ul>}
        </div>)}
        <label className="block space-y-1 text-caption">{t(($) => $.meeting_directory.relative_path)}<Input value={value.relativeDirectory} dir="ltr" autoComplete="off" spellCheck={false} disabled={busy || Boolean(pending) || !allowed} readOnly={mode === "repair"} onChange={(event) => update({ ...value, relativeDirectory: event.target.value })} /></label>
        <fieldset disabled={busy || Boolean(pending) || !allowed || mode === "repair"} className="space-y-2"><legend className="mb-2 text-caption font-medium">{t(($) => $.meeting_directory.sections)}</legend>{(mode === "repair" ? value.partitions : partitions).map((partition) => <label key={partition} className="flex items-start gap-2 text-caption"><input type="checkbox" checked={value.partitions.includes(partition)} onChange={(event) => update({ ...value, partitions: event.target.checked ? [...value.partitions, partition] : value.partitions.filter((item) => item !== partition) })} />{partition}</label>)}</fieldset>
        <label className="flex items-start gap-2 text-caption"><input type="checkbox" checked={value.bindAfterBase} disabled={busy || Boolean(pending) || !allowed || mode === "repair"} onChange={(event) => update({ ...value, bindAfterBase: event.target.checked })} />{t(($) => $.meeting_directory.bind_option)}</label>
        {value.observedNasDir && <p className="break-all text-caption text-muted-foreground">{t(($) => $.meeting_directory.current_binding)}: {value.observedNasDir}</p>}
      </> : preview.data && <><CockpitDirectoryPreviewView value={preview.data} />
        <label className="flex items-start gap-2 text-caption"><input type="checkbox" checked={confirmed} disabled={busy || Boolean(pending) || reviewRequired || changed || !preview.data.can_confirm || !supportsDirectoryPreview(preview.data.steps)} onChange={(event) => setConfirmed(event.target.checked)} />{t(($) => $.meeting_directory.confirm_plan)}</label>
        <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={busy || Boolean(pending)} onClick={() => { preview.reset(); setConfirmed(false); setStage("fields"); }}>{t(($) => $.meeting_templates.edit_choices)}</Button><Button variant="outline" size="sm" disabled={busy || Boolean(pending) || !allowed || changed} onClick={() => void makePreview()}>{t(($) => $.meeting_templates.preview_again)}</Button></div>
      </>}
      {changed && !pending && <div role="alert" className="space-y-2 text-caption"><p>{t(($) => $.meeting_directory.binding_changed)}</p><Button variant="outline" size="sm" onClick={() => { refresh(); void root.refetch(); void roots.refetch(); }}>{t(($) => $.meeting_lifecycle.refresh)}</Button><Button variant="outline" size="sm" disabled={busy} onClick={() => { update({ ...value, observedNasDir: summary.binding.nas_dir, observedBindingRevision: summary.binding.revision }); setStage("fields"); }}>{t(($) => $.meeting_lifecycle.rebase)}</Button></div>}
      {reviewRequired && <p role="alert" className="text-caption">{t(($) => $.meeting_preparation.review_again_required)}</p>}
      {existing && <Button variant="outline" size="sm" onClick={() => onCreated(existing)}>{t(($) => $.meeting_directory.open_existing)}</Button>}
      {(error || showError && request.error) && <p role="alert" className="break-words text-caption text-destructive">{error || (request.error.startsWith("directory_command_") ? t(($) => $.task_flow.unconfirmed) : request.error)}</p>}
    </div>
    <DialogFooter><DialogClose render={<Button variant="outline" disabled={request.busy} />}>{t(($) => $.task_create.cancel)}</DialogClose>
      {pending ? <Button disabled={busy || !allowed || !summary.capabilities.can_create || !request.canRetry} onClick={() => void save()}>{t(($) => $.meeting_lifecycle.retry_command)}</Button>
        : stage === "fields" ? <Button disabled={busy || !allowed || changed || !root.data || root.isError || !root.data.prepare_subpaths.length || !value.relativeDirectory.trim()} onClick={() => void makePreview()}>{preview.isPending && <Spinner />}{t(($) => $.meeting_directory.preview)}</Button>
          : <Button disabled={busy || !allowed || !summary.capabilities.can_create || changed || !confirmed || !preview.data?.can_confirm || !supportsDirectoryPreview(preview.data.steps)} onClick={() => void save()}>{request.busy && <Spinner />}{t(($) => $.meeting_directory.confirm)}</Button>}
    </DialogFooter>
  </DialogContent>;
}
