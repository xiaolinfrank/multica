"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { COCKPIT_DASHBOARD_PROJECT_PAGE_SIZE, cockpitDashboardProjectsOptions } from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@multica/ui/components/ui/popover";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Check, ChevronsUpDown, FolderKanban, Search } from "lucide-react";
import { useT } from "../../i18n";
import { CockpitFlowPaging, useCockpitSearch } from "./cockpit-task-flow";

export function CockpitDashboardScope({ wsId, projectId, projectTitle, onSelect }: {
  wsId: string; projectId: string; projectTitle: string; onSelect: (projectId: string) => void;
}) {
  const { t } = useT("cockpit");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const q = useCockpitSearch(search);
  const changing = search.trim() !== q;
  const query = useQuery({ ...cockpitDashboardProjectsOptions(wsId, q, page * COCKPIT_DASHBOARD_PROJECT_PAGE_SIZE),
    enabled: open && Boolean(wsId && q) && !changing });
  const projects = query.data?.projects ?? [];
  function select(id: string) { onSelect(id); setOpen(false); }
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger render={<Button type="button" variant="outline" size="sm" aria-label={t(($) => $.work_overview.project_scope)} className="max-w-full gap-2 bg-card" />}>
      <FolderKanban className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 max-w-56 truncate">{projectId ? projectTitle || t(($) => $.work_overview.selected_project) : t(($) => $.work_overview.all_projects)}</span>
      <ChevronsUpDown className="size-3 shrink-0 text-muted-foreground" aria-hidden />
    </PopoverTrigger>
    <PopoverContent align="end" className="w-[min(24rem,calc(100vw-2rem))] space-y-3 p-3">
      <section aria-label={t(($) => $.work_overview.project_scope)} className="space-y-3">
        <div className="relative"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden />
          <Input autoFocus name="cockpit-project-search" autoComplete="off" spellCheck={false} value={search} aria-label={t(($) => $.work_overview.search_projects)} placeholder={t(($) => $.work_overview.search_projects)} className="pl-8"
            onChange={(event) => { if (event.target.value !== search) setPage(0); setSearch(event.target.value); }} /></div>
        <Button type="button" variant={!projectId ? "secondary" : "ghost"} size="sm" className="w-full justify-between" aria-pressed={!projectId} onClick={() => select("")}>
          {t(($) => $.work_overview.all_projects)}{!projectId && <Check className="size-3.5" aria-hidden />}</Button>
        {!q ? <p className="px-2 text-caption text-muted-foreground">{t(($) => $.work_overview.project_search_hint)}</p>
          : query.isError || projects.length > COCKPIT_DASHBOARD_PROJECT_PAGE_SIZE ? <div role="alert" className="space-y-2 text-caption text-destructive">
            <p>{t(($) => $.binding.load_failed)}</p><Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>{t(($) => $.binding.retry)}</Button></div>
            : query.isPending || changing ? <div role="status" className="flex items-center gap-2 px-2 text-caption text-muted-foreground"><Spinner />{t(($) => $.issues.searching)}</div>
              : <><ul className="max-h-64 space-y-1 overflow-y-auto overscroll-contain">{projects.map((project) => <li key={project.id}>
                <Button type="button" variant={projectId === project.id ? "secondary" : "ghost"} className="h-auto min-h-9 w-full justify-start whitespace-normal text-left"
                  aria-label={project.title} aria-pressed={projectId === project.id} onClick={() => select(project.id)}>
                  <FolderKanban className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /><span className="line-clamp-2 min-w-0 break-words" title={project.title}>{project.title}</span>
                  {projectId === project.id && <Check className="ml-auto size-3.5 shrink-0" aria-hidden />}
                </Button></li>)}</ul>
                {projects.length === 0 && <p className="px-2 text-caption text-muted-foreground">{t(($) => $.task_flow.no_matches)}</p>}
                <CockpitFlowPaging page={page + 1} shown={projects.length} hasNext={projects.length === COCKPIT_DASHBOARD_PROJECT_PAGE_SIZE} busy={query.isFetching}
                  onPrevious={() => setPage(Math.max(0, page - 1))} onNext={() => setPage(page + 1)} /></>}
      </section>
    </PopoverContent>
  </Popover>;
}
