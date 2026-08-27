"use client";

import { memo, useEffect, useRef, useState } from "react";

// Isometric drawing primitives for the Agent Office floor plan. Everything
// is plain SVG shapes — no image assets — positioned on a 2:1 isometric
// grid. The furniture needs concrete illustration colors, so this file keeps
// a tiny fixed palette (semantic tokens cannot express wood/steel shades);
// everything user-themed (names, bubbles, badges) stays in tokens.
export const TILE_W = 56;
export const TILE_H = 28;

/** Grid cell -> screen coordinates on the 2:1 isometric plane. */
export function iso(gx: number, gy: number): [number, number] {
  return [(gx - gy) * (TILE_W / 2), (gx + gy) * (TILE_H / 2)];
}

/**
 * Tilt of the floor's x axis, for skewing a flat face onto the projection.
 * atan(TILE_H / TILE_W) on the 2:1 plane.
 */
const ISO_SLANT_DEG = (Math.atan(TILE_H / TILE_W) * 180) / Math.PI;

const WOOD = { top: "#c99b66", west: "#a87e50", east: "#8d663e" };
const STEEL = { top: "#cfd6de", west: "#aab3bd", east: "#8d97a2" };
const FABRIC = { top: "#9aa7d6", west: "#7c88ba", east: "#656f9c" };
const DARK = { top: "#6d7887", west: "#576170", east: "#454f5c" };

type FaceColors = typeof WOOD;

interface IsoBoxProps {
  gx: number;
  gy: number;
  /** Size along the two grid axes, in cells. */
  w?: number;
  d?: number;
  /** Height in screen pixels. */
  h: number;
  colors?: FaceColors;
}

/** A cuboid drawn as three isometric faces with the top lifted by `h`. */
export function IsoBox({ gx, gy, w = 1, d = 1, h, colors = WOOD }: IsoBoxProps) {
  const [x0, y0] = iso(gx, gy);
  const [x1, y1] = iso(gx + w, gy);
  const [x2, y2] = iso(gx + w, gy + d);
  const [x3, y3] = iso(gx, gy + d);
  const pts = {
    top: `${x0},${y0 - h} ${x1},${y1 - h} ${x2},${y2 - h} ${x3},${y3 - h}`,
    sw: `${x0},${y0 - h} ${x3},${y3 - h} ${x3},${y3} ${x0},${y0}`,
    se: `${x3},${y3 - h} ${x2},${y2 - h} ${x2},${y2} ${x3},${y3}`,
  };
  return (
    <g>
      <polygon points={pts.sw} fill={colors.west} />
      <polygon points={pts.se} fill={colors.east} />
      <polygon points={pts.top} fill={colors.top} />
    </g>
  );
}

/** Flat rug / zone tint drawn directly on the ground plane. */
export function Rug({
  rect,
  fill,
  stroke,
}: {
  rect: { x: number; y: number; w: number; d: number };
  fill: string;
  stroke?: string;
}) {
  const r = rect;
  const [x0, y0] = iso(r.x, r.y);
  const [x1, y1] = iso(r.x + r.w, r.y);
  const [x2, y2] = iso(r.x + r.w, r.y + r.d);
  const [x3, y3] = iso(r.x, r.y + r.d);
  return (
    <polygon
      points={`${x0},${y0} ${x1},${y1} ${x2},${y2} ${x3},${y3}`}
      fill={fill}
      stroke={stroke}
      strokeWidth={stroke ? 1 : 0}
      strokeDasharray={stroke ? "4 4" : undefined}
    />
  );
}

export interface SeatSpot {
  gx: number;
  gy: number;
}

// --- Furniture -------------------------------------------------------------

function Leg(props: { gx: number; gy: number }) {
  return <IsoBox {...props} w={0.12} d={0.12} h={14} colors={DARK} />;
}

export const Desk = memo(function Desk({ gx, gy, busy }: { gx: number; gy: number; busy: boolean }) {
  // Tabletop with four legs; the monitor's screen lights up when the agent
  // using it has work running.
  return (
    <g>
      <Leg gx={gx - 0.02} gy={gy - 0.02} />
      <Leg gx={gx + 1.32} gy={gy - 0.02} />
      <Leg gx={gx - 0.02} gy={gy + 0.82} />
      <Leg gx={gx + 1.32} gy={gy + 0.82} />
      <IsoBox gx={gx - 0.18} gy={gy - 0.18} w={1.62} d={1.12} h={15} />
      {/* Monitor */}
      <IsoBox gx={gx + 0.42} gy={gy + 0.04} w={0.42} d={0.07} h={15} colors={DARK} />
      <rect
        x={iso(gx + 0.47, gy)[0]}
        y={iso(gx + 0.47, gy)[1] - 27}
        width={10}
        height={8}
        rx={1}
        fill={busy ? "#8fc6ff" : "#5a6a72"}
        opacity={busy ? 0.95 : 0.45}
      />
    </g>
  );
});

export const OfficeChair = memo(function OfficeChair({ gx, gy }: { gx: number; gy: number }) {
  return (
    <g>
      <IsoBox gx={gx + 0.12} gy={gy + 0.12} w={0.55} d={0.55} h={10} colors={FABRIC} />
      {/* Backrest sits on the far side so the seated person hides its base */}
      <IsoBox gx={gx + 0.08} gy={gy - 0.06} w={0.62} d={0.14} h={24} colors={FABRIC} />
    </g>
  );
});

export const MeetingTable = memo(function MeetingTable({ cx, cy }: { cx: number; cy: number }) {
  const [sx, sy] = iso(cx, cy);
  return (
    <g>
      <IsoBox gx={cx - 1.05} gy={cy - 0.42} w={2.1} d={0.84} h={14} />
      <Leg gx={cx - 0.85} gy={cy - 0.2} />
      <Leg gx={cx + 0.85} gy={cy + 0.2} />
      {/* Laptop odds and ends on the table */}
      <circle cx={sx - 14} cy={sy - 17} r={2.4} fill="#ffffff" opacity={0.75} />
      <circle cx={sx + 16} cy={sy - 19} r={2} fill="#ffd479" opacity={0.9} />
    </g>
  );
});

export const Whiteboard = memo(function Whiteboard({ gx, gy }: { gx: number; gy: number }) {
  // The panel is skewed onto the floor's x axis so it stands *in* the room.
  // An axis-aligned rectangle here reads as a flat card pasted over the scene,
  // because it is the one surface not following the projection.
  const w = 2.1;
  const stand = 22;
  const h = 30;
  const [x0, y0] = iso(gx - w / 2, gy);
  const boardW = w * (TILE_W / 2);
  return (
    <g>
      <IsoBox gx={gx - w / 2} gy={gy} w={0.09} d={0.09} h={stand} colors={STEEL} />
      <IsoBox gx={gx + w / 2 - 0.09} gy={gy} w={0.09} d={0.09} h={stand} colors={STEEL} />
      <g transform={`translate(${x0} ${y0 - stand - h}) skewY(${ISO_SLANT_DEG})`}>
        <rect width={boardW} height={h} rx={2} fill="#f4f6fa" stroke="#8d97a2" />
        <path
          d={`M 7 ${h - 19} q ${boardW * 0.2} -7 ${boardW * 0.4} 0 t ${boardW * 0.4} 2`}
          fill="none"
          stroke="#7c9cf5"
          strokeWidth={1.8}
        />
        <line x1={7} y1={h - 8} x2={boardW * 0.6} y2={h - 8} stroke="#e58fb1" strokeWidth={1.8} />
      </g>
    </g>
  );
});

export const Sofa = memo(function Sofa({ gx, gy }: { gx: number; gy: number }) {
  // Three-seater reading west->east; seat cushions get divider seams.
  return (
    <g>
      <IsoBox gx={gx} gy={gy} w={2.6} d={0.85} h={12} colors={FABRIC} />
      <IsoBox gx={gx} gy={gy - 0.18} w={2.6} d={0.3} h={26} colors={FABRIC} />
      <line
        x1={iso(gx + 0.87, gy)[0]}
        y1={iso(gx + 0.87, gy)[1] - 11}
        x2={iso(gx + 0.87, gy)[0]}
        y2={iso(gx + 0.87, gy)[1] - 1}
        stroke="#656f9c"
        strokeWidth={1.4}
      />
      <line
        x1={iso(gx + 1.74, gy)[0]}
        y1={iso(gx + 1.74, gy)[1] - 11}
        x2={iso(gx + 1.74, gy)[0]}
        y2={iso(gx + 1.74, gy)[1] - 1}
        stroke="#656f9c"
        strokeWidth={1.4}
      />
    </g>
  );
});

export const CoffeeTable = memo(function CoffeeTable({ gx, gy }: { gx: number; gy: number }) {
  return (
    <g>
      <IsoBox gx={gx} gy={gy} w={0.9} d={0.6} h={8} colors={STEEL} />
      <circle cx={iso(gx + 0.45, gy + 0.3)[0]} cy={iso(gx + 0.45, gy + 0.3)[1] - 10} r={2.4} fill="#e58fb1" />
    </g>
  );
});

export const CoffeeBar = memo(function CoffeeBar({ gx, gy }: { gx: number; gy: number }) {
  const [mx, my] = iso(gx + 0.5, gy);
  // Long counter hugging the east wall; the machine steams at one end.
  return (
    <g>
      <IsoBox gx={gx} gy={gy} w={1.05} d={3.4} h={18} colors={STEEL} />
      <IsoBox gx={gx + 0.1} gy={gy + 0.2} w={0.5} d={0.45} h={14} colors={DARK} />
      <path
        d={`M ${mx} ${my - 34} q 3 -4 0 -8 q -3 -4 0 -8`}
        fill="none"
        stroke="#b9c2cc"
        strokeWidth={1.6}
        strokeLinecap="round"
      />
    </g>
  );
});

export const BarStool = memo(function BarStool({ gx, gy }: { gx: number; gy: number }) {
  const [sx, sy] = iso(gx, gy);
  return (
    <g>
      <line x1={sx} y1={sy - 16} x2={sx} y2={sy} stroke={DARK.east} strokeWidth={3} />
      <ellipse cx={sx} cy={sy - 17} rx={5.4} ry={3.4} fill={FABRIC.top} />
    </g>
  );
});

export const CanteenTable = memo(function CanteenTable({ cx, cy }: { cx: number; cy: number }) {
  const [sx, sy] = iso(cx, cy);
  return (
    <g>
      <line x1={sx} y1={sy - 13} x2={sx} y2={sy} stroke={DARK.east} strokeWidth={4} />
      <ellipse cx={sx} cy={sy - 14} rx={17} ry={9.5} fill={WOOD.top} stroke={WOOD.east} />
    </g>
  );
});

export const WaitingBench = memo(function WaitingBench({ gx, gy }: { gx: number; gy: number }) {
  return (
    <g>
      <IsoBox gx={gx} gy={gy} w={3.6} d={0.5} h={11} colors={STEEL} />
      <IsoBox gx={gx} gy={gy - 0.12} w={3.6} d={0.18} h={21} colors={STEEL} />
    </g>
  );
});

export const Plant = memo(function Plant({ gx, gy }: { gx: number; gy: number }) {
  const [sx, sy] = iso(gx, gy);
  return (
    <g>
      <IsoBox gx={gx - 0.16} gy={gy - 0.16} w={0.32} d={0.32} h={9} colors={{ top: "#b98a5f", west: "#96683f", east: "#7d5533" }} />
      <circle cx={sx} cy={sy - 16} r={6} fill="#69a97c" />
      <circle cx={sx - 4} cy={sy - 12} r={4.4} fill="#7cbd8f" />
      <circle cx={sx + 4} cy={sy - 12} r={4.4} fill="#579566" />
    </g>
  );
});

// --- People ----------------------------------------------------------------

/** Illustration-only identity palettes; picked deterministically per agent. */
export const CLOTHES = ["#7c9cf5", "#8fd0a9", "#f2b26b", "#e58fb1", "#9d8ff5", "#7cc7e8"] as const;
export const SKINS = ["#f2c9a1", "#dda577", "#a8764f", "#8a5a3b"] as const;
export const HAIRS = ["#3b2f2f", "#6b4a2f", "#20242c", "#c8ccd4"] as const;

export function pick<T>(list: readonly T[], seed: string): T {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return list[Math.abs(h) % list.length] as T;
}

export type Facing = 1 | -1;

export interface SpriteColors {
  clothes: string;
  skin: string;
  hair: string;
}

interface PersonProps {
  agentId: string;
  name: string;
  sx: number;
  sy: number;
  facing: Facing;
  colors: SpriteColors;
  onClick?: () => void;
}

/** Seated at a chair / stool / bench — torso up behind the desk edge. */
export const SittingPerson = memo(function SittingPerson({ agentId, name, sx, sy, facing, colors, onClick }: PersonProps) {
  return (
    <g transform={`translate(${sx} ${sy})`} className="cursor-pointer" onClick={onClick}>
      <title>{name}</title>
      <ellipse cy={1.5} rx={7.5} ry={2.8} fill="#00000014" data-agent={agentId} />
      <g transform={`scale(${facing} 1)`}>
        <rect x={-4.6} y={-5.5} width={3.4} height={5.5} rx={1.4} fill="#3f4a5a" />
        <rect x={1.2} y={-5.5} width={3.4} height={5.5} rx={1.4} fill="#333d4c" />
        <rect x={-5.6} y={-20} width={11.2} height={15.5} rx={3.6} fill={colors.clothes} />
        <circle cy={-25} r={5.1} fill={colors.skin} />
        <path d="M -5.1 -26 a 5.1 5.1 0 0 1 10.2 0 l 0 -1.6 a 5.1 3.4 0 0 0 -10.2 0 z" fill={colors.hair} />
      </g>
      <text
        y={-33}
        textAnchor="middle"
        fontSize={8.5}
        fontWeight={600}
        fill="currentColor"
        stroke="var(--background)"
        strokeWidth={3}
        paintOrder="stroke"
        style={{ color: "var(--foreground)" }}
      >
        {name}
      </text>
    </g>
  );
});

interface StandingProps extends PersonProps {
  /** Walking frame toggle (legs swap); ignored while standing still. */
  frame?: 0 | 1;
  walking?: boolean;
}

/** Upright sprite — standing around or mid-stride with swinging legs. */
export const StandingPerson = memo(function StandingPerson({
  agentId,
  name,
  sx,
  sy,
  facing,
  colors,
  frame = 0,
  walking = false,
  onClick,
}: StandingProps) {
  const legA = walking ? (frame === 0 ? 17 : -17) : 0;
  const legB = walking ? (frame === 0 ? -17 : 17) : 0;
  return (
    <g transform={`translate(${sx} ${sy})`} className="cursor-pointer" onClick={onClick}>
      <title>{name}</title>
      <ellipse cy={1.5} rx={7.5} ry={2.8} fill="#00000014" data-agent={agentId} />
      <g transform={`scale(${facing} 1)`}>
        {([
          [-2.9, legA],
          [2.9, legB],
        ] as const).map(([hx, angle], i) => (
          <g key={i} transform={`rotate(${angle} ${hx} -12)`}>
            <rect x={hx - 1.7} y={-12} width={3.4} height={12} rx={1.5} fill={i === 0 ? "#3f4a5a" : "#333d4c"} />
          </g>
        ))}
        <rect x={-5.6} y={-27} width={11.2} height={16.5} rx={3.6} fill={colors.clothes} />
        {walking ? (
          <g transform={`rotate(${frame === 0 ? -22 : 22} -6.2 -25)`}>
            <rect x={-8.2} y={-25} width={2.8} height={11} rx={1.4} fill={colors.clothes} />
          </g>
        ) : null}
        <circle cy={-32} r={5.1} fill={colors.skin} />
        <path d="M -5.1 -33 a 5.1 5.1 0 0 1 10.2 0 l 0 -1.6 a 5.1 3.4 0 0 0 -10.2 0 z" fill={colors.hair} />
      </g>
      <text
        y={-40}
        textAnchor="middle"
        fontSize={8.5}
        fontWeight={600}
        fill="currentColor"
        stroke="var(--background)"
        strokeWidth={3}
        paintOrder="stroke"
        style={{ color: "var(--foreground)" }}
      >
        {name}
      </text>
    </g>
  );
});

/**
 * Height above a sprite's floor point of the stroked top edge of its name
 * label — the highest ink a person draws. Thought bubbles park above this so
 * they never land on the label or the head.
 */
export const LABEL_TOP = { sitting: 41, standing: 48 } as const;

export interface WalkRoute {
  /** Loop of grid waypoints; the walker cycles through them forever. */
  points: ReadonlyArray<{ gx: number; gy: number }>;
  /** Grid cells per second along the route. */
  speed: number;
  /** 0..1 phase offset so co-present walkers don't march in lockstep. */
  offset: number;
}

const REDUCED_MOTION =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;

/**
 * A self-animated walker. Owns its own ticker (60ms steps ≈ the two-frame
 * leg cadence) so only this subtree re-renders while strolling; honours
 * prefers-reduced-motion by freezing at its start waypoint.
 */
export function WalkingPerson(props: PersonProps & { route: WalkRoute }) {
  const { route, ...person } = props;
  const secondsRef = useRef(route.offset);
  const [state, setState] = useState(() => pointAt(route, route.offset));

  useEffect(() => {
    // prefers-reduced-motion (or a degenerate single-point route) freezes
    // the walker in place instead of marching.
    if (REDUCED_MOTION?.matches || route.points.length < 2) return;
    const id = setInterval(() => {
      secondsRef.current += 0.06;
      setState(pointAt(route, secondsRef.current));
    }, 60);
    return () => clearInterval(id);
  }, [route]);

  return (
    <StandingPerson
      {...person}
      sx={state.sx}
      sy={state.sy}
      facing={state.facing}
      walking={route.points.length >= 2 && !REDUCED_MOTION?.matches}
      frame={state.frame}
    />
  );
}

function routeLoopLength(route: WalkRoute): number {
  let total = 0;
  for (let i = 0; i < route.points.length; i += 1) {
    const a = route.points[i];
    const b = route.points[(i + 1) % route.points.length];
    if (!a || !b) continue;
    total += Math.hypot(b.gx - a.gx, b.gy - a.gy);
  }
  return total;
}

function pointAt(
  route: WalkRoute,
  progressSeconds: number,
): { sx: number; sy: number; facing: Facing; frame: 0 | 1 } {
  const pts = route.points;
  if (pts.length < 2 || !pts[0]) return { sx: iso(0, 0)[0], sy: iso(0, 0)[1], facing: 1, frame: 0 };
  const total = routeLoopLength(route);
  let dist = ((progressSeconds * route.speed) % total + total) % total;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i] as { gx: number; gy: number };
    const b = pts[(i + 1) % pts.length] as { gx: number; gy: number };
    const seg = Math.hypot(b.gx - a.gx, b.gy - a.gy);
    if (dist <= seg) {
      const t = seg === 0 ? 0 : dist / seg;
      const gx = a.gx + (b.gx - a.gx) * t;
      const gy = a.gy + (b.gy - a.gy) * t;
      const [sx, sy] = iso(gx, gy);
      const dxs = (b.gx - b.gy) - (a.gx - a.gy);
      return { sx, sy, facing: dxs >= 0 ? 1 : -1, frame: Math.floor(progressSeconds * 8) % 2 === 0 ? 0 : 1 };
    }
    dist -= seg;
  }
  const [sx, sy] = iso(pts[0].gx, pts[0].gy);
  return { sx, sy, facing: 1, frame: 0 };
}
