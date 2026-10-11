"use client";

import { CockpitInputPageFailure } from "./cockpit-input-page-failure";

import { useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@multica/core/api";
import type { CockpitInputVersionMetadata } from "@multica/core/types/cockpit-input";
import { cockpitInputVersionDraftEntries, cockpitInputDraftKey, useCockpitInputDraftStore, cockpitInputCapabilitiesOptions, cockpitInputDetailOptions, cockpitInputVersionOptions, cockpitInputVersionsOptions, useVerifyCockpitInputVersion } from "@multica/core/cockpit";
import { resolvePublicFileUrl } from "@multica/core/workspace/avatar-url";
import { Button } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Markdown } from "@multica/ui/markdown";
import { useLocale, useT } from "../../i18n";
import { CockpitFlowError, CockpitFlowPaging } from "./cockpit-task-flow";
import { CockpitInputVersionSource, CockpitInputVersionSummary } from "./cockpit-input-version-summary";
import { CockpitInputProblem } from "./cockpit-input-problem";
import { CockpitInputUploadForm } from "./cockpit-input-upload-form";
import { useCockpitCommandContext } from "./use-cockpit-command-context";
import { CockpitInputMetadataEditor, CockpitInputArchiveForm } from "./cockpit-input-metadata";
import { CockpitInputDraftReceipt } from "./cockpit-input-draft-receipt";
import { ArtifactStatus } from "./cockpit-artifact-status";

export function CockpitInputDetail({ wsId, inputId, versionId, accountId, onClose, onVersionChange, actions }: {
  wsId: string;
  inputId: string;
  versionId?: string | null;
  accountId: string;
  onClose?: () => void;
  onVersionChange?: (versionId: string) => void;
  actions?: (version: CockpitInputVersionMetadata) => ReactNode;
}) {
  const { t } = useT("cockpit"); const locale = useLocale();
  const scope = JSON.stringify([wsId, accountId, inputId, versionId]);
  const drafts = useCockpitInputDraftStore((state) => state.draft);
  const saved = cockpitInputVersionDraftEntries(drafts, wsId, accountId, inputId);
  const metadataDraft = drafts.forms[cockpitInputDraftKey(wsId, accountId, "input-metadata", inputId)];
  const [editingScope, setEditingScope] = useState<string | null>(null);
  const [archiveIntent, setArchiveIntent] = useState<{ scope: string; archived: boolean; revision: number } | null>(null);
  const [selection, setSelection] = useState<{ scope: string; versionId: string } | null>(null);
  const [addingInScope, setAddingInScope] = useState<string | null>(null);
  const [recoveringInScope, setRecoveringInScope] = useState<string | null>(null);
  const adding = addingInScope === scope;
  const [historyOpen, setHistoryOpen] = useState(false);
  const [cursors, setCursors] = useState([""]);
  const header = useQuery(cockpitInputDetailOptions(wsId, inputId));
  const effectiveVersionId = selection?.scope === scope ? selection.versionId : versionId || header.data?.currentVersion?.id || null;
  const recoveryScope = JSON.stringify([scope, effectiveVersionId]);
  const recovering = recoveringInScope === recoveryScope;
  const detail = useQuery({ ...cockpitInputVersionOptions(wsId, inputId, effectiveVersionId || ""), enabled: Boolean(effectiveVersionId),
    refetchInterval: (query) => query.state.error ? false : query.state.data && (["queued", "capturing"].includes(query.state.data.version.captureState) || query.state.data.version.availability === "checking") ? 2_000 : 60_000 });
  const history = useQuery({ ...cockpitInputVersionsOptions(wsId, inputId, { cursor: cursors.at(-1) || undefined, pageSize: 25 }), enabled: historyOpen });
  const capabilities = useQuery({ ...cockpitInputCapabilitiesOptions(wsId), enabled: adding || recovering });
  const verify = useVerifyCockpitInputVersion(wsId, inputId, effectiveVersionId || "");
  const capture = useCockpitCommandContext(JSON.stringify([scope, effectiveVersionId]));
  const version = detail.data?.version;
  const download = useMutation({ mutationKey: ["cockpit-input-download", wsId, inputId, effectiveVersionId], retry: false,
    mutationFn: async () => {
      if (!version || !version.canDownload || version.payloadKind !== "file" || version.captureState !== "ready" || version.availability !== "available") return;
      const stillCurrent = capture();
      const link = await api.getCockpitInputDownloadLink(wsId, inputId, version.id);
      if (!stillCurrent()) return;
      if (!link || link.contentHash !== version.contentHash || link.sizeBytes !== version.sizeBytes) throw new Error("input_download_unconfirmed");
      const address = resolvePublicFileUrl(link.url);
      if (!address) throw new Error("input_download_unconfirmed");
      const url = new URL(address, window.location.href);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("input_download_unconfirmed");
      const anchor = document.createElement("a"); anchor.href = url.toString(); anchor.download = version.filename; anchor.rel = "noopener";
      document.body.append(anchor); anchor.click(); anchor.remove();
    },
  });
  const chooseVersion = (id: string) => { setAddingInScope(null); setRecoveringInScope(null); if (onVersionChange) onVersionChange(id); else setSelection({ scope, versionId: id }); };

  if (header.isPending) return <p role="status" className="flex items-center gap-2 text-caption"><Spinner aria-hidden="true" />{t(($) => $.workflow.loading)}</p>;
  if (header.isError || !header.data) return <div className="space-y-3"><CockpitFlowError onRetry={() => void header.refetch()} />{saved.filter((entry) => entry.hasPendingCommand).map((entry) => <CockpitInputDraftReceipt key={entry.key} wsId={wsId} draftKey={entry.key} onConfirmed={() => void header.refetch()} />)}{onClose && <Button type="button" variant="outline" onClick={onClose}>{t(($) => $.input_materials.manifest_close)}</Button>}</div>;
  if (editingScope === scope) return <CockpitInputMetadataEditor key={`${wsId}:${accountId}:${inputId}:metadata`} wsId={wsId} accountId={accountId} input={header.data} onDone={() => setEditingScope(null)} onRefresh={() => void header.refetch()} />;
  if (archiveIntent?.scope === scope) return <CockpitInputArchiveForm key={`${wsId}:${accountId}:${inputId}:${archiveIntent.archived}`} wsId={wsId} input={header.data} archived={archiveIntent.archived} observedRevision={archiveIntent.revision} onDone={() => setArchiveIntent(null)} onRefresh={() => void header.refetch()} />;
  if (adding) return <section className="space-y-4"><h3 className="text-title-sm font-medium">{t(($) => $.input_materials.submit_new_version)}</h3>
    <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.new_version_relationship_hint)}</p>
    {capabilities.isPending ? <Spinner /> : capabilities.isError || !capabilities.data ? <CockpitFlowError onRetry={() => void capabilities.refetch()} />
      : <CockpitInputUploadForm key={`${wsId}:${accountId}:${inputId}`} wsId={wsId} accountId={accountId} existingInput={header.data} targetLabel={header.data.title}
        capabilities={capabilities.data} canAdd={header.data.canSubmit} onOpenVersion={(_input, id) => { setAddingInScope(null); if (id) chooseVersion(id); }} onCancel={() => setAddingInScope(null)} />}
    {!capabilities.data && <Button type="button" variant="outline" onClick={() => setAddingInScope(null)}>{t(($) => $.input_materials.return_materials)}</Button>}
  </section>;
  if (recovering && version) return <section className="space-y-4"><h3 className="text-title-sm font-medium">{t(($) => $.input_materials.recover_version)}</h3>
    {capabilities.isPending ? <Spinner /> : capabilities.isError || !capabilities.data ? <CockpitFlowError onRetry={() => void capabilities.refetch()} />
      : <CockpitInputUploadForm key={`${wsId}:${accountId}:${inputId}:${version.id}`} wsId={wsId} accountId={accountId} existingInput={header.data} recoveryVersion={version} targetLabel={header.data.title}
        capabilities={capabilities.data} canAdd={false} onOpenVersion={(_input, id) => { setRecoveringInScope(null); if (id) chooseVersion(id); }} onCancel={() => setRecoveringInScope(null)} />}
    {!capabilities.data && <Button type="button" variant="outline" onClick={() => setRecoveringInScope(null)}>{t(($) => $.input_materials.return_materials)}</Button>}
  </section>;
  return <section className="min-w-0 space-y-4" aria-label={t(($) => $.input_materials.material_detail)}>
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-2"><h2 className="min-w-0 flex-1 break-words text-title-sm font-medium [overflow-wrap:anywhere]">{header.data.title}</h2>
      {onClose && <Button type="button" variant="outline" size="sm" onClick={onClose}>{t(($) => $.input_materials.manifest_close)}</Button>}
    </div>
    {saved.length > 0 && <div className="space-y-2 rounded-lg border border-border p-3"><p className="text-caption">{t(($) => $.input_materials.unfinished_registrations, { count: saved.length })}</p>{saved.map((entry) => <Button key={entry.key} type="button" size="sm" variant="outline" onClick={() => {
      if (entry.kind === "input-version") setAddingInScope(scope);
      else if (entry.versionId) { setSelection({ scope, versionId: entry.versionId }); setRecoveringInScope(JSON.stringify([scope, entry.versionId])); }
    }}>{entry.kind === "input-version" ? t(($) => $.input_materials.submit_new_version) : t(($) => $.input_materials.recover_version)}{entry.hasPendingCommand && <> · {t(($) => $.input_materials.command_unconfirmed_short)}</>}</Button>)}</div>}
    {header.data.archivedAt && <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.archived)}</p>}
    {header.data.description && <details className="text-caption"><summary className="cursor-pointer text-muted-foreground">{t(($) => $.input_materials.description_optional)}</summary><p className="mt-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{header.data.description}</p></details>}
    <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" disabled={!header.data.canEdit && !metadataDraft} onClick={() => setEditingScope(scope)}>{metadataDraft ? t(($) => $.input_materials.resume_metadata) : t(($) => $.input_materials.edit_metadata)}</Button>
      <Button type="button" variant="ghost" size="sm" disabled={header.data.archivedAt ? !header.data.canUnarchive : !header.data.canArchive} onClick={() => setArchiveIntent({ scope, archived: !header.data!.archivedAt, revision: header.data!.revision })}>{header.data.archivedAt ? t(($) => $.input_materials.unarchive) : t(($) => $.input_materials.archive)}</Button></div>
    <CockpitInputProblem codes={header.data.blockedReasons} />
    {header.data.canSubmit && <Button type="button" variant="outline" size="sm" onClick={() => setAddingInScope(scope)}>{t(($) => $.input_materials.submit_new_version)}</Button>}
    {effectiveVersionId ? detail.isPending ? <Spinner /> : detail.isError || !detail.data || !version ? <CockpitFlowError onRetry={() => void detail.refetch()} /> : <>
      <div role="status" aria-live="polite"><CockpitInputVersionSummary version={version} /></div>
      {version.checkedAt && Number.isFinite(Date.parse(version.checkedAt)) && <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.last_checked, { time: new Date(version.checkedAt).toLocaleString(locale) })}</p>}
      {version.source.kind === "artifact_version" && <ArtifactStatus status={version.source.artifactDecision ?? "unknown"} />}
      {header.data.currentVersion && header.data.currentVersion.id !== version.id && <div className="flex flex-wrap items-center gap-2 text-caption"><p>{t(($) => $.input_materials.historical_version)}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => chooseVersion(header.data!.currentVersion!.id)}>{t(($) => $.input_materials.view_latest)}</Button>
      </div>}
      <div className="flex flex-wrap gap-2">
        {version.payloadKind === "file" && version.captureState === "ready" && version.availability === "available" && version.canDownload && <Button type="button" size="sm" disabled={download.isPending} aria-busy={download.isPending} onClick={() => download.mutate()}>{download.isPending && <Spinner aria-hidden="true" />}{t(($) => $.input_materials.download_version)}</Button>}
        {version.canVerify && <Button type="button" variant="outline" size="sm" disabled={verify.isPending} aria-busy={verify.isPending} onClick={() => verify.mutate()}>{verify.isPending && <Spinner aria-hidden="true" />}{t(($) => $.input_materials.verify_version)}</Button>}
        {(version.latestTransferId || version.allowedRestartModes.some((mode) => mode === "retry_source" || mode === "upload_matching_bytes")) && <Button type="button" variant="outline" size="sm" onClick={() => setRecoveringInScope(recoveryScope)}>
          {version.captureState !== "ready" || version.allowedRestartModes.length > 0 ? t(($) => $.input_materials.recover_version) : t(($) => $.input_materials.view_transfer_record)}
        </Button>}
        <Button type="button" variant="ghost" size="sm" disabled={detail.isFetching} onClick={() => void detail.refetch()}>{t(($) => $.input_materials.refresh_version)}</Button>
      </div>
      {download.isError && <p role="alert" className="text-caption text-destructive">{t(($) => $.artifacts.download_failed)}</p>}
      {verify.isError && <p role="alert" className="text-caption text-destructive">{t(($) => $.input_materials.verification_failed)}</p>}
      <CockpitInputProblem codes={[...version.blockedReasons, ...(version.captureErrorCode ? [version.captureErrorCode] : []),
        ...(version.availability === "unavailable" ? [version.unavailableReason || "input_unavailable"] : [])]} />
      {version.captureState === "ready" && version.availability === "available" && version.payloadKind === "text" && detail.data.content !== null && <div className="max-h-[55dvh] min-w-0 overflow-auto break-words"><Markdown mode="full">{detail.data.content}</Markdown></div>}
      <CockpitInputVersionSource version={version} />
      {actions && <div className="space-y-2"><p className="text-caption text-muted-foreground">{t(($) => $.input_materials.view_does_not_replace)}</p><div className="flex flex-wrap gap-2">{actions(version)}</div></div>}
    </> : <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.no_versions)}</p>}
    <details className="space-y-3" onToggle={(event) => setHistoryOpen(event.currentTarget.open)}><summary className="cursor-pointer text-caption">{t(($) => $.input_materials.version_history)}</summary>
      {historyOpen && (history.isPending ? <Spinner /> : history.isError || !history.data ? <CockpitInputPageFailure onRetry={() => void history.refetch()} onFirstPage={cursors.length > 1 ? () => setCursors([""]) : undefined} /> : <>
        <ul className="max-h-64 space-y-1 overflow-y-auto">{history.data.items.map((item) => <li key={item.id}><Button type="button" variant={item.id === effectiveVersionId ? "secondary" : "ghost"} aria-pressed={item.id === effectiveVersionId}
          className="h-auto w-full justify-start whitespace-normal text-left" onClick={() => chooseVersion(item.id)}><CockpitInputVersionSummary version={item} /></Button></li>)}</ul>
        <CockpitFlowPaging page={cursors.length} shown={history.data.items.length} total={history.data.total} hasNext={Boolean(history.data.nextCursor)} busy={history.isFetching}
          onPrevious={() => setCursors(cursors.slice(0, -1))} onNext={() => { if (history.data.nextCursor) setCursors([...cursors, history.data.nextCursor]); }} />
      </>)}
    </details>
  </section>;
}
