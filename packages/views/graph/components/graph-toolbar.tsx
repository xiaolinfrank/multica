"use client";

// Toolbar for the issue graph: search (with live results), the filter menu
// (projects / status categories / relation groups), the color dimension, the
// focus depth, and a reset. Fully controlled — GraphPage owns every piece of
// state so the canvas and the toolbar can never disagree.

import { useMemo, useState } from "react";
import { useT } from "../../i18n";
import { Input } from "@multica/ui/components/ui/input";
import { Button } from "@multica/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@multica/ui/components/ui/dropdown-menu";
import { Toggle } from "@multica/ui/components/ui/toggle";
import { Filter, RotateCcw, Search } from "lucide-react";
import { STATUS_CONFIG } from "@multica/core/issues/config/status";
import type { GraphNode } from "@multica/core/graph/build-graph-model";
import type { Project } from "@multica/core/types";

export type ColorDimension = "project" | "status";
export type FocusDepth = 0 | 1 | 2;

/** The three user-facing relation groups; each maps to a set of edge kinds. */
export interface EdgeGroupToggles {
  child: boolean;
  dependency: boolean;
  mention: boolean;
}

export const ALL_EDGE_GROUPS: EdgeGroupToggles = { child: true, dependency: true, mention: true };

export interface GraphToolbarProps {
  projects: Project[];
  /** True on the project-scoped page: the scope is fixed by the route, so
   *  the project filter section is not rendered. */
  projectScopeFixed?: boolean;
  /** null project filter = every project (workspace scope default). */
  projectFilter: Set<string> | null;
  onProjectFilterChange: (next: Set<string> | null) => void;
  statusFilter: Set<string> | null;
  onStatusFilterChange: (next: Set<string> | null) => void;
  edgeGroups: EdgeGroupToggles;
  onEdgeGroupsChange: (next: EdgeGroupToggles) => void;
  colorBy: ColorDimension;
  onColorByChange: (next: ColorDimension) => void;
  focusDepth: FocusDepth;
  onFocusDepthChange: (next: FocusDepth) => void;
  searchQuery: string;
  onSearchQueryChange: (next: string) => void;
  searchResults: GraphNode[];
  onPickResult: (id: string) => void;
  onReset: () => void;
}

export function GraphToolbar(props: GraphToolbarProps) {
  const { t } = useT("graph");
  const [searchOpen, setSearchOpen] = useState(false);
  const query = props.searchQuery.trim();

  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (props.projectFilter) n += 1;
    if (props.statusFilter) n += 1;
    if (!props.edgeGroups.child || !props.edgeGroups.dependency || !props.edgeGroups.mention) {
      n += 1;
    }
    return n;
  }, [props.projectFilter, props.statusFilter, props.edgeGroups]);

  // Toggling from the unfiltered state (null) must start from the full
  // universe, or unchecking ONE project would drop every other project too.
  const toggleInSet = (set: Set<string> | null, key: string, universe: string[]): Set<string> | null => {
    const next = new Set(set ?? universe);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };
  const projectUniverse = useMemo(
    () => [...props.projects.map((p) => p.id), ""],
    [props.projects],
  );

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="graph-toolbar">
      <div className="relative min-w-52 flex-1 max-w-96">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={props.searchQuery}
          onChange={(e) => {
            props.onSearchQueryChange(e.target.value);
            setSearchOpen(true);
          }}
          onFocus={() => setSearchOpen(true)}
          onBlur={() => window.setTimeout(() => setSearchOpen(false), 120)}
          placeholder={t(($) => $.toolbar.search_placeholder)}
          className="pl-8"
          aria-label={t(($) => $.toolbar.search_placeholder)}
        />
        {searchOpen && query !== "" ? (
          <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border bg-popover shadow-[var(--floating-shadow)]">
            {props.searchResults.length === 0 ? (
              <div className="px-3 py-2 text-caption text-muted-foreground">
                {t(($) => $.toolbar.no_results)}
              </div>
            ) : (
              props.searchResults.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    props.onPickResult(n.id);
                    setSearchOpen(false);
                  }}
                >
                  <span className="font-mono text-micro text-muted-foreground">{n.identifier}</span>
                  <span className="truncate text-body text-foreground">{n.title}</span>
                </button>
              ))
            )}
          </div>
        ) : null}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="outline" size="sm">
              <Filter className="size-4" />
              {t(($) => $.toolbar.filter)}
              {activeFilterCount > 0 ? (
                <span className="ml-0.5 rounded-full bg-accent px-1.5 text-micro tabular-nums text-foreground">
                  {activeFilterCount}
                </span>
              ) : null}
            </Button>
          }
        />
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>{t(($) => $.filter.edge_kinds)}</DropdownMenuLabel>
          {(Object.keys(ALL_EDGE_GROUPS) as Array<keyof EdgeGroupToggles>).map((group) => (
            <DropdownMenuCheckboxItem
              key={group}
              checked={props.edgeGroups[group]}
              onCheckedChange={(checked) =>
                props.onEdgeGroupsChange({ ...props.edgeGroups, [group]: checked === true })
              }
              closeOnClick={false}
            >
              {t(($) =>
                group === "child"
                  ? $.filter.edge_group_child
                  : group === "dependency"
                    ? $.filter.edge_group_dependency
                    : $.filter.edge_group_mention,
              )}
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>{t(($) => $.filter.statuses)}</DropdownMenuLabel>
          {Object.entries(STATUS_CONFIG).map(([category, config]) => {
            const active = props.statusFilter?.has(category) ?? true;
            return (
              <DropdownMenuCheckboxItem
                key={category}
                checked={active}
                onCheckedChange={() =>
                  props.onStatusFilterChange(
                    toggleInSet(props.statusFilter, category, Object.keys(STATUS_CONFIG)),
                  )
                }
                closeOnClick={false}
              >
                <span className={config.iconColor}>{config.label}</span>
              </DropdownMenuCheckboxItem>
            );
          })}
          {!props.projectScopeFixed && props.projects.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{t(($) => $.filter.projects)}</DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={props.projectFilter?.has("") ?? true}
                onCheckedChange={() =>
                  props.onProjectFilterChange(toggleInSet(props.projectFilter, "", projectUniverse))
                }
                closeOnClick={false}
              >
                {t(($) => $.filter.no_project)}
              </DropdownMenuCheckboxItem>
              {props.projects.map((p) => {
                const active = props.projectFilter?.has(p.id) ?? true;
                return (
                  <DropdownMenuCheckboxItem
                    key={p.id}
                    checked={active}
                    onCheckedChange={() =>
                      props.onProjectFilterChange(
                        toggleInSet(props.projectFilter, p.id, projectUniverse),
                      )
                    }
                    closeOnClick={false}
                    className="max-w-56"
                  >
                    <span className="truncate">
                      {p.icon ? `${p.icon} ` : ""}
                      {p.title}
                    </span>
                  </DropdownMenuCheckboxItem>
                );
              })}
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="outline" size="sm">
              {t(($) => $.toolbar.color_by)}:{" "}
              {props.colorBy === "project"
                ? t(($) => $.toolbar.color_project)
                : t(($) => $.toolbar.color_status)}
            </Button>
          }
        />
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => props.onColorByChange("project")}>
            {t(($) => $.toolbar.color_project)}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => props.onColorByChange("status")}>
            {t(($) => $.toolbar.color_status)}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="flex items-center gap-1 rounded-md border p-0.5" role="group" aria-label={t(($) => $.toolbar.focus_depth)}>
        {([0, 1, 2] as const).map((depth) => (
          <Toggle
            key={depth}
            size="sm"
            pressed={props.focusDepth === depth}
            onPressedChange={() => props.onFocusDepthChange(depth)}
            aria-label={t(($) => $.toolbar.focus_depth)}
          >
            {depth === 0
              ? t(($) => $.toolbar.focus_off)
              : depth === 1
                ? t(($) => $.toolbar.focus_1)
                : t(($) => $.toolbar.focus_2)}
          </Toggle>
        ))}
      </div>

      <Button variant="ghost" size="sm" onClick={props.onReset}>
        <RotateCcw className="size-4" />
        {t(($) => $.toolbar.reset)}
      </Button>
    </div>
  );
}
