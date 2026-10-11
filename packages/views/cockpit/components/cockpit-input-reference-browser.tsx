"use client";

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { cockpitAgendaInputReferencesOptions, cockpitMeetingInputReferencesOptions } from "@multica/core/cockpit";
import type { CockpitInputReference, CockpitInputReferencePage } from "@multica/core/types/cockpit-input";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useT } from "../../i18n";
import { CockpitFlowError, useCockpitSearch } from "./cockpit-task-flow";
import { CockpitInputReferenceList } from "./cockpit-input-reference-list";

/** The caller owns durable search/return context and opens removal confirmation. */
export function CockpitInputReferenceBrowser({ wsId, meetingId, agendaId, active = true, search, cursors, onSearch, onPageChange, onInspect, onRemove, toolbar }: {
  wsId: string;
  meetingId: string;
  agendaId?: string;
  active?: boolean;
  search: string;
  cursors: string[];
  onSearch: (search: string) => void;
  onPageChange: (cursors: string[]) => void;
  onInspect: (reference: CockpitInputReference) => void;
  onRemove?: (reference: CockpitInputReference) => void;
  toolbar?: (page: CockpitInputReferencePage) => ReactNode;
}) {
  const { t } = useT("cockpit");
  const q = useCockpitSearch(search);
  const changing = q !== search.trim();
  const params = { q, pageSize: 25, cursor: cursors.at(-1) || undefined, includeRemoved: false };
  const options = agendaId ? cockpitAgendaInputReferencesOptions(wsId, meetingId, agendaId, params) : cockpitMeetingInputReferencesOptions(wsId, meetingId, params);
  const query = useQuery({ ...options, enabled: active && !changing && options.enabled !== false });
  const page = query.data;
  const matches = page && page.workspaceId === wsId && page.meetingId === meetingId && page.agendaId === (agendaId || null) && page.q === q && page.purpose === "";
  if (!active) return null;
  return <div className="min-w-0 space-y-3">
    <label className="block space-y-1 text-caption"><span>{t(($) => $.input_materials.search_references)}</span>
      <Input type="search" name="input_material_search" autoComplete="off" value={search} onChange={(event) => { onPageChange([""]); onSearch(event.target.value); }} />
    </label>
    {query.isPending || changing ? <p role="status" className="flex items-center gap-2 text-caption"><Spinner aria-hidden="true" />{t(($) => $.workflow.loading)}</p>
      : query.isError || !matches ? <div className="space-y-2"><CockpitFlowError onRetry={() => void query.refetch()} />
        {cursors.length > 1 && <Button type="button" variant="outline" size="sm" onClick={() => onPageChange([""])}>{t(($) => $.task_flow.first_page)}</Button>}
      </div> : <CockpitInputReferenceList page={page} pageNumber={cursors.length} search={search} busy={query.isFetching}
        toolbar={toolbar?.(page)} onInspect={onInspect} onRemove={onRemove}
        onPrevious={() => { if (cursors.length > 1) onPageChange(cursors.slice(0, -1)); }}
        onNext={() => { if (page.nextCursor) onPageChange([...cursors, page.nextCursor]); }} />}
  </div>;
}
