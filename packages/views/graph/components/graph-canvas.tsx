"use client";

// Canvas force-directed renderer for the graph. All layout math, filtering,
// and graph semantics live in @multica/core/graph — this component only
// renders a GraphModel and reports pointer interaction. It owns the d3-force
// simulation, the zoom/pan transform, hover/selection highlight, and label
// falloff by zoom level (the Obsidian graph look).
//
// Three entity types share the canvas: issues are circles coloured by the
// active dimension, meetings are amber diamonds (fixed identity hue — the
// entity type must read before the colouring rule), executions are small
// rounded squares coloured by run status. Glyphs (calendar / play) only
// appear past the all-labels zoom threshold, where they are legible.
//
// Colors come from the design tokens (tokens.css) read at runtime, so light
// and dark themes both work without a prop; a MutationObserver on <html>
// re-reads the palette when the theme class flips.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Eye, Focus, CalendarDays, Play } from "lucide-react";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import {
  graphAddressEntity,
  graphExecutionAddress,
  graphMeetingAddress,
  matchesQuery,
  nodeRadius,
  projectColorIndex,
  type GraphEntity,
  type GraphExecutionNode,
  type GraphMeetingNode,
  type GraphModel,
  type GraphNode,
} from "@multica/core/graph/build-graph-model";
import type { Project } from "@multica/core/types";
import { useT } from "../../i18n";
import { formatGraphTimestamp, formatRunDuration, runStatusDotClass, statusDotClass } from "./graph-format";

export interface GraphCanvasProps {
  model: GraphModel;
  projects: Project[];
  colorBy: "project" | "status";
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onToggleCollapse: (id: string) => void;
  /** Bump `nonce` to re-center on `id` (e.g. a search result was picked). */
  centerOn: { id: string; nonce: number } | null;
  /** Search query: matching nodes keep their labels even when zoomed out. */
  searchQuery: string;
  /** Menu action: open the node's own page (issue detail / cockpit meeting
   *  panel / the run anchored in its issue's timeline). The id is the RAW
   *  entity id — never the mtg:/run: graph address. */
  onOpenIssue: (id: string) => void;
  onOpenMeeting: (id: string) => void;
  onOpenExecution: (exec: GraphExecutionNode) => void;
  /** Menu action: keep only the node's relatives (focus 1 hop) and center it. */
  onFocusNeighbors: (id: string) => void;
  /** Per-group edge counts for the selected node (computed on the full model
   *  so the counts survive focus filtering); null when nothing is selected. */
  selectedEdgeCounts: { child: number; dependency: number; mention: number; meeting: number; execution: number } | null;
}

interface SimNode extends SimulationNodeDatum {
  /** Graph address: raw UUID for issues, mtg:/run: prefixed otherwise. */
  id: string;
  /** Raw entity id (no prefix) — what open actions and links need. */
  refId: string;
  entity: GraphEntity;
  label: string;
  title: string;
  statusCategory: string;
  /** Execution nodes only: the run's own status drives the colour. */
  runStatus: string;
  radius: number;
  /** Filtered degree; isolated nodes (0) get a stronger center pull. */
  degree: number;
  color: string;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  kind: string;
}

interface Palette {
  background: string;
  foreground: string;
  muted: string;
  border: string;
  accent: string;
  projects: string[];
  status: Record<string, string>;
  meeting: string;
  runs: Record<string, string>;
  edges: Record<EdgeColorGroup, string>;
}

// Edge colour groups mirror the toolbar's relation toggles: one hue per group
// (sub-issue / dependency / reference / meeting / execution), independent of
// the node palette.
type EdgeColorGroup = "child" | "dependency" | "mention" | "meeting" | "execution";

const EDGE_COLOR_VARS: Record<EdgeColorGroup, string> = {
  child: "--graph-edge-child",
  dependency: "--graph-edge-dependency",
  mention: "--graph-edge-mention",
  meeting: "--graph-edge-meeting",
  execution: "--graph-edge-execution",
};

function edgeColorGroup(kind: string): EdgeColorGroup {
  if (kind === "child") return "child";
  if (kind === "blocks" || kind === "blocked_by" || kind === "related") return "dependency";
  if (kind === "meeting" || kind === "meeting_run") return "meeting";
  if (kind === "execution") return "execution";
  return "mention";
}

const STATUS_CATEGORY_VARS: Record<string, string> = {
  backlog: "--muted-foreground",
  todo: "--muted-foreground",
  in_progress: "--warning",
  in_review: "--success",
  done: "--info",
  blocked: "--destructive",
  cancelled: "--muted-foreground",
};

const PROJECT_COLOR_VARS = [
  "--graph-node-1",
  "--graph-node-2",
  "--graph-node-3",
  "--graph-node-4",
  "--graph-node-5",
];

// Execution nodes carry status semantics, not a project hue: a run's only
// interesting question is how it ended (or that it hasn't yet).
const RUN_STATUS_VARS: Record<string, string> = {
  queued: "--muted-foreground",
  dispatched: "--warning",
  running: "--warning",
  completed: "--success",
  failed: "--destructive",
  cancelled: "--muted-foreground",
};

function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim() || "gray";
  return {
    background: v("--background"),
    foreground: v("--foreground"),
    muted: v("--muted-foreground"),
    border: v("--border"),
    accent: v("--accent"),
    projects: PROJECT_COLOR_VARS.map(v),
    status: Object.fromEntries(
      Object.entries(STATUS_CATEGORY_VARS).map(([k, name]) => [k, v(name)]),
    ),
    meeting: v("--graph-node-meeting"),
    runs: Object.fromEntries(
      Object.entries(RUN_STATUS_VARS).map(([k, name]) => [k, v(name)]),
    ),
    edges: Object.fromEntries(
      Object.entries(EDGE_COLOR_VARS).map(([k, name]) => [k, v(name)]),
    ) as Record<EdgeColorGroup, string>,
  };
}

/** One node's body in world space: circle for issues, diamond for meetings,
 *  rounded square for executions — the entity type reads from the silhouette
 *  alone, the colour never has to carry it. */
function drawNodeShape(ctx: CanvasRenderingContext2D, n: SimNode, p: Palette) {
  const x = n.x ?? 0;
  const y = n.y ?? 0;
  ctx.beginPath();
  if (n.entity === "meeting") {
    ctx.moveTo(x, y - n.radius);
    ctx.lineTo(x + n.radius, y);
    ctx.lineTo(x, y + n.radius);
    ctx.lineTo(x - n.radius, y);
    ctx.closePath();
  } else if (n.entity === "execution") {
    const r = n.radius * 0.32;
    const h = n.radius;
    ctx.moveTo(x - h + r, y - h);
    ctx.arcTo(x + h, y - h, x + h, y + h, r);
    ctx.arcTo(x + h, y + h, x - h, y + h, r);
    ctx.arcTo(x - h, y + h, x - h, y - h, r);
    ctx.arcTo(x - h, y - h, x + h, y - h, r);
    ctx.closePath();
  } else {
    ctx.arc(x, y, n.radius, 0, Math.PI * 2);
  }
  ctx.fillStyle = n.color;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = p.background;
  ctx.stroke();
}

/** Calendar mark inside a meeting diamond: a page with two binding ticks. */
function drawCalendarGlyph(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, p: Palette) {
  const w = radius * 0.95;
  const h = radius * 0.8;
  ctx.strokeStyle = p.background;
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.rect(x - w / 2, y - h / 2, w, h);
  ctx.moveTo(x - w / 2, y - h / 2 + h * 0.32);
  ctx.lineTo(x + w / 2, y - h / 2 + h * 0.32);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - w * 0.2, y - h / 2 - 1.6);
  ctx.lineTo(x - w * 0.2, y - h / 2 + 1.6);
  ctx.moveTo(x + w * 0.2, y - h / 2 - 1.6);
  ctx.lineTo(x + w * 0.2, y - h / 2 + 1.6);
  ctx.stroke();
}

/** Play mark inside an execution square: the run as an action taken. */
function drawPlayGlyph(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, p: Palette) {
  const h = radius * 0.52;
  ctx.fillStyle = p.background;
  ctx.beginPath();
  ctx.moveTo(x - h * 0.55, y - h);
  ctx.lineTo(x + h * 0.85, y);
  ctx.lineTo(x - h * 0.55, y + h);
  ctx.closePath();
  ctx.fill();
}

/** Discriminated lookup across the three node arrays, by graph address. */
type AnyGraphNode =
  | { entity: "issue"; node: GraphNode }
  | { entity: "meeting"; node: GraphMeetingNode }
  | { entity: "execution"; node: GraphExecutionNode };

function lookupGraphNode(model: GraphModel, address: string): AnyGraphNode | null {
  const entity = graphAddressEntity(address);
  if (entity === "meeting") {
    const raw = address.slice(4);
    const node = model.meetings.find((m) => m.id === raw);
    return node ? { entity, node } : null;
  }
  if (entity === "execution") {
    const raw = address.slice(4);
    const node = model.executions.find((r) => r.id === raw);
    return node ? { entity, node } : null;
  }
  const node = model.nodes.find((n) => n.id === address);
  return node ? { entity, node } : null;
}

export function GraphCanvas(props: GraphCanvasProps) {
  const {
    model,
    projects,
    colorBy,
    selectedId,
    onSelect,
    onToggleCollapse,
    centerOn,
    searchQuery,
    onOpenIssue,
    onOpenMeeting,
    onOpenExecution,
    onFocusNeighbors,
    selectedEdgeCounts,
  } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const linksRef = useRef<SimLink[]>([]);
  const posRef = useRef(new Map<string, { x: number; y: number }>());
  const viewRef = useRef({ x: 0, y: 0, k: 1 });
  const hoverRef = useRef<string | null>(null);
  const dragRef = useRef<{
    id: string | null;
    moved: boolean;
    panning: boolean;
    lastX: number;
    lastY: number;
  }>({ id: null, moved: false, panning: false, lastX: 0, lastY: 0 });
  const [palette, setPalette] = useState<Palette | null>(null);
  const [tooltip, setTooltip] = useState<
    | { x: number; y: number; entity: "issue"; node: GraphNode }
    | { x: number; y: number; entity: "meeting"; node: GraphMeetingNode }
    | { x: number; y: number; entity: "execution"; node: GraphExecutionNode }
    | null
  >(null);
  // Node the preview card is pinned to; cleared whenever the selection moves.
  const [previewId, setPreviewId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  const projectIds = useMemo(() => projects.map((p) => p.id), [projects]);

  const menuOpen = selectedId !== null && lookupGraphNode(model, selectedId) !== null;
  // The preview card is derived, not cleared in an effect: a selection change
  // must never paint one frame with the old card still pinned to its node.
  const preview =
    previewId !== null && previewId === selectedId
      ? lookupGraphNode(model, previewId)
      : null;

  // Keep the radial menu and the preview card glued to their node across pan,
  // zoom, simulation ticks and node drags: draw() calls this every frame it
  // paints, and the layout effect below covers the frame an overlay appears
  // on. Positions are written straight to the DOM — the overlays must not
  // re-render React on every tick.
  const positionOverlays = useCallback(() => {
    const view = viewRef.current;
    const place = (
      el: HTMLElement | null,
      id: string | null,
      layout: (sx: number, sy: number, radius: number, k: number) => { x: number; y: number },
    ) => {
      if (!el || !id) return;
      const n = nodesRef.current.find((x) => x.id === id);
      if (!n) {
        el.style.display = "none";
        return;
      }
      el.style.display = "";
      const sx = (n.x ?? 0) * view.k + view.x;
      const sy = (n.y ?? 0) * view.k + view.y;
      const o = layout(sx, sy, n.radius, view.k);
      el.style.transform = `translate(${sx + o.x}px, ${sy + o.y}px)`;
    };
    place(menuRef.current, selectedId, () => ({ x: 0, y: 0 }));
    const wrapW = wrapRef.current?.clientWidth ?? 800;
    const wrapH = wrapRef.current?.clientHeight ?? 600;
    place(previewRef.current, previewId, (sx, sy, radius, k) => {
      // Anchor beside the node, flipping to the left / above when the card
      // would spill past the canvas edge, then clamping on both axes so a
      // tiny canvas still shows the card instead of flipping it off-screen.
      const gap = radius * k + 12;
      const w = previewRef.current?.offsetWidth || PREVIEW_WIDTH;
      const h = previewRef.current?.offsetHeight || 220;
      const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(hi, lo));
      const x = clamp(
        sx + gap + w <= wrapW - 8 ? gap : -(gap + w),
        8 - sx,
        Math.max(wrapW - w - 8, 8) - sx,
      );
      const y = clamp(
        sy + gap + h <= wrapH - 8 ? gap : -(gap + h),
        8 - sy,
        Math.max(wrapH - h - 8, 8) - sy,
      );
      return { x, y };
    });
  }, [selectedId, previewId]);

  useLayoutEffect(() => {
    positionOverlays();
  }, [positionOverlays]);

  // Indirection so long-lived handlers (simulation ticks, wheel, center-on)
  // always run the latest draw. draw's identity changes with search/selection
  // state; the simulation effect intentionally does not rebuild on those.
  const drawRef = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    drawRef.current = draw;
  });


  const nodeColor = useCallback(
    (n: GraphNode, p: Palette): string => {
      if (colorBy === "status") {
        return p.status[n.status_category] ?? p.muted;
      }
      const idx = projectColorIndex(n.project_id, projectIds);
      if (n.project_id === null) return p.muted;
      return p.projects[idx % p.projects.length] ?? p.muted;
    },
    [colorBy, projectIds],
  );

  // Meetings ignore the colour dimension on purpose: the amber diamond IS the
  // "this is a meeting" signal, and repainting it per project would read as a
  // second issue palette. Executions take their run status instead.
  const meetingColor = useCallback((_id: string, p: Palette): string => p.meeting, []);
  const executionColor = useCallback(
    (r: GraphExecutionNode, p: Palette): string => p.runs[r.status] ?? p.muted,
    [],
  );

  // Theme flips swap the token values under <html>.dark — re-read the palette.
  useLayoutEffect(() => {
    setPalette(readPalette());
    const observer = new MutationObserver(() => setPalette(readPalette()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  // (Re)build the simulation whenever the filtered model changes, seeding
  // previous positions so filter toggles do not scramble the layout.
  useEffect(() => {
    const width = wrapRef.current?.clientWidth ?? 800;
    const height = wrapRef.current?.clientHeight ?? 600;
    const prev = posRef.current;
    const totalCount = model.nodes.length + model.meetings.length + model.executions.length;
    const spawn = (id: string, i: number, degree: number) => {
      const p = prev.get(id);
      const angle = (2 * Math.PI * i) / Math.max(totalCount, 1);
      // Isolated nodes start near the center: nothing anchors them, so an
      // outer-ring start plus repulsion leaves them stranded at the rim.
      const ring = degree === 0 ? 24 + ((i * 53) % 80) : 120 + ((i * 37) % 160);
      return {
        x: p?.x ?? width / 2 + ring * Math.cos(angle),
        y: p?.y ?? height / 2 + ring * Math.sin(angle),
      };
    };
    const nodes: SimNode[] = [
      ...model.nodes.map((n, i) => {
        const degree = model.degree.get(n.id) ?? 0;
        return {
          id: n.id,
          refId: n.id,
          entity: "issue" as const,
          label: n.identifier,
          title: n.title,
          statusCategory: n.status_category,
          runStatus: "",
          radius: nodeRadius(degree),
          degree,
          color: palette ? nodeColor(n, palette) : "gray",
          ...spawn(n.id, i, degree),
        };
      }),
      ...model.meetings.map((m, i) => {
        const addr = graphMeetingAddress(m.id);
        const degree = model.degree.get(addr) ?? 0;
        return {
          id: addr,
          refId: m.id,
          entity: "meeting" as const,
          label: m.code || m.title,
          title: m.title,
          statusCategory: "",
          runStatus: "",
          // A meeting reads as a hub of its day: keep it slightly larger than
          // a bare formula would, so the diamond stays recognizable at a
          // glance without dwarfing issue hubs.
          radius: Math.max(nodeRadius(degree), 8),
          degree,
          color: palette ? meetingColor(m.id, palette) : "gray",
          ...spawn(addr, model.nodes.length + i, degree),
        };
      }),
      ...model.executions.map((r, i) => {
        const addr = graphExecutionAddress(r.id);
        const degree = model.degree.get(addr) ?? 0;
        return {
          id: addr,
          refId: r.id,
          entity: "execution" as const,
          label: r.agent_name,
          title: r.agent_name,
          statusCategory: "",
          runStatus: r.status,
          // Runs are leaf annotations of their issue — deliberately smaller
          // than every other node so they never compete for hub attention.
          radius: Math.max(nodeRadius(degree) * 0.72, 4),
          degree,
          color: palette ? executionColor(r, palette) : "gray",
          ...spawn(addr, model.nodes.length + model.meetings.length + i, degree),
        };
      }),
    ];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links: SimLink[] = model.edges
      .map((e) => ({
        source: e.source,
        target: e.target,
        kind: e.kind,
      }))
      .filter((l) => byId.has(l.source as string) && byId.has(l.target as string));

    nodesRef.current = nodes;
    linksRef.current = links;

    simRef.current?.stop();
    const sim = forceSimulation<SimNode, SimLink>(nodes)
      .force(
        "link",
        forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance(60)
          .strength(0.35),
      )
      .force("charge", forceManyBody<SimNode>().strength(-160))
      .force("collide", forceCollide<SimNode>((d) => d.radius + 6))
      // Linked nodes only need a weak centering bias — their links shape the
      // layout — but isolated ones have nothing holding them, so they get a
      // several-times stronger pull to cluster around the center instead of
      // drifting to the canvas rim.
      .force("x", forceX<SimNode>(width / 2).strength((d) => (d.degree === 0 ? 0.18 : 0.04)))
      .force("y", forceY<SimNode>(height / 2).strength((d) => (d.degree === 0 ? 0.22 : 0.06)))
      .alpha(0.9)
      .alphaDecay(0.03);
    sim.on("tick", () => {
      for (const n of nodes) posRef.current.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
      drawRef.current();
    });
    simRef.current = sim;
    drawRef.current();
    return () => {
      sim.stop();
      simRef.current = null;
    };
    // palette intentionally excluded: recoloring happens in draw() via a ref
    // of the latest palette, not by rebuilding the simulation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, nodeColor]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const p = paletteRef.current;
    const nodes = nodesRef.current;
    const links = linksRef.current;
    const view = viewRef.current;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    if (!p) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    // World-space elements draw under the pan/zoom view transform, so wheel
    // zoom and drag panning move them; labels are drawn later in screen space
    // to keep a constant font size regardless of zoom (the Obsidian look).
    ctx.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * view.x, dpr * view.y);

    const hovered = hoverRef.current;
    // A selection can outlive the node's presence in the scoped model
    // (toolbar filters, collapse, a refetch). Treat it as absent — keeping a
    // ghost id would dim every node out of an empty highlight set.
    const selected = selectedId !== null && lookupGraphNode(model, selectedId) !== null ? selectedId : null;
    // Highlight set: the hovered (or selected) node plus its neighbors.
    let focusSet: Set<string> | null = null;
    const focusId = hovered ?? selected;
    if (focusId) {
      focusSet = new Set<string>([focusId, ...(model.neighbors.get(focusId) ?? [])]);
    }

    const toWorld = (sx: number, sy: number) => ({ x: (sx - view.x) / view.k, y: (sy - view.y) / view.k });
    void toWorld;

    // Edges. One hue per relation group (independent of the node palette),
    // styled by kind: child=solid, mention=dashed, related=dotted,
    // blocks/blocked_by=solid with an arrowhead at the target. Strokes live in
    // world space, so a screen-space floor keeps zoomed-out edges from
    // thinning into invisibility — the whole point of an overview graph.
    for (const link of links) {
      const s = link.source as SimNode;
      const t = link.target as SimNode;
      if (!s || !t) continue;
      const inFocus = !focusSet || (focusSet.has(s.id) && focusSet.has(t.id));
      const color = p.edges[edgeColorGroup(link.kind)];
      // Derived meeting→run links stay quieter than direct ones so the
      // indirect relation never visually competes with the direct pair.
      const derived = link.kind === "meeting_run";
      ctx.globalAlpha = derived ? (inFocus ? 0.5 : 0.18) : inFocus ? 0.95 : 0.32;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      const width = inFocus ? 2 : 1.25;
      ctx.lineWidth = Math.max(width * view.k, 0.8);
      const x1 = s.x ?? 0;
      const y1 = s.y ?? 0;
      const x2 = t.x ?? 0;
      const y2 = t.y ?? 0;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const pad1 = s.radius + 2;
      const pad2 = t.radius + (link.kind === "blocks" || link.kind === "blocked_by" ? 8 : 2);
      const ax1 = x1 + ux * pad1;
      const ay1 = y1 + uy * pad1;
      const ax2 = x2 - ux * pad2;
      const ay2 = y2 - uy * pad2;

      ctx.beginPath();
      if (link.kind === "mention") {
        ctx.setLineDash([5, 4]);
      } else if (link.kind === "related") {
        ctx.setLineDash([2, 4]);
      } else if (link.kind === "execution") {
        ctx.setLineDash([3, 3]);
      } else if (link.kind === "meeting_run") {
        ctx.setLineDash([2, 5]);
      } else {
        ctx.setLineDash([]);
      }
      ctx.moveTo(ax1, ay1);
      ctx.lineTo(ax2, ay2);
      ctx.stroke();
      ctx.setLineDash([]);

      if (link.kind === "blocks" || link.kind === "blocked_by") {
        const arrow = 7;
        ctx.beginPath();
        ctx.moveTo(x2 - ux * (t.radius + 2), y2 - uy * (t.radius + 2));
        ctx.lineTo(x2 - ux * (t.radius + 2 + arrow) - uy * arrow * 0.6, y2 - uy * (t.radius + 2 + arrow) + ux * arrow * 0.6);
        ctx.lineTo(x2 - ux * (t.radius + 2 + arrow) + uy * arrow * 0.6, y2 - uy * (t.radius + 2 + arrow) - ux * arrow * 0.6);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // Nodes are drawn in world space (inside the view transform above);
    // labels are collected and drawn afterwards in screen space so their font
    // size stays constant while zooming.
    const labels: Array<{ x: number; y: number; text: string; alpha: number }> = [];
    const showAllLabels = view.k >= 1.1;
    const showHubLabels = view.k >= 0.6;
    for (const n of nodes) {
      const inFocus = !focusSet || focusSet.has(n.id);
      ctx.globalAlpha = inFocus ? 1 : 0.15;
      const x = n.x ?? 0;
      const y = n.y ?? 0;
      if (n.id === selected || n.id === hovered) {
        ctx.beginPath();
        ctx.arc(x, y, n.radius + 3.5, 0, Math.PI * 2);
        ctx.strokeStyle = p.accent;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      drawNodeShape(ctx, n, p);

      // Glyphs only past the all-labels zoom: below it they render as smudges.
      if (view.k >= 1.1) {
        if (n.entity === "meeting") drawCalendarGlyph(ctx, x, y, n.radius, p);
        else if (n.entity === "execution") drawPlayGlyph(ctx, x, y, n.radius, p);
      }

      const isQueryMatch = searchQuery !== "" && matchesQuery(
        { identifier: n.label, title: n.title },
        searchQuery,
      );
      const degree = model.degree.get(n.id) ?? 0;
      const labelWanted =
        n.id === hovered ||
        n.id === selected ||
        isQueryMatch ||
        (showAllLabels && degree > 0) ||
        (showHubLabels && degree >= 4);
      if (labelWanted) {
        labels.push({
          x: x * view.k + view.x,
          y: (y + n.radius + 3) * view.k + view.y,
          text: n.label,
          alpha: inFocus ? 0.9 : 0.1,
        });
      }
      ctx.globalAlpha = 1;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = `${view.k >= 1.1 ? 12 : 11}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillStyle = p.foreground;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const l of labels) {
      ctx.globalAlpha = l.alpha;
      ctx.fillText(l.text, l.x, l.y);
    }
    ctx.globalAlpha = 1;

    positionOverlays();
  }, [model, searchQuery, selectedId, positionOverlays]);

  // Keep a ref of the palette so draw() always reads the current one without
  // being a dependency that rebuilds the simulation. The recolor effect below
  // is what mirrors `palette` into it.
  const paletteRef = useRef<Palette | null>(null);

  // Resize handling: match the backing store to the element box * DPR.
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const apply = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(wrap.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(wrap.clientHeight * dpr));
      canvas.style.width = `${wrap.clientWidth}px`;
      canvas.style.height = `${wrap.clientHeight}px`;
      draw();
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [draw]);

  // Recolor in place (no relayout) whenever the palette resolves, the theme
  // flips, or the color dimension changes. Covers first mount too, where the
  // simulation may be built before readPalette() has produced a value.
  const recolor = useCallback(() => {
    const p = paletteRef.current;
    if (!p) return;
    const issues = new Map(model.nodes.map((n) => [n.id, n]));
    const meetings = new Map(model.meetings.map((n) => [graphMeetingAddress(n.id), n]));
    const runs = new Map(model.executions.map((n) => [graphExecutionAddress(n.id), n]));
    for (const sn of nodesRef.current) {
      if (sn.entity === "meeting") {
        if (meetings.has(sn.id)) sn.color = meetingColor(sn.refId, p);
        continue;
      }
      if (sn.entity === "execution") {
        const r = runs.get(sn.id);
        if (r) sn.color = executionColor(r, p);
        continue;
      }
      const n = issues.get(sn.id);
      if (n) sn.color = nodeColor(n, p);
    }
  }, [model, nodeColor, meetingColor, executionColor]);

  useEffect(() => {
    paletteRef.current = palette;
    recolor();
    draw();
  }, [palette, recolor, draw]);

  // Center-on request (search pick): translate the picked node to center.
  // Keyed on the request only — re-running it on a draw identity change would
  // re-snap the viewport whenever unrelated view state updates.
  useEffect(() => {
    if (!centerOn) return;
    const n = nodesRef.current.find((x) => x.id === centerOn.id);
    const canvas = canvasRef.current;
    if (!n || !canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    viewRef.current = { k: Math.max(viewRef.current.k, 1), x: width / 2 - (n.x ?? 0) * viewRef.current.k, y: height / 2 - (n.y ?? 0) * viewRef.current.k };
    drawRef.current();
  }, [centerOn]);

  const nodeAt = useCallback((sx: number, sy: number): SimNode | null => {
    const view = viewRef.current;
    const wx = (sx - view.x) / view.k;
    const wy = (sy - view.y) / view.k;
    let best: SimNode | null = null;
    let bestDist = Infinity;
    for (const n of nodesRef.current) {
      const d = Math.hypot((n.x ?? 0) - wx, (n.y ?? 0) - wy);
      if (d < n.radius + 5 && d < bestDist) {
        best = n;
        bestDist = d;
      }
    }
    return best;
  }, []);

  const localPoint = useCallback((e: PointerEvent | React.PointerEvent | React.MouseEvent | WheelEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const pt = localPoint(e);
      const hit = nodeAt(pt.x, pt.y);
      dragRef.current = {
        id: hit?.id ?? null,
        moved: false,
        panning: !hit,
        lastX: pt.x,
        lastY: pt.y,
      };
      if (hit) {
        const sim = simRef.current;
        if (sim) sim.alphaTarget(0.25).restart();
        // The press starts a possible node drag — the hover tooltip under the
        // pointer would otherwise linger for the whole drag.
        setTooltip(null);
      }
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [localPoint, nodeAt],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const pt = localPoint(e);
      const drag = dragRef.current;
      if (drag.id || drag.panning) {
        if (Math.hypot(pt.x - drag.lastX, pt.y - drag.lastY) > 2) drag.moved = true;
        if (drag.id) {
          const view = viewRef.current;
          const n = nodesRef.current.find((x) => x.id === drag.id);
          if (n) {
            n.fx = (pt.x - view.x) / view.k;
            n.fy = (pt.y - view.y) / view.k;
            posRef.current.set(n.id, { x: n.fx, y: n.fy });
          }
        } else if (drag.panning) {
          viewRef.current = {
            ...viewRef.current,
            x: viewRef.current.x + (pt.x - drag.lastX),
            y: viewRef.current.y + (pt.y - drag.lastY),
          };
          drag.lastX = pt.x;
          drag.lastY = pt.y;
          draw();
          return;
        }
        drag.lastX = pt.x;
        drag.lastY = pt.y;
        return;
      }
      // Hover detection with an HTML tooltip. The selected node shows the
      // radial menu instead — the tooltip would only duplicate it.
      const hit = nodeAt(pt.x, pt.y);
      const hitId = hit?.id ?? null;
      if (hitId !== hoverRef.current) {
        hoverRef.current = hitId;
        draw();
      }
      if (hit && hit.id !== selectedId) {
        const found = lookupGraphNode(model, hit.id);
        if (found) {
          // Clamp so the card never spills past the canvas's right edge.
          const wrapWidth = wrapRef.current?.clientWidth ?? 800;
          setTooltip({
            x: Math.min(pt.x + 14, wrapWidth - TOOLTIP_WIDTH - 8),
            y: pt.y + 14,
            entity: found.entity,
            node: found.node,
          } as typeof tooltip);
        }
      } else {
        setTooltip(null);
      }
    },
    [draw, localPoint, model, nodeAt, selectedId],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      const pt = localPoint(e);
      if (drag.id && !drag.moved) {
        // A clean click selects (clicking the selected node again clears).
        onSelect(drag.id === selectedId ? null : drag.id);
        // The pointer rarely moves between press and release, so the tooltip
        // under it would linger next to the menu — drop it here.
        setTooltip(null);
      } else if (drag.panning && !drag.moved) {
        onSelect(null);
      }
      if (drag.id) {
        // The dragged node keeps fx/fy, so it stays where the user put it.
        simRef.current?.alphaTarget(0);
      }
      dragRef.current = { id: null, moved: false, panning: false, lastX: pt.x, lastY: pt.y };
    },
    [localPoint, onSelect, selectedId],
  );

  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const pt = localPoint(e);
      const hit = nodeAt(pt.x, pt.y);
      // Branch folding is an issue-only gesture: meetings and runs never have
      // child edges, so double-clicking one would be a no-op that still
      // flashes the simulation.
      if (hit && hit.entity === "issue") onToggleCollapse(hit.id);
    },
    [localPoint, nodeAt, onToggleCollapse],
  );

  // Non-react wheel: zoom around the cursor. Attached to the wrap (not the
  // canvas element) so wheel events over the menu buttons and the preview
  // card still zoom the graph instead of dying in a dead zone.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const view = viewRef.current;
      const k = Math.min(4, Math.max(0.15, view.k * Math.exp(-e.deltaY * 0.0015)));
      viewRef.current = {
        k,
        x: sx - ((sx - view.x) / view.k) * k,
        y: sy - ((sy - view.y) / view.k) * k,
      };
      drawRef.current();
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden rounded-lg border bg-background">
      <canvas
        ref={canvasRef}
        className="block h-full w-full touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          hoverRef.current = null;
          setTooltip(null);
          draw();
        }}
        onDoubleClick={onDoubleClick}
      />
      {tooltip ? (
        tooltip.entity === "meeting" ? (
          <GraphMeetingTooltip x={tooltip.x} y={tooltip.y} node={tooltip.node as GraphMeetingNode}
            accentColor={palette?.meeting} degree={model.degree.get(graphMeetingAddress((tooltip.node as GraphMeetingNode).id)) ?? 0} />
        ) : tooltip.entity === "execution" ? (
          <GraphExecutionTooltip x={tooltip.x} y={tooltip.y} node={tooltip.node as GraphExecutionNode}
            issues={model.nodes}
            statusColor={palette ? palette.runs[(tooltip.node as GraphExecutionNode).status] ?? palette.muted : undefined} />
        ) : (
          <GraphTooltip
            x={tooltip.x}
            y={tooltip.y}
            node={tooltip.node as GraphNode}
            projects={projects}
            statusColor={palette ? palette.status[(tooltip.node as GraphNode).status_category] ?? palette.muted : undefined}
            degree={model.degree.get(tooltip.node.id) ?? 0}
          />
        )
      ) : null}
      {menuOpen && selectedId ? (() => {
        const sel = lookupGraphNode(model, selectedId);
        if (!sel) return null;
        const open = sel.entity === "meeting"
          ? () => onOpenMeeting(sel.node.id)
          : sel.entity === "execution"
            ? () => onOpenExecution(sel.node as GraphExecutionNode)
            : () => onOpenIssue(sel.node.id);
        return (
          <GraphNodeMenu
            anchorRef={menuRef}
            nodeId={selectedId}
            entity={sel.entity}
            previewOpen={previewId === selectedId}
            onOpen={open}
            onPreview={() => setPreviewId((prev) => (prev === selectedId ? null : selectedId))}
            onIsolate={() => onFocusNeighbors(selectedId)}
          />
        );
      })() : null}
      {preview ? (
        preview.entity === "meeting" ? (
          <GraphMeetingPreview
            anchorRef={previewRef}
            node={preview.node as GraphMeetingNode}
            edgeCount={selectedEdgeCounts?.meeting ?? 0}
            onClose={() => setPreviewId(null)}
            onOpen={() => onOpenMeeting((preview.node as GraphMeetingNode).id)}
          />
        ) : preview.entity === "execution" ? (
          <GraphExecutionPreview
            anchorRef={previewRef}
            node={preview.node as GraphExecutionNode}
            issues={model.nodes}
            onClose={() => setPreviewId(null)}
            onOpen={() => onOpenExecution(preview.node as GraphExecutionNode)}
          />
        ) : (
          <GraphNodePreview
            anchorRef={previewRef}
            node={preview.node as GraphNode}
            projects={projects}
            edgeCounts={selectedEdgeCounts}
            onClose={() => setPreviewId(null)}
            onOpen={() => onOpenIssue(preview.node.id)}
          />
        )
      ) : null}
    </div>
  );
}

// Radial menu around the selected node: three round action buttons evenly
// spread on a circle (open / preview / keep-relatives-only). The container is
// a zero-size anchor translated onto the node; buttons position themselves
// around it in screen space, so the menu keeps its size at every zoom level.
const MENU_RADIUS = 46;

function GraphNodeMenu(props: {
  anchorRef: React.RefObject<HTMLDivElement | null>;
  nodeId: string;
  entity: GraphEntity;
  previewOpen: boolean;
  onOpen: () => void;
  onPreview: () => void;
  onIsolate: () => void;
}) {
  const { t } = useT("graph");
  const openLabel =
    props.entity === "meeting"
      ? t(($) => $.menu.open_meeting)
      : props.entity === "execution"
        ? t(($) => $.menu.open_run)
        : t(($) => $.menu.open);
  const actions: Array<{
    key: string;
    testId: string;
    angle: number;
    label: string;
    icon: React.ReactNode;
    onClick: () => void;
    active?: boolean;
  }> = [
    {
      key: "open",
      testId: "graph-menu-open",
      angle: -Math.PI / 2,
      label: openLabel,
      icon: <ExternalLink className="size-4" />,
      onClick: props.onOpen,
    },
    {
      key: "preview",
      testId: "graph-menu-preview",
      angle: Math.PI / 6,
      label: t(($) => $.menu.preview),
      icon: <Eye className="size-4" />,
      onClick: props.onPreview,
      active: props.previewOpen,
    },
    {
      key: "isolate",
      testId: "graph-menu-isolate",
      angle: (5 * Math.PI) / 6,
      label: t(($) => $.menu.isolate),
      icon: <Focus className="size-4" />,
      onClick: props.onIsolate,
    },
  ];
  return (
    <div
      ref={props.anchorRef}
      className="pointer-events-none absolute left-0 top-0 z-10 h-0 w-0"
      data-testid="graph-node-menu"
      data-node-id={props.nodeId}
    >
      {actions.map((a) => (
        <button
          key={a.key}
          type="button"
          className={`pointer-events-auto absolute flex size-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border bg-popover text-foreground shadow-[var(--floating-shadow)] transition-colors hover:bg-accent hover:text-accent-foreground ${
            a.active === true ? "border-primary text-primary" : ""
          }`}
          style={{ left: Math.cos(a.angle) * MENU_RADIUS, top: Math.sin(a.angle) * MENU_RADIUS }}
          aria-label={a.label}
          title={a.label}
          data-testid={a.testId}
          onClick={a.onClick}
        >
          {a.icon}
        </button>
      ))}
    </div>
  );
}

// Preview card pinned next to a node: the selected node's "at a glance" info
// (status, priority, assignee, project, updated, per-group link counts) with
// a direct open action — a compact stand-in for the issue page.
function GraphNodePreview(props: {
  anchorRef: React.RefObject<HTMLDivElement | null>;
  node: GraphNode;
  projects: Project[];
  edgeCounts: { child: number; dependency: number; mention: number; meeting: number; execution: number } | null;
  onClose: () => void;
  onOpen: () => void;
}) {
  const { node, projects, edgeCounts } = props;
  const { t } = useT("graph");
  const project = projects.find((p) => p.id === node.project_id) ?? null;
  const updated = formatGraphTimestamp(node.updated_at);
  return (
    <div
      ref={props.anchorRef}
      className="absolute left-0 top-0 z-10 w-72 rounded-lg border bg-popover p-3 shadow-[var(--floating-shadow)]"
      data-testid="graph-node-preview"
      data-node-id={node.id}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-micro text-muted-foreground">{node.identifier}</span>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground"
          aria-label={t(($) => $.card.dismiss)}
          onClick={props.onClose}
        >
          ×
        </button>
      </div>
      <p className="mt-0.5 text-body font-medium text-foreground">{node.title}</p>
      <dl className="mt-2 space-y-1 text-caption text-muted-foreground">
        <div className="flex items-center justify-between gap-2">
          <dt>{t(($) => $.fields.status)}</dt>
          <dd className="flex items-center gap-1.5 text-foreground">
            <span
              className={`inline-block size-2 rounded-full ${statusDotClass(node.status_category)}`}
              aria-hidden
            />
            {node.status}
          </dd>
        </div>
        {node.priority && node.priority !== "none" ? (
          <div className="flex justify-between gap-2">
            <dt>{t(($) => $.fields.priority)}</dt>
            <dd className="text-foreground">{node.priority}</dd>
          </div>
        ) : null}
        {node.assignee_name ? (
          <div className="flex justify-between gap-2">
            <dt>{t(($) => $.fields.assignee)}</dt>
            <dd className="truncate text-foreground">{node.assignee_name}</dd>
          </div>
        ) : null}
        {project ? (
          <div className="flex justify-between gap-2">
            <dt>{t(($) => $.fields.project)}</dt>
            <dd className="truncate text-foreground">
              {project.icon ? `${project.icon} ${project.title}` : project.title}
            </dd>
          </div>
        ) : null}
        {updated ? (
          <div className="flex justify-between gap-2">
            <dt>{t(($) => $.fields.updated)}</dt>
            <dd className="text-foreground">{updated}</dd>
          </div>
        ) : null}
        {edgeCounts ? (
          <div className="flex justify-between gap-2">
            <dt>{t(($) => $.fields.links)}</dt>
            <dd className="flex flex-wrap justify-end gap-x-2 tabular-nums text-foreground">
              <span style={{ color: "var(--graph-edge-child)" }}>
                {t(($) => $.fields.sub_issues, { count: edgeCounts.child })}
              </span>
              <span style={{ color: "var(--graph-edge-dependency)" }}>
                {t(($) => $.fields.dependencies, { count: edgeCounts.dependency })}
              </span>
              <span style={{ color: "var(--graph-edge-mention)" }}>
                {t(($) => $.fields.references, { count: edgeCounts.mention })}
              </span>
              {edgeCounts.meeting > 0 ? (
                <span style={{ color: "var(--graph-edge-meeting)" }}>
                  {t(($) => $.fields.meetings, { count: edgeCounts.meeting })}
                </span>
              ) : null}
              {edgeCounts.execution > 0 ? (
                <span style={{ color: "var(--graph-edge-execution)" }}>
                  {t(($) => $.fields.executions, { count: edgeCounts.execution })}
                </span>
              ) : null}
            </dd>
          </div>
        ) : null}
      </dl>
      <button
        type="button"
        className="mt-2 w-full rounded-md bg-primary px-2 py-1.5 text-caption font-medium text-primary-foreground hover:bg-primary/90"
        onClick={props.onOpen}
      >
        {t(($) => $.card.open)}
      </button>
    </div>
  );
}

const TOOLTIP_WIDTH = 256;
// w-72 preview card; the fallback used before the element can be measured.
const PREVIEW_WIDTH = 288;

function GraphTooltip(props: {
  x: number;
  y: number;
  node: GraphNode;
  projects: Project[];
  statusColor: string | undefined;
  degree: number;
}) {
  const { x, y, node, projects, statusColor, degree } = props;
  const { t } = useT("graph");
  const project = projects.find((p) => p.id === node.project_id) ?? null;
  const rows: Array<[string, React.ReactNode]> = [];
  const updated = formatGraphTimestamp(node.updated_at);
  if (node.priority && node.priority !== "none") {
    rows.push([t(($) => $.fields.priority), node.priority]);
  }
  if (node.assignee_name) {
    rows.push([t(($) => $.fields.assignee), node.assignee_name]);
  }
  if (project) {
    rows.push([
      t(($) => $.fields.project),
      project.icon ? `${project.icon} ${project.title}` : project.title,
    ]);
  }
  if (updated) {
    rows.push([t(($) => $.fields.updated), updated]);
  }
  rows.push([t(($) => $.fields.links), degree]);

  return (
    <div
      className="pointer-events-none absolute z-10 w-64 rounded-md border bg-popover px-2.5 py-2 text-caption shadow-[var(--floating-shadow)]"
      style={{ left: x, top: y }}
      data-testid="graph-tooltip"
    >
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-micro text-muted-foreground">{node.identifier}</span>
        {statusColor ? (
          <span
            className="inline-block size-2 rounded-full"
            style={{ backgroundColor: statusColor }}
            aria-hidden
          />
        ) : null}
        <span className="truncate text-micro text-muted-foreground">{node.status}</span>
      </div>
      <div className="mt-0.5 line-clamp-2 text-body font-medium text-foreground">{node.title}</div>
      <dl className="mt-1.5 space-y-0.5 text-micro text-muted-foreground">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-2">
            <dt>{label}</dt>
            <dd className="truncate text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Meeting / execution overlays. Same placement machinery as the issue tooltip
// and preview card; only the field set and the primary action differ.
// ---------------------------------------------------------------------------

function GraphMeetingTooltip(props: {
  x: number;
  y: number;
  node: GraphMeetingNode;
  accentColor: string | undefined;
  degree: number;
}) {
  const { x, y, node, accentColor, degree } = props;
  const { t } = useT("graph");
  const rows: Array<[string, React.ReactNode]> = [];
  if (node.meet_date) rows.push([t(($) => $.fields.meet_date), node.meet_date]);
  if (node.track) rows.push([t(($) => $.fields.track), node.track]);
  if (node.status) rows.push([t(($) => $.fields.status), node.status]);
  rows.push([t(($) => $.fields.links), degree]);
  return (
    <div
      className="pointer-events-none absolute z-10 w-64 rounded-md border bg-popover px-2.5 py-2 text-caption shadow-[var(--floating-shadow)]"
      style={{ left: x, top: y }}
      data-testid="graph-tooltip"
    >
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-micro text-muted-foreground">{node.code}</span>
        {accentColor ? (
          <span className="inline-block size-2 rotate-45" style={{ backgroundColor: accentColor }} aria-hidden />
        ) : null}
        <span className="truncate text-micro text-muted-foreground">{t(($) => $.entity.meeting)}</span>
      </div>
      <div className="mt-0.5 line-clamp-2 text-body font-medium text-foreground">{node.title}</div>
      <dl className="mt-1.5 space-y-0.5 text-micro text-muted-foreground">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-2">
            <dt>{label}</dt>
            <dd className="truncate text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function GraphExecutionTooltip(props: {
  x: number;
  y: number;
  node: GraphExecutionNode;
  issues: GraphNode[];
  statusColor: string | undefined;
}) {
  const { x, y, node, issues, statusColor } = props;
  const { t } = useT("graph");
  const issue = issues.find((n) => n.id === node.issue_id) ?? null;
  const duration = formatRunDuration(node.started_at, node.completed_at);
  const rows: Array<[string, React.ReactNode]> = [];
  if (issue) rows.push([t(($) => $.fields.belongs_to), issue.identifier]);
  rows.push([t(($) => $.fields.status), node.status]);
  if (duration) rows.push([t(($) => $.fields.duration), duration]);
  return (
    <div
      className="pointer-events-none absolute z-10 w-64 rounded-md border bg-popover px-2.5 py-2 text-caption shadow-[var(--floating-shadow)]"
      style={{ left: x, top: y }}
      data-testid="graph-tooltip"
    >
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-micro text-muted-foreground">{node.agent_name}</span>
        {statusColor ? (
          <span className="inline-block size-2 rounded-sm" style={{ backgroundColor: statusColor }} aria-hidden />
        ) : null}
        <span className="truncate text-micro text-muted-foreground">{t(($) => $.entity.execution)}</span>
      </div>
      <div className="mt-0.5 line-clamp-2 text-body font-medium text-foreground">
        {issue ? issue.title : node.agent_name}
      </div>
      <dl className="mt-1.5 space-y-0.5 text-micro text-muted-foreground">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-2">
            <dt>{label}</dt>
            <dd className="truncate text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function GraphMeetingPreview(props: {
  anchorRef: React.RefObject<HTMLDivElement | null>;
  node: GraphMeetingNode;
  edgeCount: number;
  onClose: () => void;
  onOpen: () => void;
}) {
  const { node, edgeCount } = props;
  const { t } = useT("graph");
  const [copied, setCopied] = useState(false);
  const copyNasDir = async () => {
    if (!node.nas_dir) return;
    try {
      await navigator.clipboard.writeText(node.nas_dir);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard needs permission and a secure context; the path stays
      // selectable in the card either way.
    }
  };
  return (
    <div
      ref={props.anchorRef}
      className="absolute left-0 top-0 z-10 w-72 rounded-lg border bg-popover p-3 shadow-[var(--floating-shadow)]"
      data-testid="graph-node-preview"
      data-node-id={graphMeetingAddress(node.id)}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-micro text-muted-foreground">{node.code}</span>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground"
          aria-label={t(($) => $.card.dismiss)}
          onClick={props.onClose}
        >
          ×
        </button>
      </div>
      <p className="mt-0.5 text-body font-medium text-foreground">{node.title}</p>
      <dl className="mt-2 space-y-1 text-caption text-muted-foreground">
        <div className="flex items-center justify-between gap-2">
          <dt>{t(($) => $.fields.entity_type)}</dt>
          <dd className="flex items-center gap-1.5 text-foreground">
            <CalendarDays className="size-3" aria-hidden />
            {t(($) => $.entity.meeting)}
          </dd>
        </div>
        {node.meet_date ? (
          <div className="flex justify-between gap-2">
            <dt>{t(($) => $.fields.meet_date)}</dt>
            <dd className="text-foreground">{node.meet_date}</dd>
          </div>
        ) : null}
        {node.track ? (
          <div className="flex justify-between gap-2">
            <dt>{t(($) => $.fields.track)}</dt>
            <dd className="truncate text-foreground">{node.track}</dd>
          </div>
        ) : null}
        {node.status ? (
          <div className="flex justify-between gap-2">
            <dt>{t(($) => $.fields.status)}</dt>
            <dd className="text-foreground">{node.status}</dd>
          </div>
        ) : null}
        <div className="flex justify-between gap-2">
          <dt>{t(($) => $.fields.links)}</dt>
          <dd className="tabular-nums text-foreground">
            {t(($) => $.fields.linked_issues, { count: edgeCount })}
          </dd>
        </div>
        {node.nas_dir ? (
          <div className="flex items-start justify-between gap-2">
            <dt className="shrink-0">{t(($) => $.fields.nas_dir)}</dt>
            <dd className="flex min-w-0 items-center justify-end gap-1.5">
              <span className="truncate font-mono text-micro text-foreground" title={node.nas_dir}>
                {node.nas_dir}
              </span>
              <button
                type="button"
                className="shrink-0 rounded border px-1 text-micro text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                onClick={copyNasDir}
                data-testid="graph-meeting-copy-nas"
              >
                {copied ? t(($) => $.fields.copied) : t(($) => $.fields.copy)}
              </button>
            </dd>
          </div>
        ) : null}
      </dl>
      <button
        type="button"
        className="mt-2 w-full rounded-md bg-primary px-2 py-1.5 text-caption font-medium text-primary-foreground hover:bg-primary/90"
        onClick={props.onOpen}
      >
        {t(($) => $.card.open_meeting)}
      </button>
    </div>
  );
}

function GraphExecutionPreview(props: {
  anchorRef: React.RefObject<HTMLDivElement | null>;
  node: GraphExecutionNode;
  issues: GraphNode[];
  onClose: () => void;
  onOpen: () => void;
}) {
  const { node, issues } = props;
  const { t } = useT("graph");
  const issue = issues.find((n) => n.id === node.issue_id) ?? null;
  const duration = formatRunDuration(node.started_at, node.completed_at);
  const finished = formatGraphTimestamp(node.completed_at);
  return (
    <div
      ref={props.anchorRef}
      className="absolute left-0 top-0 z-10 w-72 rounded-lg border bg-popover p-3 shadow-[var(--floating-shadow)]"
      data-testid="graph-node-preview"
      data-node-id={graphExecutionAddress(node.id)}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-micro text-muted-foreground">{node.agent_name}</span>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground"
          aria-label={t(($) => $.card.dismiss)}
          onClick={props.onClose}
        >
          ×
        </button>
      </div>
      <p className="mt-0.5 text-body font-medium text-foreground">
        {issue ? issue.title : t(($) => $.entity.execution)}
      </p>
      <dl className="mt-2 space-y-1 text-caption text-muted-foreground">
        <div className="flex items-center justify-between gap-2">
          <dt>{t(($) => $.fields.entity_type)}</dt>
          <dd className="flex items-center gap-1.5 text-foreground">
            <Play className="size-3" aria-hidden />
            {t(($) => $.entity.execution)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt>{t(($) => $.fields.status)}</dt>
          <dd className="flex items-center gap-1.5 text-foreground">
            <span className={`inline-block size-2 rounded-sm ${runStatusDotClass(node.status)}`} aria-hidden />
            {node.status}
          </dd>
        </div>
        {issue ? (
          <div className="flex justify-between gap-2">
            <dt>{t(($) => $.fields.belongs_to)}</dt>
            <dd className="truncate font-mono text-micro text-foreground">{issue.identifier}</dd>
          </div>
        ) : null}
        {duration ? (
          <div className="flex justify-between gap-2">
            <dt>{t(($) => $.fields.duration)}</dt>
            <dd className="tabular-nums text-foreground">{duration}</dd>
          </div>
        ) : null}
        {finished ? (
          <div className="flex justify-between gap-2">
            <dt>{t(($) => $.fields.finished_at)}</dt>
            <dd className="text-foreground">{finished}</dd>
          </div>
        ) : null}
      </dl>
      <button
        type="button"
        className="mt-2 w-full rounded-md bg-primary px-2 py-1.5 text-caption font-medium text-primary-foreground hover:bg-primary/90"
        onClick={props.onOpen}
      >
        {t(($) => $.card.open_run)}
      </button>
    </div>
  );
}
