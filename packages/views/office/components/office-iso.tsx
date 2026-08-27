"use client";

import { memo, useEffect, useRef, useState } from "react";

// Isometric drawing primitives for the Agent Office floor plan. Everything
// is plain SVG shapes — no image assets — positioned on a 2:1 isometric
// grid. The furniture needs concrete illustration colors, so this file keeps
// a tiny fixed palette (semantic tokens cannot express wood/steel shades);
// everything user-themed (names, bubbles, badges) stays in tokens.
//
// Light comes from the west, so on every solid the west face is the lit one
// and the east face is in shadow. Sprites derive their lit and shaded sides
// from the same rule, which is what keeps a body reading as a volume rather
// than a flat sticker laid over the room.
//
// The room shell (floor, walls, rugs) is painted in translucent ink over the
// themed background instead of opaque colour, so it follows light and dark
// mode on its own. Props and people are opaque.
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

/**
 * Multiplies a hex colour toward black (k < 1) or white (k > 1). Each agent
 * owns one identity colour; its lit and shaded faces are derived from that so
 * a sprite gains volume without needing a palette entry per body part.
 */
export function shade(hex: string, k: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) =>
    Math.max(0, Math.min(255, Math.round(k <= 1 ? c * k : c + (255 - c) * (k - 1)))),
  );
  return `#${channels.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

const WOOD = { top: "#c99b66", west: "#a87e50", east: "#8d663e" };
const STEEL = { top: "#cfd6de", west: "#aab3bd", east: "#8d97a2" };
const FABRIC = { top: "#9aa7d6", west: "#7c88ba", east: "#656f9c" };
const DARK = { top: "#6d7887", west: "#576170", east: "#454f5c" };
const TROUSER = "#414c5e";

type FaceColors = typeof WOOD;

/** Gradients shared by the whole scene; mounted once per floor. */
export function IsoDefs() {
  return (
    <defs>
      <radialGradient id="office-blob">
        <stop offset="0%" stopColor="#000000" stopOpacity="0.22" />
        <stop offset="55%" stopColor="#000000" stopOpacity="0.1" />
        <stop offset="100%" stopColor="#000000" stopOpacity="0" />
      </radialGradient>
      <linearGradient id="office-glass" x1="0" y1="0" x2="0.35" y2="1">
        <stop offset="0%" stopColor="#cfe6f7" />
        <stop offset="55%" stopColor="#a9cfe9" />
        <stop offset="100%" stopColor="#c6dced" />
      </linearGradient>
    </defs>
  );
}

/** Soft contact shadow that seats a prop on the floor. */
export function FloorShadow({
  gx,
  gy,
  rx,
  ry = rx * 0.52,
}: {
  gx: number;
  gy: number;
  rx: number;
  ry?: number;
}) {
  const [sx, sy] = iso(gx, gy);
  return <ellipse cx={sx} cy={sy} rx={rx} ry={ry} fill="url(#office-blob)" />;
}

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

// --- Room shell ------------------------------------------------------------

/**
 * Checkered ground plane. Translucent so the floor takes its value from the
 * themed background rather than fighting it in dark mode.
 */
export const FloorTiles = memo(function FloorTiles({ w, d }: { w: number; d: number }) {
  const cells: React.ReactNode[] = [];
  for (let gx = 0; gx < w; gx += 1) {
    for (let gy = 0; gy < d; gy += 1) {
      const points = [iso(gx, gy), iso(gx + 1, gy), iso(gx + 1, gy + 1), iso(gx, gy + 1)]
        .map(([x, y]) => `${x},${y}`)
        .join(" ");
      cells.push(
        <polygon
          key={`${gx}-${gy}`}
          points={points}
          fill={(gx + gy) % 2 === 0 ? "#8a7f6a1c" : "#8a7f6a10"}
        />,
      );
    }
  }
  return <g>{cells}</g>;
});

/**
 * The two walls meeting at the north corner, which is what turns a floating
 * slab into a room. Each wall is a flat rectangle skewed onto its own plane,
 * so everything hung on it — window, clock, poster — is laid out in plain
 * local coordinates.
 */
export const BackWalls = memo(function BackWalls({
  w,
  d,
  h = 66,
}: {
  w: number;
  d: number;
  h?: number;
}) {
  const runRight = w * (TILE_W / 2);
  const runLeft = d * (TILE_W / 2);
  const [westX, westY] = iso(0, d);
  const skirting = 6;
  return (
    <g>
      {/* Back-right wall: runs down-right from the north corner. */}
      <g transform={`translate(0 ${-h}) skewY(${ISO_SLANT_DEG})`}>
        <rect width={runRight} height={h} fill="#7d87982e" />
        <rect y={h - skirting} width={runRight} height={skirting} fill="#5f6a7a3a" />
        <rect width={runRight} height={2} fill="#ffffff1f" />
        {/* Window, with a sill and one glazing bar. */}
        <g>
          <rect
            x={runRight * 0.28}
            y={13}
            width={runRight * 0.36}
            height={h - 36}
            rx={2}
            fill="url(#office-glass)"
            opacity={0.82}
          />
          <rect
            x={runRight * 0.28}
            y={13}
            width={runRight * 0.36}
            height={h - 36}
            rx={2}
            fill="none"
            stroke="#8d97a2"
            strokeWidth={1.6}
          />
          <line
            x1={runRight * 0.46}
            y1={13}
            x2={runRight * 0.46}
            y2={h - 23}
            stroke="#8d97a2"
            strokeWidth={1.3}
          />
          <rect
            x={runRight * 0.26}
            y={h - 23}
            width={runRight * 0.4}
            height={3}
            rx={1.5}
            fill="#aab3bd"
          />
        </g>
      </g>

      {/* Back-left wall: runs up-right from the west corner to the north one. */}
      <g transform={`translate(${westX} ${westY - h}) skewY(${-ISO_SLANT_DEG})`}>
        <rect width={runLeft} height={h} fill="#7d879820" />
        <rect y={h - skirting} width={runLeft} height={skirting} fill="#5f6a7a2e" />
        <rect width={runLeft} height={2} fill="#ffffff14" />
        {/* Wall clock */}
        <g transform={`translate(${runLeft * 0.62} 22)`}>
          <circle r={7.5} fill="#f4f6fa" stroke="#8d97a2" strokeWidth={1.4} />
          <line y2={-4.4} stroke="#454f5c" strokeWidth={1.3} strokeLinecap="round" />
          <line x2={3.2} stroke="#454f5c" strokeWidth={1.1} strokeLinecap="round" />
        </g>
        {/* A pinned-up chart, because an empty wall reads as unfinished. */}
        <g transform={`translate(${runLeft * 0.24} 15)`}>
          <rect width={26} height={19} rx={1.5} fill="#f4f6fa" stroke="#8d97a2" strokeWidth={1.2} />
          <polyline
            points="4,14 9,9 14,12 22,5"
            fill="none"
            stroke="#7c9cf5"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      </g>
    </g>
  );
});

/** A flat parallelogram lying on a surface `lift` pixels above the floor. */
export function IsoQuad({
  gx,
  gy,
  w,
  d,
  lift = 0,
  fill,
  opacity,
}: {
  gx: number;
  gy: number;
  w: number;
  d: number;
  lift?: number;
  fill: string;
  opacity?: number;
}) {
  const points = [iso(gx, gy), iso(gx + w, gy), iso(gx + w, gy + d), iso(gx, gy + d)]
    .map(([x, y]) => `${x},${y - lift}`)
    .join(" ");
  return <polygon points={points} fill={fill} opacity={opacity} />;
}

/** A mug standing on a surface `lift` pixels above the floor. */
function Mug({ gx, gy, lift, color }: { gx: number; gy: number; lift: number; color: string }) {
  const [x, y] = iso(gx, gy);
  const rx = 2;
  const h = 2.8;
  const top = y - lift - h;
  return (
    <g>
      <path d={`M ${x - rx} ${top} l 0 ${h} a ${rx} 1.15 0 0 0 ${rx * 2} 0 l 0 ${-h} z`} fill={shade(color, 0.82)} />
      <path
        d={`M ${x + rx - 0.3} ${top + 0.7} a 1.1 1.1 0 0 1 0 1.6`}
        fill="none"
        stroke={shade(color, 0.72)}
        strokeWidth={0.7}
      />
      <ellipse cx={x} cy={top} rx={rx} ry={1.15} fill={color} />
      <ellipse cx={x} cy={top} rx={rx - 0.6} ry={0.72} fill={shade(color, 0.68)} />
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
  const corners = (inset: number) =>
    [
      iso(r.x + inset, r.y + inset),
      iso(r.x + r.w - inset, r.y + inset),
      iso(r.x + r.w - inset, r.y + r.d - inset),
      iso(r.x + inset, r.y + r.d - inset),
    ]
      .map(([x, y]) => `${x},${y}`)
      .join(" ");
  return (
    <g>
      <polygon points={corners(0)} fill={fill} />
      {/* An inset seam gives the rug an edge without a hard outline. */}
      {stroke ? (
        <polygon points={corners(0.16)} fill="none" stroke={stroke} strokeWidth={1} />
      ) : null}
    </g>
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

/** Height of a desk's tabletop above the floor. */
export const DESK_TOP = 15;
/**
 * Offset from a desk's anchor to its occupant, in grid cells. `dx - dy` equals
 * the anchor-to-centre offset, so the agent shares the desk's screen column and
 * reads as sitting square behind it; `dx + dy` is negative, so the desk is
 * depth-sorted afterwards and its tabletop hides the lower body.
 */
export const DESK_SEAT = { dx: -0.325, dy: 0.125 } as const;

export const Desk = memo(function Desk({ gx, gy, busy }: { gx: number; gy: number; busy: boolean }) {
  // The agent sits at DESK_SEAT relative to this anchor, so the tabletop is
  // depth-sorted in front of the body: torso and head above the surface, legs
  // hidden behind it. The monitor's screen lights up when that agent has work
  // running.
  const halfW = 0.56;
  const stand = 4;
  const panel = 10.5;
  // The monitor sits on the tabletop's east half, clear of the screen column
  // its occupant is drawn in — parked centre-desk it covers their face.
  const [mx, my] = iso(gx - 0.02, gy + 0.2);
  const panelW = 0.62 * (TILE_W / 2);
  return (
    <g>
      <FloorShadow gx={gx} gy={gy + 0.45} rx={24} />
      <Leg gx={gx - halfW + 0.06} gy={gy + 0.06} />
      <Leg gx={gx + halfW - 0.18} gy={gy + 0.06} />
      <Leg gx={gx - halfW + 0.06} gy={gy + 0.72} />
      <Leg gx={gx + halfW - 0.18} gy={gy + 0.72} />
      <IsoBox gx={gx - halfW} gy={gy} w={halfW * 2} d={0.9} h={DESK_TOP} />
      {/* Keyboard and mug lying flat on the tabletop. */}
      <IsoQuad
        gx={gx - 0.36}
        gy={gy + 0.46}
        w={0.54}
        d={0.24}
        lift={DESK_TOP}
        fill={DARK.top}
        opacity={0.9}
      />
      <Mug gx={gx + 0.3} gy={gy + 0.68} lift={DESK_TOP} color="#dc8fa8" />
      {/* Monitor. Its screen is turned to the viewer rather than to the agent
          behind it, because the glow is this desk's running-state signal. */}
      <IsoBox
        gx={gx + 0.22}
        gy={gy + 0.17}
        w={0.1}
        d={0.08}
        h={DESK_TOP + stand}
        colors={DARK}
      />
      <g transform={`translate(${mx} ${my - DESK_TOP - stand - panel}) skewY(${ISO_SLANT_DEG})`}>
        <rect width={panelW} height={panel} rx={1.4} fill={DARK.east} />
        <rect
          x={1.2}
          y={1.2}
          width={panelW - 2.4}
          height={panel - 3.6}
          rx={0.8}
          fill={busy ? "#8fc6ff" : "#5a6a72"}
          opacity={busy ? 0.95 : 0.45}
        />
        {busy ? (
          <>
            <rect x={2.6} y={2.8} width={panelW * 0.46} height={1.1} rx={0.55} fill="#ffffff" opacity={0.8} />
            <rect x={2.6} y={5.2} width={panelW * 0.3} height={1.1} rx={0.55} fill="#ffffff" opacity={0.5} />
          </>
        ) : null}
      </g>
    </g>
  );
});

/** Task chairs recede so a row of eight does not out-shout the desks. */
const CHAIR_TASK = { top: "#7b8494", west: "#666f7e", east: "#535c6a" };

export const OfficeChair = memo(function OfficeChair({
  gx,
  gy,
  variant = "meeting",
}: {
  gx: number;
  gy: number;
  variant?: "meeting" | "task";
}) {
  const colors = variant === "task" ? CHAIR_TASK : FABRIC;
  // The backrest stays below the tabletop it faces (DESK_TOP + a little), or a
  // row of chairs turns into a row of partitions and swallows the desks.
  return (
    <g>
      <FloorShadow gx={gx + 0.4} gy={gy + 0.4} rx={11} />
      <IsoBox gx={gx + 0.16} gy={gy + 0.16} w={0.5} d={0.5} h={9.5} colors={colors} />
      {/* Backrest sits on the far side so the seated person hides its base */}
      <IsoBox gx={gx + 0.12} gy={gy - 0.02} w={0.56} d={0.12} h={18} colors={colors} />
    </g>
  );
});

export const MeetingTable = memo(function MeetingTable({ cx, cy }: { cx: number; cy: number }) {
  const [sx, sy] = iso(cx, cy);
  return (
    <g>
      <FloorShadow gx={cx} gy={cy} rx={34} />
      <IsoBox gx={cx - 1.05} gy={cy - 0.42} w={2.1} d={0.84} h={14} />
      <Leg gx={cx - 0.85} gy={cy - 0.2} />
      <Leg gx={cx + 0.85} gy={cy + 0.2} />
      {/* Two open laptops and a cup — a table mid-meeting, not an empty one. */}
      {[-0.55, 0.55].map((off, i) => {
        const [lx, ly] = iso(cx + off, cy + (i === 0 ? -0.12 : 0.12));
        return (
          <g key={i}>
            <ellipse cx={lx} cy={ly - 14.6} rx={5.4} ry={2.8} fill={STEEL.top} />
            <path
              d={`M ${lx - 5} ${ly - 15.2} l 1.6 -7.4 l 8 0 l 1.4 7.4 z`}
              fill={STEEL.west}
              stroke={STEEL.east}
              strokeWidth={0.8}
            />
            <path d={`M ${lx - 3.2} ${ly - 16.4} l 1.1 -5.2 l 5.8 0 l 1 5.2 z`} fill="#8fc6ff" opacity={0.7} />
          </g>
        );
      })}
      <ellipse cx={sx + 17} cy={sy - 16} rx={2.2} ry={1.3} fill="#ffd479" />
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
      <FloorShadow gx={gx} gy={gy + 0.1} rx={26} ry={7} />
      <IsoBox gx={gx - w / 2} gy={gy} w={0.09} d={0.09} h={stand} colors={STEEL} />
      <IsoBox gx={gx + w / 2 - 0.09} gy={gy} w={0.09} d={0.09} h={stand} colors={STEEL} />
      <g transform={`translate(${x0} ${y0 - stand - h}) skewY(${ISO_SLANT_DEG})`}>
        <rect width={boardW} height={h} rx={2} fill="#f4f6fa" stroke="#8d97a2" />
        <rect width={boardW} height={3} rx={1.5} fill="#ffffff" opacity={0.8} />
        <path
          d={`M 7 ${h - 19} q ${boardW * 0.2} -7 ${boardW * 0.4} 0 t ${boardW * 0.4} 2`}
          fill="none"
          stroke="#7c9cf5"
          strokeWidth={1.8}
        />
        <line x1={7} y1={h - 8} x2={boardW * 0.6} y2={h - 8} stroke="#e58fb1" strokeWidth={1.8} />
        <line x1={boardW * 0.68} y1={h - 8} x2={boardW * 0.86} y2={h - 8} stroke="#8fd0a9" strokeWidth={1.8} />
      </g>
    </g>
  );
});

export const Sofa = memo(function Sofa({ gx, gy }: { gx: number; gy: number }) {
  // Three-seater reading west->east; seat cushions get divider seams.
  return (
    <g>
      <FloorShadow gx={gx + 1.3} gy={gy + 0.45} rx={40} />
      <IsoBox gx={gx} gy={gy} w={2.6} d={0.85} h={12} colors={FABRIC} />
      <IsoBox gx={gx} gy={gy - 0.18} w={2.6} d={0.3} h={26} colors={FABRIC} />
      {/* Armrests close the ends off so it stops reading as a plain block. */}
      <IsoBox gx={gx - 0.16} gy={gy - 0.12} w={0.2} d={1} h={19} colors={FABRIC} />
      <IsoBox gx={gx + 2.58} gy={gy - 0.12} w={0.2} d={1} h={19} colors={FABRIC} />
      {[0.87, 1.74].map((off) => (
        <line
          key={off}
          x1={iso(gx + off, gy)[0]}
          y1={iso(gx + off, gy)[1] - 11}
          x2={iso(gx + off, gy)[0]}
          y2={iso(gx + off, gy)[1] - 1}
          stroke={FABRIC.east}
          strokeWidth={1.4}
        />
      ))}
      {/* Throw cushions, lying on the seat rather than floating over it. */}
      {[0.32, 1.82].map((off, i) => (
        <IsoQuad
          key={off}
          gx={gx + off}
          gy={gy + 0.18}
          w={0.42}
          d={0.42}
          lift={13}
          fill={i === 0 ? "#f2b26b" : "#8fd0a9"}
          opacity={0.9}
        />
      ))}
    </g>
  );
});

export const CoffeeTable = memo(function CoffeeTable({ gx, gy }: { gx: number; gy: number }) {
  return (
    <g>
      <FloorShadow gx={gx + 0.45} gy={gy + 0.3} rx={16} />
      <IsoBox gx={gx} gy={gy} w={0.9} d={0.6} h={8} colors={STEEL} />
      <circle cx={iso(gx + 0.45, gy + 0.3)[0]} cy={iso(gx + 0.45, gy + 0.3)[1] - 10} r={2.4} fill="#e58fb1" />
      <ellipse
        cx={iso(gx + 0.2, gy + 0.3)[0]}
        cy={iso(gx + 0.2, gy + 0.3)[1] - 9}
        rx={3.6}
        ry={1.8}
        fill="#f2f4f7"
        opacity={0.85}
      />
    </g>
  );
});

export const CoffeeBar = memo(function CoffeeBar({ gx, gy }: { gx: number; gy: number }) {
  const [mx, my] = iso(gx + 0.5, gy);
  // Long counter hugging the east wall; the machine steams at one end.
  return (
    <g>
      <FloorShadow gx={gx + 0.5} gy={gy + 1.7} rx={30} ry={30} />
      <IsoBox gx={gx} gy={gy} w={1.05} d={3.4} h={18} colors={STEEL} />
      {/* Counter lip, so the slab has a top edge to catch the light. */}
      <IsoBox gx={gx - 0.05} gy={gy - 0.05} w={1.15} d={3.5} h={19} colors={{ top: "#e3e8ee", west: "#c2cad3", east: "#a3adb8" }} />
      <IsoBox gx={gx + 0.1} gy={gy + 0.2} w={0.5} d={0.45} h={14} colors={DARK} />
      <path
        d={`M ${mx} ${my - 34} q 3 -4 0 -8 q -3 -4 0 -8`}
        fill="none"
        stroke="#b9c2cc"
        strokeWidth={1.6}
        strokeLinecap="round"
      />
      {/* Row of cups waiting on the counter */}
      {[1.35, 1.75, 2.15].map((off) => {
        const [cx, cy] = iso(gx + 0.5, gy + off);
        return <ellipse key={off} cx={cx} cy={cy - 21} rx={2} ry={1.2} fill="#f4f6fa" />;
      })}
    </g>
  );
});

export const BarStool = memo(function BarStool({ gx, gy }: { gx: number; gy: number }) {
  const [sx, sy] = iso(gx, gy);
  return (
    <g>
      <FloorShadow gx={gx} gy={gy} rx={7} />
      <line x1={sx} y1={sy - 16} x2={sx} y2={sy} stroke={DARK.east} strokeWidth={3} />
      <ellipse cx={sx} cy={sy - 15.4} rx={5.6} ry={3.5} fill={FABRIC.east} />
      <ellipse cx={sx} cy={sy - 17} rx={5.4} ry={3.4} fill={FABRIC.top} />
    </g>
  );
});

export const CanteenTable = memo(function CanteenTable({ cx, cy }: { cx: number; cy: number }) {
  const [sx, sy] = iso(cx, cy);
  return (
    <g>
      <FloorShadow gx={cx} gy={cy} rx={20} />
      <line x1={sx} y1={sy - 13} x2={sx} y2={sy} stroke={DARK.east} strokeWidth={4} />
      <ellipse cx={sx} cy={sy - 12.4} rx={17} ry={9.5} fill={WOOD.east} />
      <ellipse cx={sx} cy={sy - 14} rx={17} ry={9.5} fill={WOOD.top} stroke={WOOD.east} />
      {/* Two place settings */}
      {[-7, 7].map((off) => (
        <g key={off}>
          <ellipse cx={sx + off} cy={sy - 15} rx={4} ry={2.3} fill="#f4f6fa" />
          <ellipse cx={sx + off} cy={sy - 15.4} rx={2} ry={1.1} fill="#e58fb1" opacity={0.7} />
        </g>
      ))}
    </g>
  );
});

export const WaitingBench = memo(function WaitingBench({ gx, gy }: { gx: number; gy: number }) {
  return (
    <g>
      <FloorShadow gx={gx + 1.8} gy={gy + 0.25} rx={52} />
      <IsoBox gx={gx} gy={gy} w={3.6} d={0.5} h={11} colors={STEEL} />
      <IsoBox gx={gx} gy={gy - 0.12} w={3.6} d={0.18} h={21} colors={STEEL} />
      {/* Slat seams down the seat */}
      {[0.9, 1.8, 2.7].map((off) => (
        <line
          key={off}
          x1={iso(gx + off, gy)[0]}
          y1={iso(gx + off, gy)[1] - 10}
          x2={iso(gx + off, gy)[0]}
          y2={iso(gx + off, gy)[1] - 1}
          stroke={STEEL.east}
          strokeWidth={1.2}
        />
      ))}
    </g>
  );
});

export const Plant = memo(function Plant({ gx, gy }: { gx: number; gy: number }) {
  const [sx, sy] = iso(gx, gy);
  return (
    <g>
      <FloorShadow gx={gx} gy={gy} rx={11} />
      <IsoBox
        gx={gx - 0.16}
        gy={gy - 0.16}
        w={0.32}
        d={0.32}
        h={9}
        colors={{ top: "#b98a5f", west: "#96683f", east: "#7d5533" }}
      />
      {/* Leaves: darker on the east, a highlight leaf catching the west light */}
      <circle cx={sx + 4} cy={sy - 12} r={4.4} fill="#4f8a5e" />
      <circle cx={sx} cy={sy - 16} r={6} fill="#69a97c" />
      <circle cx={sx - 4} cy={sy - 12} r={4.4} fill="#7cbd8f" />
      <circle cx={sx - 1.8} cy={sy - 18.2} r={2.6} fill="#93cfa4" />
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

const HEAD_R = 5.4;

/**
 * Head with a shaded east half, hair that has a lit crown, and a face.
 * The eyes are what carry most of the "somebody is sitting there" reading at
 * this size, so they are worth their two circles.
 */
function Head({ cy, colors }: { cy: number; colors: SpriteColors }) {
  const r = HEAD_R;
  return (
    <g>
      <rect x={-1.8} y={cy + r - 2.2} width={3.6} height={3.8} rx={1.6} fill={shade(colors.skin, 0.84)} />
      <circle cy={cy} r={r} fill={colors.skin} />
      <path d={`M 0 ${cy - r} a ${r} ${r} 0 0 1 0 ${r * 2} z`} fill={shade(colors.skin, 0.9)} />
      <path
        d={`M ${-r} ${cy - 1} a ${r} ${r} 0 0 1 ${r * 2} 0 l 0 -1.7 a ${r} ${r * 0.66} 0 0 0 ${-r * 2} 0 z`}
        fill={colors.hair}
      />
      <path
        d={`M ${-r} ${cy - 1} a ${r} ${r} 0 0 1 ${r * 0.9} ${-r * 0.86} l 0 -1.7 a ${r} ${r * 0.66} 0 0 0 ${-r * 0.9} ${r * 0.86} z`}
        fill={shade(colors.hair, 1.12)}
      />
      <circle cx={-1.9} cy={cy + 0.7} r={0.62} fill="#2b3038" />
      <circle cx={1.9} cy={cy + 0.7} r={0.62} fill="#2b3038" />
    </g>
  );
}

/**
 * Torso as a rounded volume: the base colour, an east side dropped into
 * shadow, and a lit strip down the west edge.
 */
function Torso({ top, bottom, colors }: { top: number; bottom: number; colors: SpriteColors }) {
  const halfW = 5.8;
  const r = 3.8;
  const h = bottom - top;
  return (
    <g>
      <rect x={-halfW} y={top} width={halfW * 2} height={h} rx={r} fill={colors.clothes} />
      <path
        d={`M 0.8 ${top} L ${halfW - r} ${top} a ${r} ${r} 0 0 1 ${r} ${r} L ${halfW} ${bottom - r} a ${r} ${r} 0 0 1 ${-r} ${r} L 0.8 ${bottom} Z`}
        fill={shade(colors.clothes, 0.84)}
      />
      <rect
        x={-halfW + 0.7}
        y={top + 3}
        width={1.7}
        height={h - 6}
        rx={0.85}
        fill={shade(colors.clothes, 1.18)}
        opacity={0.8}
      />
      <path
        d={`M -2.9 ${top + 0.8} q 2.9 3.2 5.8 0`}
        fill="none"
        stroke={shade(colors.clothes, 0.7)}
        strokeWidth={1.2}
        strokeLinecap="round"
      />
    </g>
  );
}

/** Arms hanging at the sides, lit west and shaded east. */
function Arms({ top, length, colors }: { top: number; length: number; colors: SpriteColors }) {
  return (
    <g>
      <rect x={-8.1} y={top} width={2.7} height={length} rx={1.35} fill={shade(colors.clothes, 1.08)} />
      <rect x={5.4} y={top} width={2.7} height={length} rx={1.35} fill={shade(colors.clothes, 0.8)} />
    </g>
  );
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

function NameLabel({ y, name }: { y: number; name: string }) {
  return (
    <text
      y={y}
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
  );
}

/** Seated at a chair / stool / bench — torso up behind the desk edge. */
export const SittingPerson = memo(function SittingPerson({
  agentId,
  name,
  sx,
  sy,
  colors,
  onClick,
}: PersonProps) {
  return (
    <g transform={`translate(${sx} ${sy})`} className="cursor-pointer" onClick={onClick}>
      <title>{name}</title>
      <ellipse cy={1.2} rx={9.5} ry={4} fill="url(#office-blob)" data-agent={agentId} />
      {/* Thighs forward, shins dropping to the floor */}
      <rect x={-4.9} y={-7.6} width={9.8} height={3.8} rx={1.9} fill={shade(TROUSER, 1.1)} />
      <rect x={-4.5} y={-4.8} width={3.5} height={4.8} rx={1.5} fill={TROUSER} />
      <rect x={1.0} y={-4.8} width={3.5} height={4.8} rx={1.5} fill={shade(TROUSER, 0.86)} />
      <Arms top={-18} length={9.5} colors={colors} />
      <Torso top={-20.5} bottom={-5} colors={colors} />
      <Head cy={-25.5} colors={colors} />
      <NameLabel y={-34} name={name} />
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
      <ellipse cy={1.2} rx={9.5} ry={4} fill="url(#office-blob)" data-agent={agentId} />
      {(
        [
          [-2.9, legA, shade(TROUSER, 1.1)],
          [2.9, legB, TROUSER],
        ] as const
      ).map(([hx, angle, fill], i) => (
        <g key={i} transform={`rotate(${angle} ${hx} -12)`}>
          <rect x={hx - 1.8} y={-12} width={3.6} height={12} rx={1.6} fill={fill} />
          <ellipse cx={hx} cy={-0.6} rx={2.7} ry={1.5} fill="#2b3038" />
        </g>
      ))}
      <Arms top={-25} length={10.5} colors={colors} />
      <Torso top={-27.5} bottom={-11} colors={colors} />
      {/* The forward-swinging arm only exists mid-stride, and it is the one
          part of the body that has to follow the direction of travel. */}
      {walking ? (
        <g transform={`scale(${facing} 1)`}>
          <g transform={`rotate(${frame === 0 ? -24 : 24} -6.7 -25)`}>
            <rect
              x={-8.1}
              y={-25}
              width={2.7}
              height={10.5}
              rx={1.35}
              fill={shade(colors.clothes, 1.08)}
            />
          </g>
        </g>
      ) : null}
      <Head cy={-32.5} colors={colors} />
      <NameLabel y={-41} name={name} />
    </g>
  );
});

/**
 * Height above a sprite's floor point of the stroked top edge of its name
 * label — the highest ink a person draws. Thought bubbles park above this so
 * they never land on the label or the head.
 */
export const LABEL_TOP = { sitting: 42, standing: 49 } as const;

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
  let dist = (((progressSeconds * route.speed) % total) + total) % total;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i] as { gx: number; gy: number };
    const b = pts[(i + 1) % pts.length] as { gx: number; gy: number };
    const seg = Math.hypot(b.gx - a.gx, b.gy - a.gy);
    if (dist <= seg) {
      const t = seg === 0 ? 0 : dist / seg;
      const gx = a.gx + (b.gx - a.gx) * t;
      const gy = a.gy + (b.gy - a.gy) * t;
      const [sx, sy] = iso(gx, gy);
      const dxs = b.gx - b.gy - (a.gx - a.gy);
      return {
        sx,
        sy,
        facing: dxs >= 0 ? 1 : -1,
        frame: Math.floor(progressSeconds * 8) % 2 === 0 ? 0 : 1,
      };
    }
    dist -= seg;
  }
  const [sx, sy] = iso(pts[0].gx, pts[0].gy);
  return { sx, sy, facing: 1, frame: 0 };
}
