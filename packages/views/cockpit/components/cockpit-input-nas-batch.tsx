"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@multica/core/api";
import {
  advanceCockpitInputForm, beginCockpitInputNASBatch, completeCockpitInputNASBatch, cockpitInputSelectedVersionsOptions, cockpitInputSelectedHeadersOptions,
  isCockpitDefinitiveCommandRejection, prepareCockpitInputCommand, resumeCockpitInputNASItem, setCockpitInputForm,
  settleCockpitInputCommand, skipCockpitInputNASItem, useCockpitInputCommand, useCockpitInputDraftStore,
  type CockpitInputFormDraft, type CockpitInputPendingCommand,
} from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@multica/ui/components/ui/dialog";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useNavigation } from "../../navigation";
import { useLocale, useT } from "../../i18n";
import { formatBytes } from "../../common/format-bytes";
import { CockpitFlowError, CockpitFlowPaging } from "./cockpit-task-flow";
import { useCockpitCommandContext } from "./use-cockpit-command-context";
import { CockpitInputCommandRecovery } from "./cockpit-input-command-recovery";
import { CockpitInputEndRegistration } from "./cockpit-input-end-registration";
import { CockpitInputVersionSummary } from "./cockpit-input-version-summary";

export function CockpitInputNASBatch({ wsId, accountId, meetingId, draftKey, canAdd, targetLabel, onOpenVersion, onRepair, onBack, onFinished }: {
  wsId: string;
  accountId: string;
  meetingId: string;
  draftKey: string;
  canAdd: boolean;
  targetLabel: string;
  onOpenVersion: (inputId: string, versionId?: string) => void;
  onRepair: (childKey: string) => void;
  onBack: () => void;
  onFinished: () => void;
}) {
  const { t } = useT("cockpit");
  const locale = useLocale();
  const forms = useCockpitInputDraftStore((state) => state.draft.forms);
  const commands = useCockpitInputDraftStore((state) => state.draft.commands);
  const parent = forms[draftKey];
  const mutation = useCockpitInputCommand(wsId);
  const navigation = useNavigation();
  const capture = useCockpitCommandContext(`${draftKey}:${parent?.generation || ""}`);
  const signature = JSON.stringify([draftKey, parent?.generation, navigation.pathname, navigation.searchParams.toString()]);
  const epoch = useRef({ signature, generation: 0 });
  if (epoch.current.signature !== signature) epoch.current = { signature, generation: epoch.current.generation + 1 };
  const generation = epoch.current.generation;
  const lock = useRef<{ generation: number; token: symbol; stop: boolean } | null>(null);
  const [state, setState] = useState<{ generation: number; busyKey: string; stopping: boolean; error: string; itemErrors: Record<string, string>; missingKeys: Record<string, string> }>({ generation, busyKey: "", stopping: false, error: "", itemErrors: {}, missingKeys: {} });
  const current = state.generation === generation ? state : { generation, busyKey: "", stopping: false, error: "", itemErrors: {}, missingKeys: {} };
  const busy = Boolean(current.busyKey);
  const childKeys = parent?.batch?.childKeys ?? [];
  const versionIds = [...new Set(childKeys.flatMap((key) => forms[key]?.versionId ? [forms[key]!.versionId!] : []))];
  const inputIds = [...new Set(childKeys.flatMap((key) => forms[key]?.inputId ? [forms[key]!.inputId!] : []))];
  const headers = useQuery({ ...cockpitInputSelectedHeadersOptions(wsId, inputIds), enabled: inputIds.length > 0 && !busy });
  const versions = useQuery({ ...cockpitInputSelectedVersionsOptions(wsId, versionIds), enabled: versionIds.length > 0 && !busy,
    refetchInterval: (query) => !query.state.error && query.state.data?.items.some((version) => ["awaiting_upload", "queued", "capturing"].includes(version.captureState)) ? 2_000 : false });
  const [pageNumber, setPageNumber] = useState(1);
  const selections = parent?.sourceSelections ?? [];
  const page = Math.min(pageNumber, Math.max(1, Math.ceil(selections.length / 25)));
  const displayed = selections.slice((page - 1) * 25, page * 25);
  const registered = childKeys.filter((key) => Boolean(forms[key]?.versionId)).length;
  const skipped = childKeys.filter((key) => forms[key]?.batchItem?.skipped).length;
  const ended = childKeys.filter((key) => forms[key]?.registrationEnd).length;
  const unconfirmed = childKeys.filter((key) => Boolean(commands[key])).length;
  const complete = childKeys.length > 0 && childKeys.every((key) => !commands[key] && (forms[key]?.versionId || forms[key]?.batchItem?.skipped && !forms[key]?.inputId || forms[key]?.registrationEnd && forms[key]?.inputId));
  const runnable = childKeys.some((key) => forms[key] && !commands[key] && !forms[key]!.versionId && !forms[key]!.batchItem?.skipped && !forms[key]!.registrationEnd);
  const attentionIndex = childKeys.findIndex((key) => commands[key] || !forms[key]?.registrationEnd && (forms[key]?.batchItem?.skipped && forms[key]?.inputId || current.itemErrors[key]));

  async function perform(childKey: string, command: CockpitInputPendingCommand, mode: "submit" | "lookup", stillCurrent: () => boolean) {
    const child = useCockpitInputDraftStore.getState().draft.forms[childKey];
    if (!child?.batchItem || child.batchItem.parentKey !== draftKey) throw new Error("input_batch_context_changed");
    const original = mode === "submit" ? prepareCockpitInputCommand(childKey, command) : command;
    try {
      const acknowledged = await mutation.mutateAsync({ command: original, mode });
      if (!stillCurrent()) return true;
      settleCockpitInputCommand(childKey, original.body.commandKey);
      if (acknowledged.kind === "create") advanceCockpitInputForm(childKey, child.generation, { inputId: acknowledged.result.receipt.inputId, inputRevision: acknowledged.result.receipt.inputRevision });
      if (acknowledged.kind === "version") advanceCockpitInputForm(childKey, child.generation, { inputId: acknowledged.result.receipt.inputId, inputRevision: acknowledged.result.receipt.inputRevision,
        versionId: acknowledged.result.receipt.versionId, transferId: acknowledged.result.receipt.transferId, transferRevision: acknowledged.result.receipt.transferRevision });
      if (stillCurrent()) setState((value) => ({ ...value, itemErrors: { ...value.itemErrors, [childKey]: "" }, missingKeys: { ...value.missingKeys, [childKey]: "" } }));
      return true;
    } catch (cause) {
      if (stillCurrent() && mode === "submit" && isCockpitDefinitiveCommandRejection(cause)) settleCockpitInputCommand(childKey, original.body.commandKey);
      if (stillCurrent()) setState((value) => ({ ...value, itemErrors: { ...value.itemErrors, [childKey]: cause instanceof Error ? cause.message : t(($) => $.input_materials.error_unknown) },
        missingKeys: { ...value.missingKeys, [childKey]: mode === "lookup" && cause instanceof ApiError && cause.status === 404 ? original.body.commandKey : "" } }));
      return false;
    }
  }

  async function submitItem(childKey: string, stillCurrent: () => boolean) {
    let child = useCockpitInputDraftStore.getState().draft.forms[childKey];
    if (!child || child.versionId || child.batchItem?.skipped || child.registrationEnd || useCockpitInputDraftStore.getState().draft.commands[childKey]) return;
    if (!child.inputId) {
      if (!await perform(childKey, { kind: "create", body: { commandKey: crypto.randomUUID(), title: child.title, description: child.description, projectId: null, originIssueId: null } }, "submit", stillCurrent)) return;
      child = useCockpitInputDraftStore.getState().draft.forms[childKey];
    }
    if (!stillCurrent() || lock.current?.stop || !child?.inputId || child.inputRevision === null || child.source?.kind !== "nas_file") return;
    await perform(childKey, { kind: "version", inputId: child.inputId, body: { commandKey: crypto.randomUUID(), expectedRevision: child.inputRevision, source: child.source,
      initialReference: { referenceKey: crypto.randomUUID(), meetingId, agendaId: child.agendaId, purpose: child.purpose } } }, "submit", stillCurrent);
  }

  async function run(onlyKey?: string, mode?: "submit" | "lookup") {
    if (lock.current?.generation === generation || !parent || !canAdd && !mode) return;
    const stillCurrent = capture();
    const token = Symbol("nas-input-batch"); lock.current = { generation, token, stop: false };
    setState((value) => ({ generation, busyKey: onlyKey || draftKey, stopping: false, error: "", itemErrors: value.generation === generation ? value.itemErrors : {}, missingKeys: value.generation === generation ? value.missingKeys : {} }));
    try {
      if (onlyKey && mode) {
        const command = useCockpitInputDraftStore.getState().draft.commands[onlyKey];
        if (command) await perform(onlyKey, command, mode, stillCurrent);
      } else {
        const batch = parent.batch ?? beginCockpitInputNASBatch(wsId, accountId, meetingId, draftKey, parent);
        for (const childKey of onlyKey ? [onlyKey] : batch.childKeys) {
          if (!stillCurrent() || lock.current?.stop) break;
          setState((value) => ({ ...value, busyKey: childKey }));
          await submitItem(childKey, stillCurrent);
        }
      }
    } catch (cause) {
      if (stillCurrent()) setState((value) => ({ ...value, error: cause instanceof Error ? cause.message : t(($) => $.input_materials.error_unknown) }));
    } finally {
      if (lock.current?.token === token) { lock.current = null; if (stillCurrent()) setState((value) => value.generation === generation ? { ...value, busyKey: "" } : value); }
    }
  }

  function finishBatch(startAnother: boolean) {
    if (!parent || busy) return;
    try { completeCockpitInputNASBatch(draftKey, parent.generation, crypto.randomUUID()); if (startAnother) onBack(); else onFinished(); }
    catch (cause) { setState((value) => ({ ...value, generation, error: cause instanceof Error ? cause.message : t(($) => $.input_materials.error_unknown) })); }
  }

  if (!parent) return <p role="status" className="text-caption">{t(($) => $.input_materials.batch_unavailable)}</p>;
  return <section className="min-w-0 space-y-4" aria-label={t(($) => $.input_materials.review_selection)}>
    <p className="break-words rounded-lg bg-muted/50 p-3 text-caption [overflow-wrap:anywhere]">{targetLabel}</p>
    <p className="text-caption">{t(($) => $.input_materials.batch_summary, { total: selections.length, registered, unconfirmed, skipped })}</p>
    {ended > 0 && <p className="text-caption">{t(($) => $.input_materials.batch_ended_count, { count: ended })}</p>}
    <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.batch_hint)}</p>
    {attentionIndex >= 0 && Math.floor(attentionIndex / 25) + 1 !== page && <Button type="button" variant="outline" size="sm" onClick={() => setPageNumber(Math.floor(attentionIndex / 25) + 1)}>{t(($) => $.input_materials.show_pending_items)}</Button>}
    <CockpitFlowPaging page={page} shown={displayed.length} total={selections.length} hasNext={page * 25 < selections.length} busy={false}
      onPrevious={() => setPageNumber(page - 1)} onNext={() => setPageNumber(page + 1)} />
    <ol className="max-h-[50dvh] min-w-0 space-y-3 overflow-y-auto overscroll-contain">{displayed.map((selection) => {
      const index = parent.batch?.selectionIds.indexOf(selection.selectionId) ?? -1;
      const childKey = index >= 0 ? parent.batch!.childKeys[index] : undefined;
      const child = childKey ? forms[childKey] : undefined;
      const isEnded = Boolean(child?.registrationEnd);
      const pending = childKey ? commands[childKey] : undefined;
      const source = child?.source?.nasFile;
      const observation = child?.sourceSelections.find((item) => source && item.rootId === source.rootId && item.relativePath === source.relativePath && item.observationToken === source.observationToken) ?? selection;
      const metadata = child?.versionId ? versions.data?.items.find((value) => value.id === child.versionId) : undefined;
      const versionUnavailable = Boolean(child?.versionId && versions.data?.unavailableIds.includes(child.versionId));
      return <li key={selection.selectionId} className="min-w-0 space-y-2 rounded-lg border border-border p-3">
        <p className="line-clamp-2 break-words text-caption font-medium [overflow-wrap:anywhere]" title={child?.title || selection.filename}>{child?.title || selection.filename}</p>
        <p className="text-caption text-muted-foreground">{[observation.sizeBytes !== null ? formatBytes(observation.sizeBytes) : "", observation.modifiedAt && Number.isFinite(Date.parse(observation.modifiedAt)) ? new Date(observation.modifiedAt).toLocaleString(locale) : ""].filter(Boolean).join(" · ")}</p>
        {child?.inputId && headers.data?.items.find((item) => item.id === child.inputId)?.archivedAt && <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.archived)}</p>}
        {metadata ? <CockpitInputVersionSummary version={metadata} /> : <p className="text-caption text-muted-foreground">{versionUnavailable ? t(($) => $.input_materials.unavailable_selection) : child?.versionId ? t(($) => $.input_materials.registered_checking)
          : isEnded ? t(($) => $.input_materials.registration_ended) : child?.batchItem?.skipped ? t(($) => $.input_materials.registration_skipped) : child?.inputId ? t(($) => $.input_materials.header_registered) : t(($) => $.input_materials.not_registered)}</p>}
        {isEnded && <p className="break-words text-caption text-muted-foreground">{child?.registrationEnd?.reason}</p>}
        {child?.batchItem?.skipped && <p className="break-words text-caption text-muted-foreground">{child.batchItem.skipReason}</p>}
        {current.busyKey === childKey && <p role="status" className="flex items-center gap-2 text-caption"><Spinner aria-hidden="true" />{t(($) => $.input_materials.registering_item)}</p>}
        <details className="text-caption text-muted-foreground"><summary className="cursor-pointer">{t(($) => $.input_materials.source_details)}</summary><p className="mt-2 break-words [overflow-wrap:anywhere]">{child?.source?.nasFile?.relativePath || selection.relativePath}</p></details>
        {childKey && <CockpitInputCommandRecovery pending={Boolean(pending)} busy={busy} canRetry={Boolean(pending && current.missingKeys[childKey] === pending.body.commandKey)}
          onVerify={() => void run(childKey, "lookup")} onRetry={() => void run(childKey, "submit")} />}
        {childKey && !isEnded && current.itemErrors[childKey] && <p role="alert" className="break-words text-caption text-destructive [overflow-wrap:anywhere]">{current.itemErrors[childKey]}</p>}
        {child && childKey && <div className="flex flex-wrap gap-2">
          {child.inputId && <Button type="button" variant="outline" size="sm" onClick={() => onOpenVersion(child.inputId!, child.versionId || undefined)}>{t(($) => $.input_materials.open_registered)}</Button>}
          {!child.versionId && !pending && !isEnded && <>
            <Button type="button" variant="outline" size="sm" disabled={busy || !canAdd} onClick={() => onRepair(childKey)}>{t(($) => $.input_materials.recheck_source)}</Button>
            {child.batchItem?.skipped ? <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { try { resumeCockpitInputNASItem(childKey, child.generation); }
              catch (cause) { setState((value) => ({ ...value, error: cause instanceof Error ? cause.message : t(($) => $.input_materials.error_unknown) })); } }}>{t(($) => $.input_materials.resume_item)}</Button>
              : <><Button type="button" variant="outline" size="sm" disabled={busy || !canAdd} onClick={() => void run(childKey)}>{t(($) => $.input_materials.continue_item)}</Button>
                <SkipInputItem childKey={childKey} child={child} disabled={busy} /></>}
            {child.inputId && !child.transferId && <CockpitInputEndRegistration wsId={wsId} accountId={accountId} meetingId={meetingId} draftKey={childKey} draft={child} disabled={busy} />}
          </>}
        </div>}
      </li>;
    })}</ol>
    {headers.isError && <CockpitFlowError onRetry={() => void headers.refetch()} />}
    {versions.isError && <CockpitFlowError onRetry={() => void versions.refetch()} />}
    {current.error && <p role="alert" className="break-words text-caption text-destructive [overflow-wrap:anywhere]">{current.error}</p>}
    {!canAdd && <p role="status" className="text-caption text-muted-foreground">{t(($) => $.input_materials.add_unavailable)}</p>}
    {parent.batch && !complete && !runnable && !busy && <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.batch_recovery_required)}</p>}
    <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" onClick={onBack}>{t(($) => $.input_materials.return_materials)}</Button>
      {busy ? <Button type="button" variant="outline" disabled={current.stopping} onClick={() => { if (lock.current?.generation === generation) { lock.current.stop = true; setState((value) => ({ ...value, stopping: true })); } }}>{current.stopping ? t(($) => $.input_materials.pausing_batch) : t(($) => $.input_materials.pause_batch)}</Button>
        : complete ? <><Button type="button" variant="outline" onClick={() => finishBatch(true)}>{t(($) => $.input_materials.new_batch)}</Button><Button type="button" onClick={() => finishBatch(false)}>{t(($) => $.input_materials.finish_batch)}</Button></>
          : <Button type="button" disabled={!canAdd || selections.length === 0 || Boolean(parent.batch && !runnable)} onClick={() => void run()}>{parent.batch ? t(($) => $.input_materials.continue_batch) : t(($) => $.input_materials.register_selection)}</Button>}
    </div>
    {busy && <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.pause_batch_hint)}</p>}
  </section>;
}

function SkipInputItem({ childKey, child, disabled }: { childKey: string; child: CockpitInputFormDraft; disabled: boolean }) {
  const { t } = useT("cockpit"); const [open, setOpen] = useState(false); const [error, setError] = useState("");
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger render={<Button type="button" variant="ghost" size="sm" disabled={disabled} />}>{t(($) => $.input_materials.skip_item)}</DialogTrigger>
    <DialogContent><DialogHeader><DialogTitle>{t(($) => $.input_materials.skip_item)}</DialogTitle></DialogHeader>
      <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.skip_item_hint)}</p>
      <label className="block space-y-1 text-caption"><span>{t(($) => $.input_materials.skip_reason)}</span><Textarea value={child.note} rows={3} disabled={disabled}
        onChange={(event) => setCockpitInputForm(childKey, { ...child, note: event.target.value })} /></label>
      {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
      <DialogFooter><DialogClose render={<Button type="button" variant="outline" />}>{t(($) => $.task_create.cancel)}</DialogClose>
        <Button type="button" disabled={disabled || !child.note.trim()} onClick={() => { try { skipCockpitInputNASItem(childKey, child.generation, child.note); setOpen(false); }
          catch (cause) { setError(cause instanceof Error ? cause.message : t(($) => $.input_materials.error_unknown)); } }}>{t(($) => $.input_materials.skip_item)}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
