"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { errorCode } from "@multica/core/api";
import { cockpitInputEntriesOptions, cockpitInputSpacesOptions, type CockpitInputFormDraft } from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { formatBytes } from "../../common/format-bytes";
import { useLocale, useT } from "../../i18n";
import { CockpitFlowError, CockpitFlowPaging, useCockpitSearch } from "./cockpit-task-flow";
import { CockpitInputCandidates, CockpitInputSelectionSummary, type CockpitInputCandidate } from "./cockpit-input-candidates";
import { CockpitInputProblem } from "./cockpit-input-problem";

export function CockpitInputNASPicker({ wsId, draft, selectionLimit = 50, disabled, onChange, onReview }: {
  wsId: string;
  draft: CockpitInputFormDraft;
  selectionLimit?: number;
  disabled?: boolean;
  onChange: (patch: Partial<CockpitInputFormDraft>) => void;
  onReview: () => void;
}) {
  const { t } = useT("cockpit");
  const locale = useLocale();
  const client = useQueryClient();
  const spaces = useQuery(cockpitInputSpacesOptions(wsId));
  const browse = draft.nasBrowse;
  const q = useCockpitSearch(browse?.q || "");
  const changing = q !== (browse?.q.trim() || "");
  const signature = JSON.stringify([wsId, browse?.rootId, browse?.relativeDirectory, q]);
  const [window, setWindow] = useState({ signature: "", cursors: [""] });
  const cursors = window.signature === signature ? window.cursors : [""];
  const root = spaces.data?.items.find((space) => space.rootId === browse?.rootId);
  const scopeAvailable = Boolean(root?.canBrowse && browse && root.inputSubpaths.includes(browse.scopePath));
  const body = { relativeDirectory: browse?.relativeDirectory || "", q, cursor: cursors.at(-1) || "", pageSize: 25 };
  const entries = useQuery({ ...cockpitInputEntriesOptions(wsId, browse?.rootId || "", body), enabled: scopeAvailable && !changing });
  const page = entries.data;
  const matches = Boolean(page && browse && page.workspaceId === wsId && page.rootId === browse.rootId && page.relativeDirectory === browse.relativeDirectory && page.q === q);
  const selected = draft.sourceSelections;
  const choices = spaces.data?.items.flatMap((space) => space.inputSubpaths.map((path) => ({ value: JSON.stringify([space.rootId, path]), label: path ? `${space.rootPath} · ${path}` : space.rootPath,
    rootId: space.rootId, path, enabled: space.canBrowse }))) ?? [];
  const choice = browse ? JSON.stringify([browse.rootId, browse.scopePath]) : null;

  function changeDirectory(relativeDirectory: string) {
    if (!browse || disabled) return;
    setWindow({ signature: "", cursors: [""] });
    onChange({ nasBrowse: { ...browse, relativeDirectory, q: "" } });
  }
  function restartBrowsing() {
    if (!browse) return;
    setWindow({ signature, cursors: [""] });
    void client.invalidateQueries({ queryKey: cockpitInputEntriesOptions(wsId, browse.rootId, { ...body, cursor: "" }).queryKey });
  }
  const parentDirectory = browse && browse.relativeDirectory !== browse.scopePath
    ? browse.relativeDirectory.includes("/") ? browse.relativeDirectory.slice(0, browse.relativeDirectory.lastIndexOf("/")) : "." : null;
  const parentInScope = Boolean(browse && parentDirectory && (browse.scopePath === "." || parentDirectory === browse.scopePath || parentDirectory.startsWith(`${browse.scopePath}/`)));
  const rows: CockpitInputCandidate[] = matches && page && browse ? page.items.map((entry) => {
    const original = selected.find((item) => item.rootId === browse.rootId && item.relativePath === entry.relativePath);
    const changedSelection = Boolean(original && original.observationToken !== entry.observationToken);
    const metadata = [entry.sizeBytes !== null ? formatBytes(entry.sizeBytes) : "",
      entry.modifiedAt && Number.isFinite(Date.parse(entry.modifiedAt)) ? new Date(entry.modifiedAt).toLocaleString(locale) : ""].filter(Boolean).join(" · ");
    const blockedReason = changedSelection ? t(($) => $.input_materials.selected_source_changed)
      : entry.unavailableReason || (entry.kind === "directory" ? !entry.canOpenDirectory : !entry.canSelect) ? t(($) => $.input_materials.candidate_unavailable) : undefined;
    return entry.kind === "directory" ? { id: entry.relativePath, name: entry.name, kind: "directory", canOpen: entry.canOpenDirectory, selected: false, metadata, blockedReason }
      : { id: entry.relativePath, name: entry.name, kind: "file", canSelect: entry.kind === "file" && entry.canSelect && (Boolean(original) || selected.length < selectionLimit), selected: Boolean(original), metadata, blockedReason };
  }) : [];

  return <section className="min-w-0 space-y-4" aria-label={t(($) => $.input_materials.choose_nas)}>
    {spaces.isPending ? <p role="status" className="flex items-center gap-2 text-caption"><Spinner aria-hidden="true" />{t(($) => $.workflow.loading)}</p>
      : spaces.isError || !spaces.data || spaces.data.workspaceId !== wsId ? <CockpitFlowError onRetry={() => void spaces.refetch()} />
        : choices.length === 0 ? <CockpitInputProblem codes={["input_scope_not_configured"]} recovery={<Button type="button" variant="outline" size="sm" onClick={() => void spaces.refetch()}>{t(($) => $.input_materials.refresh_spaces)}</Button>} /> : <>
          <label className="block space-y-1 text-caption"><span>{t(($) => $.input_materials.source_directory)}</span>
            <Select value={choices.some((item) => item.value === choice) ? choice : null} items={choices} disabled={disabled} onValueChange={(value) => {
              const selectedScope = choices.find((item) => item.value === value);
              if (!selectedScope?.enabled) return;
              setWindow({ signature: "", cursors: [""] });
              onChange({ nasBrowse: { rootId: selectedScope.rootId, scopePath: selectedScope.path, relativeDirectory: selectedScope.path, q: "" } });
            }}><SelectTrigger className="w-full" aria-label={t(($) => $.input_materials.source_directory)}><SelectValue /></SelectTrigger><SelectContent>
              {choices.map((item) => <SelectItem key={item.value} value={item.value} disabled={!item.enabled}><span className="line-clamp-2 break-words [overflow-wrap:anywhere]">{item.label}</span></SelectItem>)}
            </SelectContent></Select>
          </label>
          {browse && !scopeAvailable && <CockpitInputProblem codes={[root?.unavailableReason || "input_scope_not_configured"]} recovery={<Button type="button" variant="outline" size="sm" onClick={() => void spaces.refetch()}>{t(($) => $.input_materials.refresh_spaces)}</Button>} />}
          {browse && scopeAvailable && <>
            <div className="flex flex-wrap items-center justify-between gap-2"><p dir="ltr" className="min-w-0 flex-1 break-words text-caption [overflow-wrap:anywhere]">{browse.relativeDirectory}</p>
              <Button type="button" variant="outline" size="sm" disabled={disabled || !parentInScope} onClick={() => { if (parentDirectory && parentInScope) changeDirectory(parentDirectory); }}>{t(($) => $.input_materials.parent_directory)}</Button>
            </div>
            <label className="block space-y-1 text-caption"><span>{t(($) => $.input_materials.search_directory)}</span><Input type="search" name="nas_file_prefix" placeholder={t(($) => $.input_materials.name_prefix)} autoComplete="off"
              value={browse.q} disabled={disabled} onChange={(event) => { setWindow({ signature: "", cursors: [""] }); onChange({ nasBrowse: { ...browse, q: event.target.value } }); }} /></label>
            <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.directory_search_hint)}</p>
            {entries.isPending || changing ? <p role="status" className="flex items-center gap-2 text-caption"><Spinner aria-hidden="true" />{t(($) => $.workflow.loading)}</p>
              : entries.isError || !matches || !page ? <div className="space-y-2">
                <CockpitInputProblem codes={[errorCode(entries.error) || "input_browse_unconfirmed"]} recovery={<Button type="button" variant="outline" size="sm" onClick={restartBrowsing}>{t(($) => $.input_materials.restart_browsing)}</Button>} />
                <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.selection_retained)}</p>
              </div> : <>
                <CockpitInputCandidates items={rows} busy={disabled || entries.isFetching} onOpenDirectory={(path) => { if (page.items.some((entry) => entry.relativePath === path && entry.kind === "directory" && entry.canOpenDirectory)) changeDirectory(path); }}
                  onSelect={(path, checked) => {
                    if (disabled) return;
                    const original = selected.find((item) => item.rootId === browse.rootId && item.relativePath === path);
                    if (!checked && original) { onChange({ sourceSelections: selected.filter((item) => item.selectionId !== original.selectionId) }); return; }
                    const entry = page.items.find((item) => item.relativePath === path);
                    if (original || !entry || entry.kind !== "file" || !entry.canSelect || !entry.observationToken || selected.length >= selectionLimit) return;
                    onChange({ sourceSelections: [...selected, { selectionId: crypto.randomUUID(), rootId: browse.rootId, relativePath: entry.relativePath, observationToken: entry.observationToken,
                      filename: entry.name, sizeBytes: entry.sizeBytes, modifiedAt: entry.modifiedAt }] });
                  }} />
                <CockpitFlowPaging page={cursors.length} shown={page.items.length} total={page.total ?? undefined} hasNext={page.hasMore && Boolean(page.nextCursor)} busy={entries.isFetching || Boolean(disabled)}
                  onPrevious={() => { if (cursors.length > 1) setWindow({ signature, cursors: cursors.slice(0, -1) }); }}
                  onNext={() => { if (page.hasMore && page.nextCursor) setWindow({ signature, cursors: [...cursors, page.nextCursor] }); }} />
                <Button type="button" variant="ghost" size="sm" disabled={entries.isFetching || disabled} onClick={restartBrowsing}>{t(($) => $.input_materials.restart_browsing)}</Button>
              </>}
          </>}
        </>}
    {selected.length >= selectionLimit && <p role="status" className="text-caption text-muted-foreground">{t(($) => $.input_materials.selection_limit, { limit: selectionLimit })}</p>}
    <CockpitInputSelectionSummary selectedCount={selected.length} selectionLimit={selectionLimit} onReview={onReview} disabled={disabled || selected.length > selectionLimit} />
  </section>;
}
