"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cockpitScopedPath, cockpitScopeModulesOptions, cockpitScopeProjectsOptions, type CockpitScope } from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@multica/ui/components/ui/popover";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Check, ChevronsUpDown, FolderKanban, Layers3, Search } from "lucide-react";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { CockpitFlowPaging, useCockpitSearch } from "./cockpit-task-flow";

export function CockpitScopeControl({ wsId, scope, projectTitle, moduleTitle }: {
  wsId: string; scope: CockpitScope; projectTitle?: string; moduleTitle?: string;
}) {
  const { t } = useT("cockpit");
  const navigation = useNavigation();
  const select = (next: CockpitScope) => navigation.push(cockpitScopedPath(navigation.pathname, navigation.searchParams, next));
  return <div className="flex min-w-0 flex-wrap items-center gap-2" aria-label={t(($) => $.shell.scope)}>
    <CockpitScopePicker wsId={wsId} kind="project" projectId={null} selectedId={scope.projectId} selectedTitle={projectTitle ?? ""}
      onSelect={(projectId) => select({ projectId, moduleId: null })} />
    {scope.projectId ? <CockpitScopePicker key={scope.projectId} wsId={wsId} kind="module" projectId={scope.projectId}
      selectedId={scope.moduleId} selectedTitle={moduleTitle ?? ""} onSelect={(moduleId) => select({ ...scope, moduleId })} />
      : scope.moduleId ? <span role="alert" className="max-w-80 text-caption text-destructive">{t(($) => $.shell.module_needs_project)}</span>
        : <span className="text-caption text-muted-foreground">{t(($) => $.shell.module_scope_hint)}</span>}
  </div>;
}

export function CockpitScopePicker({ wsId, kind, projectId, selectedId, selectedTitle, onSelect, label: providedLabel, emptyLabel, emptyAction, disabled = false }: {
  wsId: string; kind: "project" | "module"; projectId: string | null; selectedId: string | null; selectedTitle: string;
  onSelect: (id: string | null) => void; label?: string; emptyLabel?: string; emptyAction?: React.ReactNode; disabled?: boolean;
}) {
  const { t } = useT("cockpit");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [cursors, setCursors] = useState<string[]>([""]);
  const q = useCockpitSearch(search);
  const changing = q !== search.trim();
  const options = kind === "project" ? cockpitScopeProjectsOptions(wsId, q, cursors.at(-1) || undefined)
    : cockpitScopeModulesOptions(wsId, projectId ?? "", q, cursors.at(-1) || undefined);
  const query = useQuery({ ...options, enabled: open && Boolean(wsId && (kind === "project" || projectId)) && !changing });
  const data = query.data;
  const Icon = kind === "project" ? FolderKanban : Layers3;
  const label = providedLabel ?? (kind === "project" ? t(($) => $.work_overview.project_scope) : t(($) => $.shell.module_scope));
  const all = emptyLabel ?? (kind === "project" ? t(($) => $.shell.all_projects) : t(($) => $.shell.all_modules));
  const searchLabel = kind === "project" ? t(($) => $.work_overview.search_projects) : t(($) => $.shell.search_modules);
  const selectedLabel = kind === "project" ? t(($) => $.work_overview.selected_project) : t(($) => $.shell.selected_module);
  const select = (id: string | null) => { if (!disabled) { onSelect(id); setOpen(false); } };
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger render={<Button type="button" variant={selectedId ? "secondary" : "outline"} size="sm" disabled={disabled} aria-label={label} data-cockpit-project-scope={kind === "project" && !providedLabel || undefined} data-cockpit-module-scope={kind === "module" && !providedLabel || undefined} className="max-w-full gap-2" />}>
      <Icon className="size-3.5 shrink-0" aria-hidden /><span className="min-w-0 max-w-56 truncate">{selectedId ? selectedTitle || selectedLabel : all}</span>
      <ChevronsUpDown className="size-3 shrink-0 text-muted-foreground" aria-hidden />
    </PopoverTrigger>
    <PopoverContent align="start" className="w-[min(25rem,calc(100vw-2rem))] space-y-3 p-3">
      <section aria-label={label} className="space-y-3">
        <div className="relative"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden />
          <Input autoFocus name={`cockpit-${kind}-scope-search`} autoComplete="off" spellCheck={false} aria-label={searchLabel} placeholder={searchLabel} value={search} className="pl-8"
            onChange={(event) => { if (event.target.value !== search) setCursors([""]); setSearch(event.target.value); }} /></div>
        <Button type="button" variant={!selectedId ? "secondary" : "ghost"} size="sm" className="w-full justify-between" aria-pressed={!selectedId} onClick={() => select(null)}>
          {all}{!selectedId && <Check className="size-3.5" aria-hidden />}</Button>
        {(query.isError || (query.isSuccess && !data)) ? <div role="alert" className="space-y-2 text-caption text-destructive"><p>{kind === "module" ? t(($) => $.binding.modules_failed) : t(($) => $.binding.load_failed)}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>{t(($) => $.binding.retry)}</Button></div>
          : query.isPending || changing ? <div role="status" className="flex items-center gap-2 px-2 text-caption text-muted-foreground"><Spinner />{t(($) => $.issues.searching)}</div>
            : data && <><ul className="max-h-64 space-y-1 overflow-y-auto overscroll-contain">{data.items.map((item) => <li key={item.id}>
              <Button type="button" variant={item.id === selectedId ? "secondary" : "ghost"} className="h-auto min-h-9 w-full justify-start whitespace-normal text-left"
                aria-label={item.title} aria-pressed={item.id === selectedId} onClick={() => select(item.id)}>
                <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /><span className="line-clamp-2 min-w-0 break-words" title={item.title}>{item.title}</span>
                {item.id === selectedId && <Check className="ml-auto size-3.5 shrink-0" aria-hidden />}
              </Button></li>)}</ul>
              {data.items.length === 0 && <div className="space-y-2 px-2 text-caption text-muted-foreground"><p>{t(($) => $.task_flow.no_matches)}</p>{!q && emptyAction}</div>}</>}
        {data ? <CockpitFlowPaging page={cursors.length} shown={data.items.length} total={data.total} hasNext={Boolean(data.next_cursor)} busy={query.isFetching || changing}
          onPrevious={() => { if (cursors.length > 1) setCursors(cursors.slice(0, -1)); }} onNext={() => { if (data.next_cursor) setCursors([...cursors, data.next_cursor]); }} />
          : cursors.length > 1 && <Button type="button" variant="outline" size="sm" disabled={query.isFetching} onClick={() => setCursors(cursors.slice(0, -1))}>{t(($) => $.task_flow.previous)}</Button>}
      </section>
    </PopoverContent>
  </Popover>;
}
