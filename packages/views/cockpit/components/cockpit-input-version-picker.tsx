"use client";

import { CockpitInputPageFailure } from "./cockpit-input-page-failure";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cockpitInputDetailOptions, cockpitInputsOptions, cockpitInputVersionsOptions } from "@multica/core/cockpit";
import type { CockpitInputVersionMetadata } from "@multica/core/types/cockpit-input";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useLocale, useT } from "../../i18n";
import { CockpitFlowError, CockpitFlowPaging, useCockpitSearch } from "./cockpit-task-flow";
import { CockpitInputVersionSource, CockpitInputVersionSummary } from "./cockpit-input-version-summary";
import { ArtifactStatus } from "./cockpit-artifact-status";
import { CockpitInputProblem } from "./cockpit-input-problem";

export function CockpitInputVersionPicker({ wsId, selectedVersionIds, selectionLimit = 200, disabled, onSelect, onInspect, onClose }: {
  wsId: string;
  selectedVersionIds: string[];
  selectionLimit?: number;
  disabled?: boolean;
  onSelect: (version: CockpitInputVersionMetadata) => void;
  onInspect?: (inputId: string, versionId?: string) => void;
  onClose?: () => void;
}) {
  const { t } = useT("cockpit"); const locale = useLocale();
  const [search, setSearch] = useState("");
  const q = useCockpitSearch(search);
  const [cursors, setCursors] = useState([""]);
  const [inputId, setInputId] = useState<string | null>(null);
  const [versionCursors, setVersionCursors] = useState([""]);
  const [archived, setArchived] = useState(false);
  const changing = q !== search.trim();
  const inputs = useQuery({ ...cockpitInputsOptions(wsId, { q, archive: archived ? "all" : "active", pageSize: 25, cursor: cursors.at(-1) || undefined }), enabled: !inputId && !changing });
  const header = useQuery({ ...cockpitInputDetailOptions(wsId, inputId || ""), enabled: Boolean(inputId) });
  const versions = useQuery({ ...cockpitInputVersionsOptions(wsId, inputId || "", { pageSize: 25, cursor: versionCursors.at(-1) || undefined }), enabled: Boolean(inputId) });
  const page = inputs.data;
  const versionPage = versions.data;
  const inputMatches = page && page.workspaceId === wsId && page.scope.q === q && page.scope.archive === (archived ? "all" : "active");
  const versionMatches = versionPage && versionPage.workspaceId === wsId && versionPage.inputId === inputId;

  return <section className="min-w-0 space-y-4" aria-label={t(($) => $.input_materials.choose_fixed_version)}>
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-caption tabular-nums">{t(($) => $.input_materials.selection_count, { count: selectedVersionIds.length, limit: selectionLimit })}</p>
      {onClose && <Button type="button" variant="outline" size="sm" onClick={onClose}>{t(($) => $.input_materials.done_selecting)}</Button>}
    </div>
    {inputId ? <>
      <Button type="button" variant="outline" size="sm" onClick={() => setInputId(null)}>{t(($) => $.input_materials.back_to_library)}</Button>
      {header.data && <h3 className="break-words text-title-sm font-medium [overflow-wrap:anywhere]">{header.data.title}</h3>}
      {onInspect && <Button type="button" variant="outline" size="sm" onClick={() => onInspect(inputId)}>{t(($) => $.input_materials.open_registered)}</Button>}
      {header.isError && <CockpitFlowError onRetry={() => void header.refetch()} />}
      {versions.isPending ? <p role="status" className="flex items-center gap-2 text-caption"><Spinner aria-hidden="true" />{t(($) => $.workflow.loading)}</p>
        : versions.isError || !versionMatches || !versionPage ? <CockpitInputPageFailure onRetry={() => void versions.refetch()} onFirstPage={versionCursors.length > 1 ? () => setVersionCursors([""]) : undefined} /> : <>
          <ul className="max-h-[48dvh] min-w-0 space-y-3 overflow-y-auto overscroll-contain">{versionPage.items.map((version) => {
            const selected = selectedVersionIds.includes(version.id);
            const eligible = version.canReference && version.captureState === "ready" && version.contentHash !== null && version.sizeBytes !== null
              && ["file", "text"].includes(version.payloadKind) && ["upload", "nas_file", "attachment", "artifact_version"].includes(version.source.kind);
            return <li key={version.id} className="min-w-0 space-y-3 rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2"><CockpitInputVersionSummary version={version} />
                <Button type="button" variant={selected ? "secondary" : "outline"} size="sm" disabled={disabled || selected || !eligible || selectedVersionIds.length >= selectionLimit}
                  aria-label={t(($) => $.input_materials.select_version_named, { name: header.data?.title || version.filename, number: version.versionNumber })}
                  onClick={() => onSelect(version)}>{selected ? t(($) => $.input_materials.version_selected) : t(($) => $.input_materials.select_version)}</Button>
              </div>
              {version.source.kind === "artifact_version" && <ArtifactStatus status={version.source.artifactDecision ?? "unknown"} />}
              {!eligible && <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.version_not_selectable)}</p>}
              {onInspect && <Button type="button" variant="ghost" size="sm" onClick={() => onInspect(version.inputId, version.id)}>{t(($) => $.input_materials.view_version)}</Button>}
              {version.blockedReasons.length > 0 && <CockpitInputProblem codes={version.blockedReasons} />}
              <CockpitInputVersionSource version={version} />
            </li>;
          })}</ul>
          {versionPage.items.length === 0 && <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.no_versions)}</p>}
          <CockpitFlowPaging page={versionCursors.length} shown={versionPage.items.length} total={versionPage.total} hasNext={Boolean(versionPage.nextCursor)} busy={versions.isFetching}
            onPrevious={() => setVersionCursors(versionCursors.slice(0, -1))} onNext={() => { if (versionPage.nextCursor) setVersionCursors([...versionCursors, versionPage.nextCursor]); }} />
        </>}
    </> : <>
      <label className="block space-y-1 text-caption"><span>{t(($) => $.input_materials.search_library)}</span><Input name="input_library_search" placeholder={t(($) => $.input_materials.name_prefix)} type="search" autoComplete="off" value={search}
        onChange={(event) => { setSearch(event.target.value); setCursors([""]); }} /></label>
      <label className="flex items-center gap-2 text-caption"><input type="checkbox" checked={archived} onChange={(event) => { setArchived(event.target.checked); setCursors([""]); }} />{t(($) => $.input_materials.include_archived)}</label>
      {inputs.isPending || changing ? <p role="status" className="flex items-center gap-2 text-caption"><Spinner aria-hidden="true" />{t(($) => $.workflow.loading)}</p>
        : inputs.isError || !inputMatches || !page ? <CockpitInputPageFailure onRetry={() => void inputs.refetch()} onFirstPage={cursors.length > 1 ? () => setCursors([""]) : undefined} /> : <>
          <ul className="max-h-[48dvh] min-w-0 divide-y divide-border overflow-y-auto overscroll-contain">{page.items.map((input) => <li key={input.id} className="min-w-0 py-2">
            <Button type="button" variant="ghost" className="h-auto w-full justify-start whitespace-normal text-left" onClick={() => { setInputId(input.id); setVersionCursors([""]); }}>
              <span className="min-w-0 space-y-1"><span className="line-clamp-2 block break-words text-body font-medium [overflow-wrap:anywhere]" title={input.title}>{input.title}</span>
                <span className="block text-caption text-muted-foreground">{t(($) => $.input_materials.version_count, { count: input.versionTotal })}{input.archivedAt && <> · {t(($) => $.input_materials.archived)}</>}</span><span className="block text-caption text-muted-foreground">{input.registeredBy.actorName} · {new Date(input.createdAt).toLocaleString(locale)}</span></span>
            </Button>
          </li>)}</ul>
          {page.items.length === 0 && <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.no_search_results)}</p>}
          <CockpitFlowPaging page={cursors.length} shown={page.items.length} total={page.total} hasNext={Boolean(page.nextCursor)} busy={inputs.isFetching}
            onPrevious={() => setCursors(cursors.slice(0, -1))} onNext={() => { if (page.nextCursor) setCursors([...cursors, page.nextCursor]); }} />
        </>}
    </>}
  </section>;
}
