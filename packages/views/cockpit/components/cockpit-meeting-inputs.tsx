"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  cockpitInputCapabilitiesOptions, cockpitInputDetailOptions, cockpitInputContextPath, cockpitInputDraftKey, cockpitInputReferenceViewKey,
  cockpitMeetingInputReferencesOptions, cockpitAgendaInputReferencesOptions,
  cockpitMeetingAgendaPath, cockpitMeetingInputDraftEntries, emptyCockpitInputForm, EMPTY_COCKPIT_INPUT_REFERENCE_VIEW,
  setCockpitInputForm, useCockpitInputDraftStore, useCockpitInputViewStore, type CockpitMeetingInputDraftEntry,
} from "@multica/core/cockpit";
import type { CockpitInputReference } from "@multica/core/types/cockpit-input";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@multica/ui/components/ui/dialog";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { CockpitInputReferenceBrowser } from "./cockpit-input-reference-browser";
import { CockpitInputSourceForm } from "./cockpit-input-source-form";
import { CockpitInputUploadForm } from "./cockpit-input-upload-form";
import { CockpitInputNASPicker } from "./cockpit-input-nas-picker";
import { CockpitInputNASBatch } from "./cockpit-input-nas-batch";
import { CockpitInputVersionPicker } from "./cockpit-input-version-picker";
import { CockpitInputReferenceForm, CockpitInputReferenceRemove } from "./cockpit-input-reference-form";
import { CockpitFlowError } from "./cockpit-task-flow";
import { CockpitInputEndedRegistrations } from "./cockpit-input-ended-registrations";
import { CockpitInputProblem } from "./cockpit-input-problem";

type InputWorkspaceMode = { scope: string } & (
  | { kind: "upload" | "nas" | "nas-review" | "library" | "source" }
  | { kind: "reference"; versionId: string }
  | { kind: "remove"; referenceId: string; label: string; inputId?: string | null; versionId?: string | null; agendaId?: string | null }
  | { kind: "repair"; childKey: string }
);

export function CockpitMeetingInputs({ wsId, accountId, meetingId, agendaId = null, targetLabel, active = true, readOnly = false }: {
  wsId: string; accountId: string; meetingId: string; agendaId?: string | null; targetLabel: string; active?: boolean; readOnly?: boolean;
}) {
  const { t } = useT("cockpit");
  const navigation = useNavigation();
  const viewKey = cockpitInputReferenceViewKey(wsId, accountId, meetingId, agendaId);
  const view = useCockpitInputViewStore((state) => state.references[viewKey] ?? EMPTY_COCKPIT_INPUT_REFERENCE_VIEW);
  const drafts = useCockpitInputDraftStore((state) => state.draft);
  const entries = cockpitMeetingInputDraftEntries(drafts, wsId, accountId, meetingId).filter((entry) => entry.agendaId === agendaId || entry.kind === "remove-reference");
  const [selectedMode, setSelectedMode] = useState<InputWorkspaceMode | null>(null);
  const mode = selectedMode?.scope === viewKey ? selectedMode : null;
  const accessOptions = agendaId ? cockpitAgendaInputReferencesOptions(wsId, meetingId, agendaId, { pageSize: 1 }) : cockpitMeetingInputReferencesOptions(wsId, meetingId, { pageSize: 1 });
  const access = useQuery({ ...accessOptions, enabled: active || Boolean(mode) });
  const canAdd = !readOnly && !access.isError && access.data?.canAdd === true;
  const capabilities = useQuery({ ...cockpitInputCapabilitiesOptions(wsId), enabled: active || Boolean(mode) });
  const nasKey = cockpitInputDraftKey(wsId, accountId, "nas", meetingId, agendaId || "");
  const nas = drafts.forms[nasKey];
  const close = () => setSelectedMode(null);
  const inspect = (inputId: string, versionId?: string) => {
    close(); navigation.push(cockpitInputContextPath(navigation.pathname, navigation.searchParams, inputId, versionId));
  };
  const open = (kind: "upload" | "nas" | "library" | "source") => {
    if (kind === "nas" && !nas) setCockpitInputForm(nasKey, emptyCockpitInputForm(crypto.randomUUID(), agendaId));
    setSelectedMode({ scope: viewKey, kind: kind === "nas" && nas?.batch ? "nas-review" : kind });
  };
  function resume(entry: CockpitMeetingInputDraftEntry) {
    if (entry.kind === "upload") open("upload");
    if (entry.kind === "source-input") open("source");
    if (entry.kind === "nas") open("nas");
    if (entry.kind === "reference" && entry.targetId) setSelectedMode({ scope: viewKey, kind: "reference", versionId: entry.targetId });
    if (entry.kind === "remove-reference" && entry.targetId) setSelectedMode({ scope: viewKey, kind: "remove", referenceId: entry.targetId, inputId: entry.inputId, versionId: entry.versionId, label: t(($) => $.input_materials.remove_reference) });
  }
  const remove = (reference: CockpitInputReference) => setSelectedMode({ scope: viewKey, kind: "remove", referenceId: reference.id,
    inputId: reference.inputId, versionId: reference.version.id, agendaId: reference.agendaId,
    label: `${reference.inputTitle} · ${t(($) => $.workflow.version, { number: reference.version.versionNumber })} · ${reference.agendaTitle || targetLabel}` });
  const title = mode?.kind === "source" ? t(($) => $.input_materials.choose_source) : mode?.kind === "upload" ? t(($) => $.input_materials.upload) : mode?.kind === "nas" || mode?.kind === "repair" ? t(($) => $.input_materials.choose_nas)
    : mode?.kind === "nas-review" ? t(($) => $.input_materials.review_selection) : mode?.kind === "reference" ? t(($) => $.input_materials.link_version)
      : mode?.kind === "remove" ? t(($) => $.input_materials.remove_reference) : t(($) => $.input_materials.choose_fixed_version);
  return <div className="min-w-0 space-y-3">
    {entries.length > 0 && <details className="space-y-2 rounded-lg border border-border p-3" open={entries.some((entry) => entry.hasPendingCommand || entry.unfinishedItems > 0)}>
      <summary className="cursor-pointer text-caption font-medium">{t(($) => $.input_materials.unfinished_registrations, { count: entries.length })}</summary>
      <ul className="max-h-44 space-y-1 overflow-y-auto">{entries.map((entry) => <li key={entry.key}><Button type="button" variant="ghost" size="sm" onClick={() => resume(entry)}>
        {entry.kind === "upload" ? t(($) => $.input_materials.upload) : entry.kind === "nas" ? t(($) => $.input_materials.choose_nas) : entry.kind === "source-input" ? t(($) => $.input_materials.choose_source) : entry.kind === "remove-reference" ? t(($) => $.input_materials.remove_reference) : t(($) => $.input_materials.link_version)}
        {entry.hasPendingCommand && <> · {t(($) => $.input_materials.command_unconfirmed_short)}</>}
      </Button></li>)}</ul>
    </details>}
    <CockpitInputReferenceBrowser wsId={wsId} meetingId={meetingId} agendaId={agendaId || undefined} active={active} search={view.query} cursors={view.cursors}
      onSearch={(query) => useCockpitInputViewStore.getState().updateReference(viewKey, { query })}
      onPageChange={(cursors) => useCockpitInputViewStore.getState().updateReference(viewKey, { cursors })}
      onInspect={(reference) => inspect(reference.inputId, reference.version.id)} onRemove={readOnly ? undefined : remove}
      toolbar={(page) => <InputToolbar canAdd={page.canAdd && !readOnly}
        uploadAvailable={capabilities.data?.canCreate === true && capabilities.data.directUploadAvailable}
        nasAvailable={capabilities.data?.canCreate === true && capabilities.data.canBrowseNas}
        sourceAvailable={capabilities.data?.canCreate === true} onSource={() => open("source")} onUpload={() => open("upload")} onNAS={() => open("nas")} onLibrary={() => open("library")} />}
    />
    <CockpitInputEndedRegistrations wsId={wsId} accountId={accountId} meetingId={meetingId} agendaId={agendaId || undefined} onInspect={inspect} onResume={(recordAgendaId) => {
      if (recordAgendaId !== agendaId) navigation.push(cockpitMeetingAgendaPath(navigation.pathname, meetingId, recordAgendaId, navigation.searchParams));
      else setSelectedMode({ scope: viewKey, kind: "nas-review" });
    }} />
    {capabilities.isError && <CockpitFlowError onRetry={() => void capabilities.refetch()} />}
    {capabilities.data?.unavailableReason && <CockpitInputProblem codes={[capabilities.data.unavailableReason]} />}
    <Dialog open={Boolean(mode)} onOpenChange={(isOpen) => { if (!isOpen) close(); }}><DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-2xl"><DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
      <div className="min-h-0 overflow-y-auto overscroll-contain pr-1">
        {mode?.kind === "upload" && (capabilities.isPending ? <Spinner /> : capabilities.data ? <CockpitInputUploadForm key={`${viewKey}:upload`} wsId={wsId} accountId={accountId} meetingId={meetingId} agendaId={agendaId}
          targetLabel={targetLabel} capabilities={capabilities.data} canAdd={canAdd} onOpenVersion={inspect} onCancel={close} /> : <CockpitFlowError onRetry={() => void capabilities.refetch()} />)}
        {mode?.kind === "source" && (capabilities.data ? <CockpitInputSourceForm key={`${viewKey}:source`} wsId={wsId} accountId={accountId} meetingId={meetingId} agendaId={agendaId} targetLabel={targetLabel} capabilities={capabilities.data} canAdd={canAdd} onOpenVersion={inspect} onCancel={close} /> : <CockpitFlowError onRetry={() => void capabilities.refetch()} />)}
        {mode?.kind === "nas" && nas && <CockpitInputNASPicker wsId={wsId} draft={nas} disabled={Boolean(nas.batch)} onChange={(patch) => setCockpitInputForm(nasKey, { ...nas, ...patch })} onReview={() => setSelectedMode({ scope: viewKey, kind: "nas-review" })} />}
        {mode?.kind === "nas-review" && <CockpitInputNASBatch wsId={wsId} accountId={accountId} meetingId={meetingId} draftKey={nasKey} targetLabel={targetLabel} canAdd={canAdd}
          onFinished={close} onOpenVersion={inspect} onRepair={(childKey) => setSelectedMode({ scope: viewKey, kind: "repair", childKey })} onBack={() => { if (useCockpitInputDraftStore.getState().draft.forms[nasKey]?.batch) close(); else setSelectedMode({ scope: viewKey, kind: "nas" }); }} />}
        {mode?.kind === "repair" && <CockpitNASSelectionRepair wsId={wsId} childKey={mode.childKey} onInspect={inspect} onDone={() => setSelectedMode({ scope: viewKey, kind: "nas-review" })} />}
        {mode?.kind === "library" && <CockpitInputVersionPicker wsId={wsId} selectedVersionIds={[]} selectionLimit={1} onSelect={(version) => setSelectedMode({ scope: viewKey, kind: "reference", versionId: version.id })} onInspect={inspect} onClose={close} />}
        {mode?.kind === "reference" && <CockpitInputReferenceForm wsId={wsId} accountId={accountId} meetingId={meetingId} agendaId={agendaId} versionId={mode.versionId} targetLabel={targetLabel} canAdd={canAdd} onDone={close} onCancel={close} />}
        {mode?.kind === "remove" && <CockpitInputReferenceRemove wsId={wsId} accountId={accountId} meetingId={meetingId} referenceId={mode.referenceId} inputId={mode.inputId} versionId={mode.versionId} agendaId={mode.agendaId} label={mode.label} onDone={close} onCancel={close} />}
      </div>
    </DialogContent></Dialog>
  </div>;
}

function InputToolbar({ canAdd, uploadAvailable, nasAvailable, sourceAvailable, onSource, onUpload, onNAS, onLibrary }: {
  canAdd: boolean; uploadAvailable: boolean; nasAvailable: boolean; sourceAvailable: boolean; onSource: () => void; onUpload: () => void; onNAS: () => void; onLibrary: () => void;
}) {
  const { t } = useT("cockpit");
  return <div className="flex flex-wrap gap-2"><Button type="button" size="sm" disabled={!canAdd || !uploadAvailable} onClick={onUpload}>{t(($) => $.input_materials.upload)}</Button>
    <Button type="button" variant="outline" size="sm" disabled={!canAdd || !nasAvailable} onClick={onNAS}>{t(($) => $.input_materials.choose_nas)}</Button>
    <Button type="button" variant="outline" size="sm" disabled={!canAdd || !sourceAvailable} onClick={onSource}>{t(($) => $.input_materials.choose_source)}</Button>
    <Button type="button" variant="outline" size="sm" disabled={!canAdd} onClick={onLibrary}>{t(($) => $.input_materials.link_existing)}</Button>
  </div>;
}

export function CockpitNASSelectionRepair({ wsId, childKey, onDone, onInspect }: { wsId: string; childKey: string; onDone: () => void; onInspect: (inputId: string, versionId?: string) => void }) {
  const { t } = useT("cockpit");
  const child = useCockpitInputDraftStore((state) => state.draft.forms[childKey]);
  const pending = useCockpitInputDraftStore((state) => state.draft.commands[childKey]);
  const header = useQuery({ ...cockpitInputDetailOptions(wsId, child?.inputId || ""), enabled: Boolean(child?.inputId) });
  if (!child) return <p role="alert" className="text-caption">{t(($) => $.input_materials.batch_unavailable)}</p>;
  return <section className="space-y-3"><p className="text-caption text-muted-foreground">{t(($) => $.input_materials.reselect_source_hint)}</p>
    {child.inputId && <Button type="button" variant="outline" size="sm" onClick={() => onInspect(child.inputId!, header.data?.currentVersion?.id)}>{t(($) => $.input_materials.open_registered)}</Button>}
    {header.isError && <CockpitFlowError onRetry={() => void header.refetch()} />}
    {header.data && header.data.revision !== child.inputRevision && !child.versionId && <div role="alert" className="space-y-2 rounded-lg border border-border p-3 text-caption"><p>{t(($) => $.input_materials.header_changed)}</p><p className="break-words">{header.data.title}</p>
      <Button type="button" variant="outline" size="sm" disabled={Boolean(pending) || header.isError || !header.data.canSubmit} onClick={() => setCockpitInputForm(childKey, { ...child, inputRevision: header.data!.revision })}>{t(($) => $.input_materials.use_current_header)}</Button></div>}
    <CockpitInputNASPicker wsId={wsId} draft={child} selectionLimit={1} disabled={Boolean(pending) || Boolean(child.versionId)} onChange={(patch) => setCockpitInputForm(childKey, { ...child, ...patch })}
      onReview={() => {
        const selected = child.sourceSelections;
        if (pending || child.versionId || selected.length !== 1) return;
        const source = selected[0]!;
        setCockpitInputForm(childKey, { ...child, source: { kind: "nas_file", nasFile: { rootId: source.rootId, relativePath: source.relativePath, observationToken: source.observationToken }, upload: null, attachment: null, artifactVersion: null } });
        onDone();
      }} />
    {child.sourceSelections.length !== 1 && <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.choose_one_source)}</p>}
    <Button type="button" variant="outline" onClick={onDone}>{t(($) => $.input_materials.return_batch)}</Button>
  </section>;
}
