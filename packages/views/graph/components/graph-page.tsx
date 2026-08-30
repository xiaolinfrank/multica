"use client";

// The issue graph page: workspace-level ("/:slug/graph") or project-scoped
// ("/:slug/projects/:id/graph", via the projectId prop). Owns the view state
// (filters, search, focus, collapsed branches), derives the GraphModel from
// the cached snapshot, and renders toolbar + canvas + legend. Layout math and
// graph semantics live in @multica/core/graph.

import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { projectListOptions } from "@multica/core/projects/queries";
import { issueGraphOptions } from "@multica/core/graph/queries";
import {
  buildGraphModel,
  collectSubtree,
  defaultEdgeKinds,
  focusNodeIds,
  matchesQuery,
} from "@multica/core/graph/build-graph-model";
import type { GraphModel } from "@multica/core/graph/build-graph-model";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { GraphCanvas } from "./graph-canvas";
import {
  ALL_EDGE_GROUPS,
  GraphToolbar,
  type ColorDimension,
  type EdgeGroupToggles,
  type FocusDepth,
} from "./graph-toolbar";
import { GraphLegend } from "./graph-legend";

const SEARCH_RESULT_LIMIT = 8;

function edgeKindsFromGroups(groups: EdgeGroupToggles) {
  const kinds = defaultEdgeKinds();
  if (!groups.child) kinds.delete("child");
  if (!groups.dependency) {
    kinds.delete("blocks");
    kinds.delete("blocked_by");
    kinds.delete("related");
  }
  if (!groups.mention) kinds.delete("mention");
  return kinds;
}

/** Applies collapse branches and focus depth on top of the filtered model. */
function scopeModel(model: GraphModel, collapsedRoots: Set<string>, selectedId: string | null, focusDepth: FocusDepth): {
  model: GraphModel;
  collapsedCount: number;
} {
  let collapsedCount = 0;
  if (collapsedRoots.size > 0) {
    const hidden = new Set<string>();
    for (const root of collapsedRoots) {
      for (const id of collectSubtree(root, model.children)) hidden.add(id);
    }
    collapsedCount = hidden.size;
    const nodes = model.nodes.filter((n) => !hidden.has(n.id));
    const visible = new Set(nodes.map((n) => n.id));
    const edges = model.edges.filter((e) => visible.has(e.source) && visible.has(e.target));
    model = {
      nodes,
      edges,
      neighbors: model.neighbors,
      degree: model.degree,
      children: model.children,
    };
  }
  if (focusDepth > 0 && selectedId) {
    const keep = focusNodeIds(model, selectedId, focusDepth);
    const nodes = model.nodes.filter((n) => keep.has(n.id));
    const edges = model.edges.filter((e) => keep.has(e.source) && keep.has(e.target));
    model = { nodes, edges, neighbors: model.neighbors, degree: model.degree, children: model.children };
  }
  return { model, collapsedCount };
}

export function GraphPage(props: { projectId?: string | null }) {
  const projectId = props.projectId ?? null;
  const wsId = useWorkspaceId();
  const { t } = useT("graph");
  const navigation = useNavigation();
  const wsPaths = useWorkspacePaths();

  const graphQuery = useQuery({
    ...issueGraphOptions(wsId ?? "", projectId),
    enabled: wsId !== null,
  });
  const projectsQuery = useQuery({
    ...projectListOptions(wsId ?? ""),
    enabled: wsId !== null,
  });
  const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data]);

  const [projectFilter, setProjectFilter] = useState<Set<string> | null>(null);
  const [statusFilter, setStatusFilter] = useState<Set<string> | null>(null);
  const [edgeGroups, setEdgeGroups] = useState<EdgeGroupToggles>(ALL_EDGE_GROUPS);
  const [colorBy, setColorBy] = useState<ColorDimension>("project");
  const [focusDepth, setFocusDepth] = useState<FocusDepth>(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsedRoots, setCollapsedRoots] = useState<Set<string>>(new Set());
  const [centerOn, setCenterOn] = useState<{ id: string; nonce: number } | null>(null);

  const data = graphQuery.data ?? { nodes: [], edges: [] };

  const fullModel = useMemo(
    () =>
      buildGraphModel(data, {
        projects: projectId ? new Set([projectId]) : projectFilter,
        statuses: statusFilter,
        edgeKinds: edgeKindsFromGroups(edgeGroups),
      }),
    [data, projectId, projectFilter, statusFilter, edgeGroups],
  );

  const { model, collapsedCount } = useMemo(
    () => scopeModel(fullModel, collapsedRoots, selectedId, focusDepth),
    [fullModel, collapsedRoots, selectedId, focusDepth],
  );

  const selectedNode = useMemo(
    () => model.nodes.find((n) => n.id === selectedId) ?? null,
    [model, selectedId],
  );

  const searchResults = useMemo(() => {
    const q = searchQuery.trim();
    if (!q) return [];
    return fullModel.nodes.filter((n) => matchesQuery(n, q)).slice(0, SEARCH_RESULT_LIMIT);
  }, [fullModel, searchQuery]);

  const onPickResult = useCallback((id: string) => {
    setSelectedId(id);
    setCenterOn((prev) => ({ id, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  const onToggleCollapse = useCallback(
    (id: string) => {
      setCollapsedRoots((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [],
  );

  const onReset = useCallback(() => {
    setProjectFilter(null);
    setStatusFilter(null);
    setEdgeGroups(ALL_EDGE_GROUPS);
    setFocusDepth(0);
    setSearchQuery("");
    setSelectedId(null);
    setCollapsedRoots(new Set());
  }, []);

  const openIssue = useCallback(
    (id: string) => {
      if (wsPaths) navigation.push(wsPaths.issueDetail(id));
    },
    [navigation, wsPaths],
  );

  if (wsId === null || graphQuery.isLoading) {
    return (
      <div className="flex h-full flex-col gap-4 p-4 md:p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-10 w-full max-w-md" />
        <Skeleton className="h-full w-full" />
      </div>
    );
  }

  const total = data.nodes.length;

  return (
    <div className="flex h-full flex-col gap-3 p-4 @container md:p-6" data-testid="graph-page">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-title font-semibold text-foreground">{t(($) => $.page.title)}</h1>
          <p className="text-caption text-muted-foreground">{t(($) => $.page.subtitle)}</p>
        </div>
        <div className="text-micro text-muted-foreground tabular-nums" data-testid="graph-counts">
          {t(($) => $.counts.nodes, { count: model.nodes.length })}
          {" · "}
          {t(($) => $.counts.edges, { count: model.edges.length })}
          {collapsedCount > 0 ? ` · ${t(($) => $.counts.collapsed, { count: collapsedCount })}` : ""}
        </div>
      </div>

      <GraphToolbar
        projects={projects}
        projectScopeFixed={projectId !== null}
        projectFilter={projectFilter}
        onProjectFilterChange={setProjectFilter}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        edgeGroups={edgeGroups}
        onEdgeGroupsChange={setEdgeGroups}
        colorBy={colorBy}
        onColorByChange={setColorBy}
        focusDepth={focusDepth}
        onFocusDepthChange={setFocusDepth}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        searchResults={searchResults}
        onPickResult={onPickResult}
        onReset={onReset}
      />

      <div className="relative min-h-0 flex-1">
        {total === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 rounded-lg border bg-background text-center">
            <p className="text-body-lg font-medium text-foreground">{t(($) => $.empty.title)}</p>
            <p className="max-w-80 text-caption text-muted-foreground">{t(($) => $.empty.body)}</p>
          </div>
        ) : (
          <>
            <GraphCanvas
              model={model}
              projects={projects}
              colorBy={colorBy}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onToggleCollapse={onToggleCollapse}
              centerOn={centerOn}
              searchQuery={searchQuery}
            />
            <GraphLegend colorBy={colorBy} projects={projects} edgeGroups={edgeGroups} />
            {selectedNode ? (
              <div
                className="absolute bottom-3 right-3 z-10 w-64 rounded-lg border bg-popover p-3 shadow-[var(--floating-shadow)]"
                data-testid="graph-node-card"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="font-mono text-micro text-muted-foreground">
                    {selectedNode.identifier}
                  </span>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={t(($) => $.card.dismiss)}
                    onClick={() => setSelectedId(null)}
                  >
                    ×
                  </button>
                </div>
                <p className="mt-0.5 text-body font-medium text-foreground">{selectedNode.title}</p>
                <dl className="mt-2 space-y-1 text-caption text-muted-foreground">
                  <div className="flex justify-between gap-2">
                    <dt>{t(($) => $.card.status)}</dt>
                    <dd className="text-foreground">{selectedNode.status}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt>{t(($) => $.card.links)}</dt>
                    <dd className="tabular-nums text-foreground">
                      {fullModel.degree.get(selectedNode.id) ?? 0}
                    </dd>
                  </div>
                </dl>
                <button
                  type="button"
                  className="mt-2 w-full rounded-md bg-primary px-2 py-1.5 text-caption font-medium text-primary-foreground hover:bg-primary/90"
                  onClick={() => openIssue(selectedNode.id)}
                >
                  {t(($) => $.card.open)}
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
