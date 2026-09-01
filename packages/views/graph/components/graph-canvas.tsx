"use client";

// Canvas force-directed renderer for the issue graph. All layout math,
// filtering, and graph semantics live in @multica/core/graph — this component
// only renders a GraphModel and reports pointer interaction. It owns the
// d3-force simulation, the zoom/pan transform, hover/selection highlight, and
// label falloff by zoom level (the Obsidian graph look).
//
// Colors come from the design tokens (tokens.css) read at runtime, so light
// and dark themes both work without a prop; a MutationObserver on <html>
// re-reads the palette when the theme class flips.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Eye, Focus } from "lucide-react";
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
  matchesQuery,
  nodeRadius,
  projectColorIndex,
  type GraphModel,
  type GraphNode,
} from "@multica/core/graph/build-graph-model";
import type { Project } from "@multica/core/types";
import { useT } from "../../i18n";
import { formatGraphTimestamp, statusDotClass } from "./graph-format";

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
  /** Menu action: open the issue's detail page. */
  onOpenIssue: (id: string) => void;
  /** Menu action: keep only the node's relatives (focus 1 hop) and center it. */
  onFocusNeighbors: (id: string) => void;
  /** Per-group edge counts for the selected node (computed on the full model
   *  so the counts survive focus filtering); null when nothing is selected. */
  selectedEdgeCounts: { child: number; dependency: number; mention: number } | null;
}

interface SimNode extends SimulationNodeDatum {
  id: string;
  label: string;
  title: string;
  statusCategory: string;
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
  edges: Record<EdgeColorGroup, string>;
}

// Edge colour groups mirror the toolbar's relation toggles: one hue per group
// (sub-issue / dependency / reference), independent of the node palette.
type EdgeColorGroup = "child" | "dependency" | "mention";

const EDGE_COLOR_VARS: Record<EdgeColorGroup, string> = {
  child: "--graph-edge-child",
  dependency: "--graph-edge-dependency",
  mention: "--graph-edge-mention",
};

function edgeColorGroup(kind: string): EdgeColorGroup {
  if (kind === "child") return "child";
  if (kind === "blocks" || kind === "blocked_by" || kind === "related") return "dependency";
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
    edges: Object.fromEntries(
      Object.entries(EDGE_COLOR_VARS).map(([k, name]) => [k, v(name)]),
    ) as Record<EdgeColorGroup, string>,
  };
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
  const [tooltip, setTooltip] = useState<{ x: number; y: number; node: GraphNode } | null>(null);
  // Node the preview card is pinned to; cleared whenever the selection moves.
  const [previewId, setPreviewId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  const projectIds = useMemo(() => projects.map((p) => p.id), [projects]);

  const menuOpen = selectedId !== null && model.nodes.some((n) => n.id === selectedId);
  // The preview card is derived, not cleared in an effect: a selection change
  // must never paint one frame with the old card still pinned to its node.
  const previewNode =
    previewId !== null && previewId === selectedId
      ? model.nodes.find((n) => n.id === previewId) ?? null
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
    const nodes: SimNode[] = model.nodes.map((n, i) => {
      const degree = model.degree.get(n.id) ?? 0;
      const p = prev.get(n.id);
      const angle = (2 * Math.PI * i) / Math.max(model.nodes.length, 1);
      // Isolated nodes start near the center: nothing anchors them, so an
      // outer-ring start plus repulsion leaves them stranded at the rim.
      const ring = degree === 0 ? 24 + ((i * 53) % 80) : 120 + ((i * 37) % 160);
      return {
        id: n.id,
        label: n.identifier,
        title: n.title,
        statusCategory: n.status_category,
        radius: nodeRadius(degree),
        degree,
        color: palette ? nodeColor(n, palette) : "gray",
        x: p?.x ?? width / 2 + ring * Math.cos(angle),
        y: p?.y ?? height / 2 + ring * Math.sin(angle),
      };
    });
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
    const selected = selectedId !== null && model.nodes.some((n) => n.id === selectedId) ? selectedId : null;
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
      ctx.globalAlpha = inFocus ? 0.95 : 0.32;
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
      ctx.beginPath();
      ctx.arc(x, y, n.radius, 0, Math.PI * 2);
      ctx.fillStyle = n.color;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = p.background;
      ctx.stroke();

      const isQueryMatch = searchQuery !== "" && matchesQuery(
        {
          id: n.id,
          identifier: n.label,
          number: 0,
          title: n.title,
          status: "",
          status_category: n.statusCategory,
          priority: "none",
          project_id: null,
          updated_at: "",
          assignee_name: "",
        },
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
    const byId = new Map(model.nodes.map((n) => [n.id, n]));
    for (const sn of nodesRef.current) {
      const n = byId.get(sn.id);
      if (n) sn.color = nodeColor(n, p);
    }
  }, [model, nodeColor]);

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
        const byId = new Map(model.nodes.map((n) => [n.id, n]));
        const n = byId.get(hit.id);
        if (n) {
          // Clamp so the card never spills past the canvas's right edge.
          const wrapWidth = wrapRef.current?.clientWidth ?? 800;
          setTooltip({ x: Math.min(pt.x + 14, wrapWidth - TOOLTIP_WIDTH - 8), y: pt.y + 14, node: n });
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
      if (hit) onToggleCollapse(hit.id);
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
        <GraphTooltip
          x={tooltip.x}
          y={tooltip.y}
          node={tooltip.node}
          projects={projects}
          statusColor={palette ? palette.status[tooltip.node.status_category] ?? palette.muted : undefined}
          degree={model.degree.get(tooltip.node.id) ?? 0}
        />
      ) : null}
      {menuOpen && selectedId ? (
        <GraphNodeMenu
          anchorRef={menuRef}
          nodeId={selectedId}
          previewOpen={previewId === selectedId}
          onOpen={() => onOpenIssue(selectedId)}
          onPreview={() => setPreviewId((prev) => (prev === selectedId ? null : selectedId))}
          onIsolate={() => onFocusNeighbors(selectedId)}
        />
      ) : null}
      {previewNode ? (
        <GraphNodePreview
          anchorRef={previewRef}
          node={previewNode}
          projects={projects}
          edgeCounts={selectedEdgeCounts}
          onClose={() => setPreviewId(null)}
          onOpen={() => onOpenIssue(previewNode.id)}
        />
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
  previewOpen: boolean;
  onOpen: () => void;
  onPreview: () => void;
  onIsolate: () => void;
}) {
  const { t } = useT("graph");
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
      label: t(($) => $.menu.open),
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
  edgeCounts: { child: number; dependency: number; mention: number } | null;
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
