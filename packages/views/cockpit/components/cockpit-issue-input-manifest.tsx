"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core";
import { useAuthStore } from "@multica/core/auth";
import {
  cockpitContextOptions, cockpitIssueInputManifestPath, EMPTY_COCKPIT_SCOPE, cockpitIssueInputManifestOptions, cockpitInputManifestEditItemsOptions,
  cockpitInputDraftKey, emptyCockpitInputForm, setCockpitInputForm, clearCockpitInputForm, useCockpitInputDraftStore,
  cockpitInputSelectedVersionsOptions, cockpitInputSelectedHeadersOptions, type CockpitInputFormDraft,
} from "@multica/core/cockpit";
import type { CockpitInputManifestHeader, CockpitInputManifestItem } from "@multica/core/types/cockpit-input";
import { Button } from "@multica/ui/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@multica/ui/components/ui/dialog";
import { toast } from "sonner";
import { useT } from "../../i18n";
import { useNavigation } from "../../navigation";
import { CockpitInputManifestHistory } from "./cockpit-input-manifest-history";
import { CockpitFlowError, CockpitFlowPaging } from "./cockpit-task-flow";
import { CockpitInputManifestItems } from "./cockpit-input-manifest-items";
import { CockpitInputVersionPicker } from "./cockpit-input-version-picker";
import { CockpitInputDetail } from "./cockpit-input-detail";
import { CockpitInputCommandRecovery } from "./cockpit-input-command-recovery";
import { useCockpitInputRequest } from "./use-cockpit-input-request";
import { CockpitInputRunLaunch } from "./cockpit-input-run-launch";
import { CockpitInputProblem } from "./cockpit-input-problem";

export function CockpitIssueInputManifest({ issueId }: { issueId: string }) {
  const wsId = useWorkspaceId();
  const accountId = useAuthStore((state) => state.user?.id);
  const context = useQuery(cockpitContextOptions(wsId, EMPTY_COCKPIT_SCOPE));
  if (!accountId || context.data?.capabilities?.run_input_manifests !== true) return null;
  return <CockpitIssueInputManifestPanel key={`${wsId}:${accountId}:${issueId}`} wsId={wsId} accountId={accountId} issueId={issueId} />;
}

/** Mounted by the Issue page outside its collapsible properties sidebar. */
export function CockpitIssueInputManifestInspector({ issueId }: { issueId: string }) {
  const wsId = useWorkspaceId(); const accountId = useAuthStore((state) => state.user?.id);
  const navigation = useNavigation(); const exactId = navigation.searchParams.get("input_manifest");
  if (!accountId || !exactId) return null;
  return <CockpitInputManifestHistory key={`${wsId}:${accountId}:${issueId}`} wsId={wsId} accountId={accountId} issueId={issueId} manifestVersionId={exactId}
    onSelect={(id) => navigation.push(cockpitIssueInputManifestPath(navigation.pathname, navigation.searchParams, id))}
    onClose={() => navigation.push(cockpitIssueInputManifestPath(navigation.pathname, navigation.searchParams, null))} />;
}

export function CockpitIssueInputManifestPanel({ wsId, accountId, issueId, suggestedVersionId }: { wsId: string; accountId: string; issueId: string; suggestedVersionId?: string }) {
  const { t } = useT("cockpit");
  const header = useQuery(cockpitIssueInputManifestOptions(wsId, issueId));
  const key = cockpitInputDraftKey(wsId, accountId, "manifest", issueId);
  const savedDraft = useCockpitInputDraftStore((state) => Boolean(state.draft.forms[key] || state.draft.commands[key]));
  const [editing, setEditing] = useState(Boolean(suggestedVersionId));
  const [inspected, setInspected] = useState<{ inputId: string; versionId?: string } | null>(null);
  const [history, setHistory] = useState<{ versionId: string | null } | null>(null);
  return <section className="min-w-0 space-y-3" aria-label={t(($) => $.input_materials.manifest_title)}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-caption font-medium">{t(($) => $.input_materials.manifest_title)}</h3>
      <Button type="button" variant="outline" size="sm" disabled={!savedDraft && header.data?.canEdit !== true} onClick={() => setEditing(true)}>{savedDraft ? t(($) => $.input_materials.resume_saved) : t(($) => $.input_materials.manifest_edit)}</Button></div>
    {header.isPending ? <p role="status" className="text-caption">{t(($) => $.workflow.loading)}</p> : header.isError || !header.data ? <CockpitFlowError onRetry={() => void header.refetch()} /> : <>
      <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.manifest_count, { count: header.data.counts.total, required: header.data.counts.required })}</p>
      {header.data.counts.required > 0 && <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.manifest_availability, { available: header.data.counts.availableRequired, unknown: header.data.counts.unknownRequired, unavailable: header.data.counts.unavailableRequired })}</p>}
      {header.data.currentVersion ? <CockpitInputManifestItems key={header.data.currentVersion.id} wsId={wsId} version={header.data.currentVersion} onInspect={(inputId, versionId) => setInspected({ inputId, versionId })} /> : <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.manifest_empty)}</p>}
      <Button type="button" variant="ghost" size="sm" onClick={() => setHistory({ versionId: null })}>{t(($) => $.input_materials.manifest_history)}</Button>
      <CockpitInputProblem codes={header.data.blockedReasons} />
      <CockpitInputRunLaunch wsId={wsId} accountId={accountId} header={header.data} hasDraft={savedDraft} onRefresh={() => void header.refetch()} onInspect={(inputId, versionId) => setInspected({ inputId, versionId })} />
    </>}
    {history && <CockpitInputManifestHistory wsId={wsId} accountId={accountId} issueId={issueId} manifestVersionId={history.versionId} onSelect={(versionId) => setHistory({ versionId })} onClose={() => setHistory(null)} />}
    <Dialog open={editing} onOpenChange={setEditing}><DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-3xl"><DialogHeader><DialogTitle>{t(($) => $.input_materials.manifest_edit)}</DialogTitle></DialogHeader>
      <div className="min-h-0 overflow-y-auto overscroll-contain">{editing && <CockpitManifestEditorLoader wsId={wsId} accountId={accountId} issueId={issueId} suggestedVersionId={suggestedVersionId} header={header.isError ? undefined : header.data} onReload={() => void header.refetch()} onDone={() => setEditing(false)} onInspect={(inputId, versionId) => setInspected({ inputId, versionId })} />}</div>
    </DialogContent></Dialog>
    <Dialog open={Boolean(inspected)} onOpenChange={(open) => { if (!open) setInspected(null); }}><DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl"><DialogHeader><DialogTitle>{t(($) => $.input_materials.material_detail)}</DialogTitle></DialogHeader>
      {inspected && <CockpitInputDetail key={inspected.inputId} wsId={wsId} accountId={accountId} {...inspected} onVersionChange={(versionId) => setInspected({ ...inspected, versionId })}
        actions={() => <Button type="button" variant="outline" size="sm" onClick={() => { setInspected(null); setEditing(true); }}>{t(($) => $.input_materials.manifest_edit)}</Button>} />}
    </DialogContent></Dialog>
  </section>;
}

function CockpitManifestEditorLoader({ wsId, accountId, issueId, suggestedVersionId, header, onReload, onDone, onInspect }: {
  wsId: string; accountId: string; issueId: string; suggestedVersionId?: string; header?: CockpitInputManifestHeader; onReload: () => void; onDone: () => void; onInspect: (inputId: string, versionId?: string) => void;
}) {
  const { t } = useT("cockpit");
  const key = cockpitInputDraftKey(wsId, accountId, "manifest", issueId);
  const stored = useCockpitInputDraftStore((state) => state.draft.forms[key]);
  const pending = useCockpitInputDraftStore((state) => state.draft.commands[key]);
  const full = useQuery({ ...cockpitInputManifestEditItemsOptions(wsId, issueId, header?.currentVersion ?? null), enabled: Boolean(header && !stored && !pending) });
  if (!stored && !pending && (!header || full.isPending)) return <p role="status" className="text-caption">{t(($) => $.input_materials.manifest_loading_selection)}</p>;
  if (!stored && !pending && (full.isError || !full.data)) return <CockpitFlowError onRetry={() => { onReload(); void full.refetch(); }} />;
  return <CockpitManifestEditor wsId={wsId} accountId={accountId} issueId={issueId} suggestedVersionId={suggestedVersionId} header={header} initialItems={full.data ?? []} onReload={onReload} onDone={onDone} onInspect={onInspect} />;
}

function CockpitManifestEditor({ wsId, accountId, issueId, suggestedVersionId, header, initialItems, onReload, onDone, onInspect }: {
  wsId: string; accountId: string; issueId: string; suggestedVersionId?: string; header?: CockpitInputManifestHeader; initialItems: CockpitInputManifestItem[]; onReload: () => void; onDone: () => void; onInspect: (inputId: string, versionId?: string) => void;
}) {
  const { t } = useT("cockpit");
  const key = cockpitInputDraftKey(wsId, accountId, "manifest", issueId);
  const initial = useRef<CockpitInputFormDraft>({ ...emptyCockpitInputForm(crypto.randomUUID()), observedRevision: header?.revision ?? null,
    manifestItems: initialItems.map((item) => ({ inputVersionId: item.inputVersionId, purpose: item.purpose, required: item.required })) });
  const stored = useCockpitInputDraftStore((state) => state.draft.forms[key]);
  const draft = stored ?? initial.current;
  const request = useCockpitInputRequest(wsId, key);
  const [picking, setPicking] = useState(false);
  const [page, setPage] = useState(0);
  const ids = draft.manifestItems.map((item) => item.inputVersionId);
  const selected = useQuery(cockpitInputSelectedVersionsOptions(wsId, suggestedVersionId && !ids.includes(suggestedVersionId) && ids.length < 200 ? [...ids, suggestedVersionId] : ids));
  const selectedHeaders = useQuery(cockpitInputSelectedHeadersOptions(wsId, [...new Set((selected.data?.items ?? []).map((item) => item.inputId))]));
  const selectedTitle = (version: { inputId: string; filename: string; source: { artifactTitle: string } }) => selectedHeaders.data?.items.find((item) => item.id === version.inputId)?.title || version.filename || version.source.artifactTitle || t(($) => $.input_materials.material_detail);
  const suggested = selected.data?.items.find((item) => item.id === suggestedVersionId);
  const priorVersion = suggested && selected.data?.items.find((item) => item.inputId === suggested.inputId && item.id !== suggested.id && ids.includes(item.id));
  const purposeNames: Record<string, string> = { material: t(($) => $.input_materials.purpose_material), recording: t(($) => $.input_materials.purpose_recording), supporting: t(($) => $.input_materials.purpose_supporting) };
  const validPurposes = draft.manifestItems.every((item) => Object.hasOwn(purposeNames, item.purpose));
  const changed = Boolean(header && draft.observedRevision !== header.revision);
  const locked = request.busy || Boolean(request.pending);
  const allowed = header?.canEdit === true && draft.observedRevision !== null;
  const allReady = !selected.isError && ids.every((id) => { const version = selected.data?.items.find((item) => item.id === id); return version?.canReference && version.captureState === "ready" && version.contentHash && version.sizeBytes !== null; });
  const maxPage = Math.max(0, Math.ceil(ids.length / 25) - 1); const currentPage = Math.min(page, maxPage);
  const update = (patch: Partial<CockpitInputFormDraft>) => setCockpitInputForm(key, { ...draft, ...patch });
  async function submit(mode: "submit" | "lookup") {
    if (request.busy || !request.pending && (!allowed || changed || !allReady || !validPurposes || selected.isFetching)) return;
    setCockpitInputForm(key, draft);
    const result = mode === "lookup" ? await request.verify() : await request.run(request.pending ?? { kind: "manifest", issueId,
      body: { commandKey: crypto.randomUUID(), expectedRevision: draft.observedRevision!, items: draft.manifestItems, note: draft.note } });
    if (result?.acknowledged.kind === "manifest") { clearCockpitInputForm(key, draft); if (result.stillCurrent()) { toast.success(t(($) => $.input_materials.manifest_saved)); onDone(); } }
  }
  return <section className="space-y-4">
    <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.manifest_save_effect)}</p>
    {suggestedVersionId && <div className="space-y-2 rounded-lg border border-border p-3 text-caption">
      {suggested && <p className="break-words">{selectedTitle(suggested)} · {t(($) => $.workflow.version, { number: suggested.versionNumber })}</p>}
      {priorVersion && <p className="text-muted-foreground">{t(($) => $.input_materials.manifest_other_version)}</p>}
      {ids.includes(suggestedVersionId) ? <Button type="button" size="sm" variant="outline" onClick={() => { setPicking(false); setPage(Math.floor(ids.indexOf(suggestedVersionId) / 25)); }}>{t(($) => $.input_materials.manifest_locate_selected)}</Button>
        : <Button type="button" size="sm" variant="outline" disabled={locked || !allowed || selected.isError || selected.isFetching || ids.length >= 200 || !suggested?.canReference || suggested.captureState !== "ready"} onClick={() => { update({ manifestItems: [...draft.manifestItems, { inputVersionId: suggestedVersionId, purpose: "material", required: true }] }); setPage(Math.floor(ids.length / 25)); }}>{t(($) => $.input_materials.manifest_add_suggested)}</Button>}
      {!suggested && !selected.isFetching && <p>{ids.length >= 200 ? t(($) => $.input_materials.selection_limit, { limit: 200 }) : t(($) => $.input_materials.manifest_missing)}</p>}
    </div>}
    {picking ? <CockpitInputVersionPicker wsId={wsId} selectedVersionIds={ids} disabled={locked || !allowed} onClose={() => setPicking(false)} onInspect={onInspect}
      onSelect={(version) => { if (ids.includes(version.id) || ids.length >= 200) return; update({ manifestItems: [...draft.manifestItems, { inputVersionId: version.id, purpose: "material", required: true }] }); }} /> : <>
      <Button type="button" variant="outline" disabled={locked || !allowed || ids.length >= 200} onClick={() => setPicking(true)}>{t(($) => $.input_materials.manifest_choose)}</Button>
      {selected.isError && <CockpitFlowError onRetry={() => void selected.refetch()} />}
      {selectedHeaders.isError && <CockpitFlowError onRetry={() => void selectedHeaders.refetch()} />}
      <ol className="max-h-[45dvh] space-y-3 overflow-y-auto overscroll-contain" start={currentPage * 25 + 1}>{draft.manifestItems.slice(currentPage * 25, currentPage * 25 + 25).map((item, localIndex) => {
        const index = currentPage * 25 + localIndex; const version = selected.data?.items.find((entry) => entry.id === item.inputVersionId);
        const move = (offset: number) => { const items = [...draft.manifestItems]; const other = items[index + offset]; if (!other) return; items[index] = other; items[index + offset] = item; update({ manifestItems: items }); setPage(Math.floor((index + offset) / 25)); };
        return <li key={item.inputVersionId} className="space-y-2 rounded-lg border border-border p-3">
          <div className="flex flex-wrap justify-between gap-2"><p className="min-w-0 break-words text-caption font-medium [overflow-wrap:anywhere]">{index + 1}. {version ? `${selectedTitle(version)} · ${t(($) => $.workflow.version, { number: version.versionNumber })}` : t(($) => $.input_materials.manifest_missing)}</p>
            {version && <Button type="button" variant="ghost" size="xs" onClick={() => onInspect(version.inputId, version.id)}>{t(($) => $.input_materials.manifest_inspect)}</Button>}</div>
          <label className="block space-y-1 text-caption"><span>{t(($) => $.input_materials.manifest_purpose)}</span>
            <Select value={Object.hasOwn(purposeNames, item.purpose) ? item.purpose : null} disabled={locked || !allowed} items={purposeNames}
              onValueChange={(purpose) => { if (purpose && Object.hasOwn(purposeNames, purpose)) update({ manifestItems: draft.manifestItems.map((entry, n) => n === index ? { ...entry, purpose } : entry) }); }}>
              <SelectTrigger className="w-full" aria-label={t(($) => $.input_materials.manifest_purpose)}><SelectValue placeholder={t(($) => $.input_materials.manifest_purpose)} /></SelectTrigger>
              <SelectContent>{Object.entries(purposeNames).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
            </Select>
          </label>
          {!Object.hasOwn(purposeNames, item.purpose) && <p role="alert" className="break-words text-caption text-destructive">{t(($) => $.input_materials.unknown_purpose)}{item.purpose ? ` · ${item.purpose}` : ""}</p>}
          <label className="flex items-center gap-2 text-caption"><input type="checkbox" checked={item.required} disabled={locked || !allowed} onChange={(event) => update({ manifestItems: draft.manifestItems.map((entry, n) => n === index ? { ...entry, required: event.target.checked } : entry) })} />{t(($) => $.input_materials.manifest_required)}</label>
          {version && version.availability !== "available" && <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.manifest_missing)}</p>}
          <div className="flex flex-wrap gap-1"><Button type="button" size="xs" variant="outline" disabled={locked || !allowed || index === 0} onClick={() => move(-1)}>{t(($) => $.input_materials.manifest_move_up)}</Button>
            <Button type="button" size="xs" variant="outline" disabled={locked || !allowed || index === ids.length - 1} onClick={() => move(1)}>{t(($) => $.input_materials.manifest_move_down)}</Button>
            <Button type="button" size="xs" variant="ghost" disabled={locked || !allowed} onClick={() => update({ manifestItems: draft.manifestItems.filter((_, n) => n !== index) })}>{t(($) => $.input_materials.manifest_remove)}</Button></div>
        </li>;
      })}</ol>
      {ids.length === 0 && <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.manifest_empty)}</p>}
      {ids.length > 25 && <CockpitFlowPaging page={currentPage + 1} shown={Math.min(25, ids.length - currentPage * 25)} total={ids.length} hasNext={currentPage < maxPage} busy={false} onPrevious={() => setPage(currentPage - 1)} onNext={() => setPage(currentPage + 1)} />}
    </>}
    <label className="block space-y-1 text-caption">{t(($) => $.input_materials.manifest_note)}<Textarea value={draft.note} maxLength={16000} disabled={locked || !allowed} onChange={(event) => update({ note: event.target.value })} /></label>
    {changed && <div role="alert" className="space-y-2 rounded-lg border border-border p-3 text-caption"><p>{t(($) => $.input_materials.manifest_changed)}</p>
      {header?.currentVersion && <CockpitInputManifestItems key={header.currentVersion.id} wsId={wsId} version={header.currentVersion} onInspect={onInspect} />}
      <Button type="button" size="sm" variant="outline" disabled={locked || !header?.canEdit} onClick={() => update({ observedRevision: header?.revision ?? null })}>{t(($) => $.input_materials.manifest_rebase)}</Button></div>}
    {header && <CockpitInputProblem codes={header.blockedReasons} />}
    <CockpitInputCommandRecovery pending={Boolean(request.pending)} busy={request.busy} canRetry={request.canRetry} onVerify={() => void submit("lookup")} onRetry={() => void submit("submit")} />
    {request.error && <div role="alert" className="space-y-2 text-caption text-destructive"><p className="break-words">{request.error}</p><Button type="button" size="sm" variant="outline" onClick={onReload}>{t(($) => $.input_materials.refresh_version)}</Button></div>}
    <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" onClick={onDone}>{t(($) => $.input_materials.manifest_close)}</Button>
      <Button type="button" disabled={locked || !allowed || changed || !allReady || !validPurposes || selected.isFetching} onClick={() => void submit("submit")}>{t(($) => $.input_materials.manifest_save)}</Button></div>
  </section>;
}
