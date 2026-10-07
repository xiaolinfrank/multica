"use client";

// The graph page: workspace-level ("/:slug/graph") or project-scoped
// ("/:slug/projects/:id/graph", via the projectId prop). Three entity types
// share one canvas — issues, cockpit meetings, and agent runs — with the
// issue relations plus the two cross-entity link kinds. Owns the view state
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
  graphAddressEntity,
  graphExecutionAddress,
  graphMeetingAddress,
  matchesQuery,
} from "@multica/core/graph/build-graph-model";
import type { GraphExecutionNode, GraphModel } from "@multica/core/graph/build-graph-model";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { GraphCanvas } from "./graph-canvas";
import { demoGraph } from "./graph-demo";
import {
  ALL_EDGE_GROUPS,
  GraphToolbar,
  type ColorDimension,
  type EdgeGroupToggles,
  type FocusDepth,
  type GraphSearchResult,
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
  if (!groups.meeting) {
    kinds.delete("meeting");
    kinds.delete("meeting_run");
  }
  if (!groups.execution) kinds.delete("execution");
  return kinds;
}

/** A scoped-down copy of the model: node arrays filtered by a keep set over
 *  graph addresses (raw issue UUID, mtg:, run:), edges by endpoint survival. */
function subsetModel(model: GraphModel, keep: (address: string) => boolean): GraphModel {
  const nodes = model.nodes.filter((n) => keep(n.id));
  const meetings = model.meetings.filter((n) => keep(graphMeetingAddress(n.id)));
  const executions = model.executions.filter((n) => keep(graphExecutionAddress(n.id)));
  const visible = new Set<string>([
    ...nodes.map((n) => n.id),
    ...meetings.map((n) => graphMeetingAddress(n.id)),
    ...executions.map((n) => graphExecutionAddress(n.id)),
  ]);
  const edges = model.edges.filter((e) => visible.has(e.source) && visible.has(e.target));
  return { nodes, meetings, executions, edges, neighbors: model.neighbors, degree: model.degree, children: model.children };
}

/** Applies collapse branches and focus depth on top of the filtered model.
 *  Folding an issue branch also folds the meetings/runs that only hung off
 *  the hidden issues; focus keeps whatever the BFS reached, across entities. */
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
    const hiddenMeeting = (addr: string) => {
      const linked = model.edges.filter((e) => e.kind === "meeting" && e.source === addr);
      return linked.length > 0 && linked.every((e) => hidden.has(e.target));
    };
    model = subsetModel(model, (addr) => {
      if (hidden.has(addr)) return false;
      if (addr.startsWith("run:")) {
        const run = model.executions.find((r) => graphExecutionAddress(r.id) === addr);
        if (run && hidden.has(run.issue_id)) return false;
      }
      if (addr.startsWith("mtg:")) return !hiddenMeeting(addr);
      return true;
    });
  }
  if (focusDepth > 0 && selectedId) {
    const keep = focusNodeIds(model, selectedId, focusDepth);
    model = subsetModel(model, (addr) => keep.has(addr));
  }
  return { model, collapsedCount };
}

export function GraphPage(props: { projectId?: string | null }) {
  const projectId = props.projectId ?? null;
  const wsId = useWorkspaceId();
  const { t } = useT("graph");
  const navigation = useNavigation();
  const wsPaths = useWorkspacePaths();
  // `?demo=1` renders a synthetic graph without touching the API — used for
  // visual development and screenshot verification (same escape hatch as the
  // Agent Office).
  const isDemo = navigation.searchParams.get("demo") === "1";

  const graphQuery = useQuery({
    ...issueGraphOptions(wsId ?? "", projectId),
    enabled: wsId !== null && !isDemo,
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

  const data = useMemo(
    () =>
      isDemo
        ? demoGraph()
        : graphQuery.data ?? { nodes: [], edges: [], meetings: [], executions: [] },
    [isDemo, graphQuery.data],
  );

  const fullModel = useMemo(
    () =>
      buildGraphModel(data, {
        projects: projectId ? new Set([projectId]) : projectFilter,
        statuses: statusFilter,
        edgeKinds: edgeKindsFromGroups(edgeGroups),
        meetings: edgeGroups.meeting,
        executions: edgeGroups.execution,
      }),
    [data, projectId, projectFilter, statusFilter, edgeGroups],
  );

  const { model, collapsedCount } = useMemo(
    () => scopeModel(fullModel, collapsedRoots, selectedId, focusDepth),
    [fullModel, collapsedRoots, selectedId, focusDepth],
  );

  // The selection is a graph ADDRESS: issues keep their raw UUID, meetings
  // and runs carry the mtg:/run: prefixes — one lookup tells the entity.
  const selectedNode = useMemo(() => {
    if (!selectedId) return null;
    const entity = graphAddressEntity(selectedId);
    if (entity === "meeting") {
      return model.meetings.find((n) => graphMeetingAddress(n.id) === selectedId) ?? null;
    }
    if (entity === "execution") {
      return model.executions.find((n) => graphExecutionAddress(n.id) === selectedId) ?? null;
    }
    return model.nodes.find((n) => n.id === selectedId) ?? null;
  }, [model, selectedId]);

  // Per-group edge counts for the selected node, mirroring the toolbar's
  // relation groups (child / dependency / mention / meeting / execution).
  const selectedEdgeCounts = useMemo(() => {
    if (!selectedNode || !selectedId) return null;
    let child = 0;
    let dependency = 0;
    let mention = 0;
    let meeting = 0;
    let execution = 0;
    for (const e of fullModel.edges) {
      if (e.source !== selectedId && e.target !== selectedId) continue;
      if (e.kind === "child") child += 1;
      else if (e.kind === "mention") mention += 1;
      else if (e.kind === "meeting") meeting += 1;
      else if (e.kind === "execution") execution += 1;
      else dependency += 1;
    }
    return { child, dependency, mention, meeting, execution };
  }, [fullModel, selectedNode, selectedId]);

  const searchResults = useMemo(() => {
    const q = searchQuery.trim();
    if (!q) return [];
    const results: GraphSearchResult[] = [];
    for (const n of fullModel.nodes) {
      if (matchesQuery(n, q)) {
        results.push({ id: n.id, identifier: n.identifier, title: n.title, entity: "issue" });
      }
    }
    for (const m of fullModel.meetings) {
      if (matchesQuery({ identifier: m.code, title: m.title }, q)) {
        results.push({
          id: graphMeetingAddress(m.id),
          identifier: m.code,
          title: m.title,
          entity: "meeting",
        });
      }
    }
    const issueById = new Map(fullModel.nodes.map((n) => [n.id, n]));
    for (const r of fullModel.executions) {
      const owner = issueById.get(r.issue_id);
      if (
        matchesQuery({ identifier: owner?.identifier ?? "", title: r.agent_name }, q)
      ) {
        results.push({
          id: graphExecutionAddress(r.id),
          identifier: owner?.identifier ?? "",
          title: r.agent_name,
          entity: "execution",
        });
      }
    }
    return results.slice(0, SEARCH_RESULT_LIMIT);
  }, [fullModel, searchQuery]);

  const onPickResult = useCallback(
    (id: string) => {
      setSelectedId(id);
      setCenterOn((prev) => ({ id, nonce: (prev?.nonce ?? 0) + 1 }));
      // Search results come from the pre-collapse model; a picked result may
      // sit inside a folded branch. Expand the roots hiding it so the
      // selection (menu, highlight) lands on something visible.
      setCollapsedRoots((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set(prev);
        for (const root of prev) {
          if (collectSubtree(root, fullModel.children).has(id)) next.delete(root);
        }
        return next;
      });
    },
    [fullModel],
  );

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

  // A meeting opens where it lives: the cockpit's meetings tab with its
  // panel up (?meeting= deep link, consumed by the cockpit page).
  const openMeeting = useCallback(
    (id: string) => {
      if (wsPaths) navigation.push(`${wsPaths.cockpit()}?meeting=${encodeURIComponent(id)}`);
    },
    [navigation, wsPaths],
  );

  // A run has no page of its own; it lives inline in its issue's timeline.
  // Anchor the jump on the comment that triggered it when there is one.
  const openExecution = useCallback(
    (exec: GraphExecutionNode) => {
      if (!wsPaths) return;
      const owner = data.nodes.find((n) => n.id === exec.issue_id);
      if (!owner) return;
      const hash = exec.trigger_comment_id ? `#comment-${exec.trigger_comment_id}` : "";
      navigation.push(wsPaths.issueDetail(owner.identifier) + hash);
    },
    [navigation, wsPaths, data],
  );

  // Menu action "keep related only": the toolbar's 1-hop focus already
  // expresses it; re-centering makes the trimmed graph readable at once.
  const onFocusNeighbors = useCallback((id: string) => {
    setFocusDepth(1);
    setCenterOn((prev) => ({ id, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  if (!isDemo && (wsId === null || graphQuery.isLoading)) {
    return (
      <div className="flex h-full flex-col gap-4 p-4 md:p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-10 w-full max-w-md" />
        <Skeleton className="h-full w-full" />
      </div>
    );
  }

  const total = data.nodes.length + (data.meetings?.length ?? 0) + (data.executions?.length ?? 0);

  return (
    <div className="flex h-full flex-col gap-3 p-4 @container md:p-6" data-testid="graph-page">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-title font-semibold text-foreground">{t(($) => $.page.title)}</h1>
          <p className="text-caption text-muted-foreground">{t(($) => $.page.subtitle)}</p>
        </div>
        <div className="text-micro text-muted-foreground tabular-nums" data-testid="graph-counts">
          {t(($) => $.counts.nodes, { count: model.nodes.length })}
          {model.meetings.length > 0 ? ` · ${t(($) => $.counts.meetings, { count: model.meetings.length })}` : ""}
          {model.executions.length > 0 ? ` · ${t(($) => $.counts.executions, { count: model.executions.length })}` : ""}
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
              onOpenIssue={openIssue}
              onOpenMeeting={openMeeting}
              onOpenExecution={openExecution}
              onFocusNeighbors={onFocusNeighbors}
              selectedEdgeCounts={selectedEdgeCounts}
            />
            <GraphLegend colorBy={colorBy} projects={projects} edgeGroups={edgeGroups} />
          </>
        )}
      </div>
    </div>
  );
}
