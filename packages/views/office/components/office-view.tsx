"use client";

import { memo, useEffect, useRef, useState } from "react";

// Overhead drawing primitives for the Agent Office.
//
// The camera looks down on one open-plan floor from above, square to the
// building — not rotated onto a diagonal. Projection is an axis-aligned
// oblique: a world point (x, y, z) lands at (x + z*LEAN, y - z*LIFT). The
// floor plane is z = 0, so it maps to itself: rooms stay true rectangles,
// nothing is lost to diagonal dead corners, and text printed on the floor or
// on a desktop reads perfectly straight.
//
// Height is what makes it a 3D view rather than a plan drawing. Anything with
// height rises up the screen and leans slightly right, so every prop is a
// solid with a lit top, a shaded front and a darker right side, and a person
// is a figure standing on the floor whose head — the avatar disc — sits on
// top of the body. Because the whole scene shares one lean, a painter's pass
// over world Y is all the depth sorting it needs.
//
// Everything is plain SVG. Furniture needs concrete illustration colours
// (semantic tokens cannot express oak or brushed steel), so this file keeps a
// fixed palette; everything user-themed — names, bubbles — stays in tokens.

/** Scene box. The SVG viewBox is these numbers. */
export const SCENE_W = 1200;
export const SCENE_H = 660;

/** Screen units risen per unit of height, and the sideways lean with it. */
export const LIFT = 0.62;
export const LEAN = 0.16;
/** The same lean as an angle, for surfaces that carry upright content. */
const LEAN_DEG = 9.09;

/** Height of the north wall. Tall enough to carry the office's big screen. */
export const WALL_H = 190;

/** The interior floor, in world units on the z = 0 plane. The plate carries
 * an east strip beyond the canteen: the members corner up north and the gym
 * down south, so the original six zones keep their collision-tested layout. */
export const FLOOR = { x0: 22, x1: 1160, y0: 124, y1: 646 } as const;

/** Projects a world point to scene coordinates. */
export function px(x: number, z = 0): number {
  return x + z * LEAN;
}
export function py(y: number, z = 0): number {
  return y - z * LIFT;
}

// --- Palette ---------------------------------------------------------------

// A bright white office. When almost every surface is white, hue stops doing
// any work and value has to carry the whole drawing, so the palette steps by
// PLANE rather than by material: the wall is the brightest thing in the room,
// furniture tops come next, the floor sits below both, and every front and
// side face drops two clear steps further. That ordering is what still reads
// as a solid standing on a floor once the colour has been taken away.
//
// Two anchors keep it from going clinical: charcoal, used only for screens,
// chair columns and bezels, and light oak on the worktops and the soft-seating
// frames.

/** Paint, plaster and white joinery — what most of this office is made of. */
const WHITE = { lit: "#ffffff", face: "#f1f4f8", dark: "#dbe1e9", deep: "#bfc8d3" };
/** Light oak: worktops, the meeting table, the canteen and the bench. */
const OAK = { lit: "#f2e5d0", face: "#e5d2b4", dark: "#c9b28d", deep: "#a38b68" };
/** Charcoal. Screens, chair columns, bezels — the only dark in the room. */
const METAL = { lit: "#98a0ab", face: "#666e79", dark: "#3f454e", deep: "#282d34" };
/** Task-chair mesh. Mid grey, so a chair never melts into a near-white floor. */
const FABRIC = { lit: "#b9c1cb", face: "#9ea8b4", dark: "#848f9c", deep: "#6c7683" };
/** Soft seating in off-white bouclé, shaded hard enough to keep its shape. */
const UPHOLSTERY = { lit: "#ffffff", face: "#eef1f5", dark: "#d3dae2", deep: "#b0bac7" };
const MOSS = { lit: "#b7d1b9", face: "#8fb694", dark: "#6d9575" };
const TERRA = "#d98a68";
const SCREEN_OFF = "#3f454e";
/** Contact shadows. Cool, because a brown shadow on white tile reads as dirt. */
const SHADOW = "#5a6472";

/**
 * Carpet per zone. Every tint is a step darker than the tile it sits on — on a
 * white floor a lighter rug would read as a hole rather than as a zone — and
 * each takes a different hue so six pale fields stay tellable apart.
 */
export const ZONE_FLOOR: Record<string, string> = {
  desk: "#dce3ec",
  meeting: "#d2dae6",
  tea: "#d3e7dd",
  lounge: "#e8dcc6",
  canteen: "#eee5df",
  waiting: "#dfdcec",
  gym: "#c8d1d9",
  members: "#e6d7dc",
};

/**
 * Multiplies a hex colour toward black (k < 1) or white (k > 1). Each agent
 * owns one identity colour; its lit and shaded sides are derived from that, so
 * a sprite gains volume without needing a palette entry per body part.
 */
export function shade(hex: string, k: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) =>
    Math.max(0, Math.min(255, Math.round(k <= 1 ? c * k : c + (255 - c) * (k - 1)))),
  );
  return `#${channels.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** Gradients and filters shared by the whole scene; mounted once. */
export function SceneDefs() {
  return (
    <defs>
      {/* Large-format pale tile, falling off away from the north glazing. */}
      <linearGradient id="office-floor" x1="0" y1="0" x2="0.2" y2="1">
        <stop offset="0%" stopColor="#f2f5f8" />
        <stop offset="100%" stopColor="#e3e8ee" />
      </linearGradient>
      <linearGradient id="office-wall" x1="0" y1="0" x2="1" y2="0.25">
        <stop offset="0%" stopColor={WHITE.lit} />
        <stop offset="100%" stopColor="#e9edf2" />
      </linearGradient>
      <linearGradient id="office-glass" x1="0" y1="0" x2="0.4" y2="1">
        <stop offset="0%" stopColor="#dbe9f2" stopOpacity="0.5" />
        <stop offset="100%" stopColor="#b6cddc" stopOpacity="0.28" />
      </linearGradient>
      <linearGradient id="office-screen" x1="0" y1="0" x2="0.35" y2="1">
        <stop offset="0%" stopColor="#1b2740" />
        <stop offset="100%" stopColor="#0d1424" />
      </linearGradient>
      <radialGradient id="office-glow">
        <stop offset="0%" stopColor="#8fc4ff" stopOpacity="0.5" />
        <stop offset="100%" stopColor="#8fc4ff" stopOpacity="0" />
      </radialGradient>
      <radialGradient id="office-lamp">
        <stop offset="0%" stopColor="#ffeecb" stopOpacity="0.28" />
        <stop offset="100%" stopColor="#ffeecb" stopOpacity="0" />
      </radialGradient>
    </defs>
  );
}

// --- Solids ----------------------------------------------------------------

const pts = (...points: Array<[number, number]>) =>
  points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");

/**
 * The contact shadow that seats a solid on the floor. Drawn on the footprint
 * itself, offset away from the light, so a prop reads as resting on the
 * boards rather than floating over them.
 */
function Shadow({ x, y, w, d, h }: { x: number; y: number; w: number; d: number; h: number }) {
  const s = Math.min(6, 2 + h * 0.06);
  return (
    <rect
      x={x - s * 0.4}
      y={y + d - s * 0.5}
      width={w + s}
      height={s * 1.6}
      rx={s}
      fill={SHADOW}
      opacity={0.13}
    />
  );
}

export interface BoxProps {
  /** North-west floor corner, footprint size, and height. */
  x: number;
  y: number;
  w: number;
  d: number;
  h: number;
  top: string;
  /** Defaults derive from `top` so most props only name one colour. */
  front?: string;
  side?: string;
  radius?: number;
  shadow?: boolean;
  children?: React.ReactNode;
}

/**
 * A rectangular solid. Three faces are visible from this camera: the top, the
 * front (south) and the right (east) — that trio is what gives every prop its
 * weight. `children` are drawn on the top face in floor coordinates, so a
 * nameplate or a keyboard can simply be placed at its world position.
 */
export const Box = memo(function Box({
  x,
  y,
  w,
  d,
  h,
  top,
  front,
  side,
  radius = 1.5,
  shadow = true,
  children,
}: BoxProps) {
  const dx = h * LEAN;
  const dy = h * LIFT;
  const f = front ?? shade(top, 0.82);
  const s = side ?? shade(top, 0.68);
  return (
    <g>
      {shadow ? <Shadow x={x} y={y} w={w} d={d} h={h} /> : null}
      <polygon
        points={pts([x + w, y], [x + w, y + d], [x + w + dx, y + d - dy], [x + w + dx, y - dy])}
        fill={s}
      />
      <polygon
        points={pts([x, y + d], [x + w, y + d], [x + w + dx, y + d - dy], [x + dx, y + d - dy])}
        fill={f}
      />
      <rect x={x + dx} y={y - dy} width={w} height={d} rx={radius} fill={top} />
      {children ? <g transform={`translate(${dx} ${-dy})`}>{children}</g> : null}
    </g>
  );
});

/** A cylinder — round tables, stools, pedestals, planters. */
export const Cyl = memo(function Cyl({
  cx,
  cy,
  r,
  h,
  top,
  side,
  ry = r * 0.86,
}: {
  cx: number;
  cy: number;
  r: number;
  h: number;
  top: string;
  side?: string;
  ry?: number;
}) {
  const dx = h * LEAN;
  const dy = h * LIFT;
  const s = side ?? shade(top, 0.74);
  return (
    <g>
      <ellipse cx={cx} cy={cy + ry * 0.5} rx={r * 1.02} ry={ry * 0.5} fill={SHADOW} opacity={0.13} />
      <path
        d={`M ${cx - r} ${cy} A ${r} ${ry} 0 0 0 ${cx + r} ${cy} L ${cx + r + dx} ${cy - dy} A ${r} ${ry} 0 0 1 ${cx - r + dx} ${cy - dy} Z`}
        fill={s}
      />
      <ellipse cx={cx + dx} cy={cy - dy} rx={r} ry={ry} fill={top} />
    </g>
  );
});

// --- Shell -----------------------------------------------------------------

/** Tile size. Large format, so the grout grid stays quiet under the furniture. */
const TILE_W = 102;
const TILE_D = 87;

/** The floor: large-format pale tile on a fine grout grid. */
export const FloorSlab = memo(function FloorSlab() {
  const { x0, x1, y0, y1 } = FLOOR;
  const cols: number[] = [];
  for (let x = x0 + TILE_W; x < x1; x += TILE_W) cols.push(x);
  const rows: number[] = [];
  for (let y = y0 + TILE_D; y < y1; y += TILE_D) rows.push(y);
  return (
    <g>
      <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill="url(#office-floor)" />
      {rows.map((y) => (
        <line key={`r${y}`} x1={x0} y1={y} x2={x1} y2={y} stroke="#c8d0da" strokeOpacity={0.5} strokeWidth={0.9} />
      ))}
      {cols.map((x) => (
        <line key={`c${x}`} x1={x} y1={y0} x2={x} y2={y1} stroke="#c8d0da" strokeOpacity={0.42} strokeWidth={0.9} />
      ))}
      {/* Daylight pooling in from the north glazing. */}
      <rect x={x0} y={y0} width={x1 - x0} height={130} fill="#ffffff" opacity={0.42} />
    </g>
  );
});

/**
 * A surface standing on the north wall plane, in (world x, height) coords.
 * Rects drawn inside become the parallelograms the projection demands, so
 * wall panelling, wainscot and slats need no per-shape arithmetic.
 */
export function WallPlane({ children }: { children: React.ReactNode }) {
  return (
    <g transform={`translate(0 ${FLOOR.y0}) matrix(1 0 ${LEAN} ${-LIFT} 0 0)`}>{children}</g>
  );
}

/** The north wall: white plaster, with a bay of white battens behind the
 *  meeting room and a shadow-gap skirting instead of a timber wainscot. */
export const NorthWall = memo(function NorthWall({ slatFrom, slatTo }: { slatFrom: number; slatTo: number }) {
  const { x0, x1 } = FLOOR;
  const slats: number[] = [];
  for (let x = slatFrom + 6; x < slatTo; x += 13) slats.push(x);
  return (
    <g>
      <WallPlane>
        <rect x={x0} y={0} width={x1 - x0} height={WALL_H} fill="url(#office-wall)" />
        <rect x={slatFrom} y={0} width={slatTo - slatFrom} height={WALL_H} fill="#e6ebf1" />
        {slats.map((x) => (
          <rect key={x} x={x} y={0} width={6.5} height={WALL_H} fill={WHITE.lit} />
        ))}
        <rect x={x0} y={0} width={x1 - x0} height={18} fill={WHITE.face} />
        <rect x={x0} y={18} width={x1 - x0} height={2.5} fill={WHITE.deep} />
      </WallPlane>
      {/* Cap: the wall's own top surface, catching the ceiling light. */}
      <polygon
        points={pts(
          [px(x0, WALL_H), py(FLOOR.y0, WALL_H)],
          [px(x1, WALL_H), py(FLOOR.y0, WALL_H)],
          [px(x1, WALL_H) - 12, py(FLOOR.y0, WALL_H) - 7],
          [px(x0, WALL_H) - 12, py(FLOOR.y0, WALL_H) - 7],
        )}
        fill={WHITE.deep}
      />
      {/* Skirting where the wall meets the boards. */}
      <rect x={x0} y={FLOOR.y0 - 4} width={x1 - x0} height={4} fill={WHITE.deep} />
    </g>
  );
});

/** Thin returns closing the floor off on the other three sides. */
export const FloorEdges = memo(function FloorEdges() {
  const { x0, x1, y0, y1 } = FLOOR;
  return (
    <g>
      <rect x={x0 - 8} y={y0 - 4} width={8} height={y1 - y0 + 12} fill={WHITE.deep} />
      <rect x={x1} y={y0 - 4} width={8} height={y1 - y0 + 12} fill={WHITE.dark} />
      <rect x={x0 - 8} y={y1} width={x1 - x0 + 16} height={8} fill={WHITE.deep} />
    </g>
  );
});

/**
 * A display mounted on the north wall. The bezel takes the scene's lean so it
 * belongs to the wall, but its content is drawn upright at full height rather
 * than squashed into the floor's foreshortening — a board nobody can read is
 * not a board. `h` is the screen's height in scene units.
 */
export const WallScreen = memo(function WallScreen({
  x,
  base,
  w,
  h,
  children,
}: {
  /** World x of the screen's left edge, and its height above the floor. */
  x: number;
  base: number;
  w: number;
  h: number;
  children?: React.ReactNode;
}) {
  return (
    <g transform={`translate(${px(x, base)} ${py(FLOOR.y0, base)}) skewX(${-LEAN_DEG})`}>
      <rect x={-3} y={-h - 3} width={w + 6} height={h + 6} rx={5} fill={METAL.deep} />
      <rect x={0} y={-h} width={w} height={h} rx={3} fill="url(#office-screen)" />
      <path d={`M 0 ${-h} L ${w * 0.42} ${-h} L ${w * 0.16} 0 L 0 0 Z`} fill="#ffffff" opacity={0.045} />
      {children}
      <rect x={0} y={-h} width={w} height={h} rx={3} fill="none" stroke="#7fb4ef" strokeOpacity={0.28} strokeWidth={1} />
    </g>
  );
});

/**
 * A glazed partition. Only one of its faces turns toward this camera, so the
 * pane is drawn on that face and the frame is kept to a light anodised rail
 * and floor track — a dark frame at this scale reads as a solid black wall,
 * which is the opposite of what glass is for.
 */
export const GlassWall = memo(function GlassWall({
  x,
  y,
  w,
  d,
  h = 66,
}: {
  x: number;
  y: number;
  w: number;
  d: number;
  h?: number;
}) {
  const dx = h * LEAN;
  const dy = h * LIFT;
  const alongX = w >= d;
  const span = alongX ? w : d;
  const mullions: number[] = [];
  for (let t = 62; t < span - 24; t += 62) mullions.push(t);
  return (
    <g>
      {alongX ? (
        <polygon
          points={pts([x, y + d], [x + w, y + d], [x + w + dx, y + d - dy], [x + dx, y + d - dy])}
          fill="url(#office-glass)"
        />
      ) : (
        <polygon
          points={pts([x + w, y], [x + w, y + d], [x + w + dx, y + d - dy], [x + w + dx, y - dy])}
          fill="url(#office-glass)"
        />
      )}
      {mullions.map((t) => {
        const [mx, my] = alongX ? [x + t, y + d] : [x + w, y + t];
        return (
          <line
            key={t}
            x1={mx}
            y1={my}
            x2={mx + dx}
            y2={my - dy}
            stroke="#9fb4c2"
            strokeWidth={1.5}
            strokeOpacity={0.7}
          />
        );
      })}
      <rect x={x + dx} y={y - dy} width={w} height={d} rx={1.5} fill="#b4c1cd" />
      <rect x={x + dx} y={y - dy} width={w} height={d} rx={1.5} fill="none" stroke="#8698a8" strokeWidth={0.8} />
      <rect x={x} y={y} width={w} height={d} rx={1.5} fill="#8595a3" opacity={0.45} />
    </g>
  );
});

// --- Furniture -------------------------------------------------------------

export const DESK_H = 26;
/** Height of a seat pad, and of the head above the floor when sat on it. */
export const SEAT_H = 17;

/**
 * A workstation. The desktop is a flat surface square to the camera, which is
 * where the nameplate goes: at this angle it is the most readable place in the
 * whole scene. The monitor's screen faces its occupant, so what tells you the
 * desk is live is the light it throws onto the desktop.
 */
export const Desk = memo(function Desk({
  x,
  y,
  w,
  d,
  busy,
  name,
}: {
  x: number;
  y: number;
  w: number;
  d: number;
  busy: boolean;
  /** Nameplate text, already trimmed to the desktop by the caller. */
  name: string | null;
}) {
  return (
    <Box x={x} y={y} w={w} d={d} h={DESK_H} top={WHITE.lit} front={WHITE.dark} side={WHITE.deep} radius={2}>
      {busy ? <ellipse cx={x + w * 0.5} cy={y + d * 0.42} rx={w * 0.36} ry={d * 0.38} fill="url(#office-glow)" /> : null}
      {/* Monitor, stood at the back edge facing its occupant. */}
      <rect x={x + w * 0.5 - 19} y={y + 7} width={38} height={4.4} rx={1.6} fill={busy ? "#6ea8e8" : SCREEN_OFF} />
      <rect x={x + w * 0.5 - 19} y={y + 9.4} width={38} height={2.6} rx={1.2} fill={METAL.dark} />
      <rect x={x + w * 0.5 - 5} y={y + 12} width={10} height={3} rx={1.2} fill={METAL.face} />
      {/* Keyboard, notepad and mug on the near half. */}
      <rect x={x + w * 0.5 - 17} y={y + d - 21} width={34} height={9} rx={1.6} fill={WHITE.dark} />
      <rect x={x + w * 0.5 - 15} y={y + d - 19.4} width={30} height={5.8} rx={1} fill={METAL.lit} opacity={0.55} />
      <circle cx={x + w - 13} cy={y + d - 15} r={4.2} fill={TERRA} />
      <circle cx={x + w - 13} cy={y + d - 15} r={2.6} fill={shade(TERRA, 0.7)} />
      {name ? (
        <>
          <rect x={x + 6} y={y + d - 12.5} width={w - 12} height={10} rx={2} fill={WHITE.dark} />
          <text
            x={x + w / 2}
            y={y + d - 5}
            textAnchor="middle"
            fontSize={7}
            fontWeight={700}
            fill={METAL.dark}
          >
            {name}
          </text>
        </>
      ) : null}
    </Box>
  );
});

/**
 * Task chair, seen from above: a five-star base, a seat pad, and a back panel
 * that is deliberately narrower and shorter than the pad. A back as wide and
 * tall as the seat reads as a headstone at this angle, not as a chair.
 */
export const TaskChair = memo(function TaskChair({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <ellipse cx={x} cy={y + 9} rx={12} ry={4.6} fill={SHADOW} opacity={0.13} />
      <path
        d={`M ${x - 10} ${y + 7} L ${x + 10} ${y + 7} M ${x} ${y + 4} L ${x - 8} ${y + 13} M ${x} ${y + 4} L ${x + 8} ${y + 13}`}
        stroke={METAL.dark}
        strokeWidth={2.2}
        strokeLinecap="round"
      />
      <Box x={x - 10} y={y - 3} w={20} d={17} h={SEAT_H} top={FABRIC.face} front={FABRIC.dark} side={FABRIC.deep} radius={5} shadow={false} />
      <Box x={x - 8.5} y={y - 9} w={17} d={4} h={SEAT_H + 15} top={FABRIC.lit} front={FABRIC.face} side={FABRIC.deep} radius={3.5} shadow={false} />
    </g>
  );
});

/**
 * Light oak chair for the canteen and the meeting room. It is shaded one step
 * below the table it stands at, so oak-on-oak still separates where the seat
 * meets the tabletop.
 */
export const WoodChair = memo(function WoodChair({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <Box x={x - 9.5} y={y - 3} w={19} d={16} h={SEAT_H} top={OAK.face} front={OAK.dark} side={OAK.deep} radius={3} shadow={false} />
      <Box x={x - 8} y={y - 8} w={16} d={3.5} h={SEAT_H + 14} top={OAK.lit} front={OAK.face} side={OAK.dark} radius={2.5} shadow={false} />
    </g>
  );
});

/** Backless stool for the tea counter. */
export const Stool = memo(function Stool({ x, y }: { x: number; y: number }) {
  return <Cyl cx={x} cy={y} r={11} h={24} top={OAK.face} side={METAL.face} />;
});

/** Tea counter: an oak worktop on white cabinetry, machine on the end. */
export const TeaCounter = memo(function TeaCounter({ x, y, w, d }: { x: number; y: number; w: number; d: number }) {
  return (
    <Box x={x} y={y} w={w} d={d} h={34} top={OAK.lit} front={WHITE.dark} side={WHITE.deep} radius={2}>
      <rect x={x + 14} y={y + 5} width={26} height={22} rx={3} fill={METAL.face} />
      <rect x={x + 17} y={y + 8} width={20} height={7} rx={2} fill={METAL.lit} />
      <circle cx={x + 27} cy={y + 22} r={2.6} fill="#ffd479" />
      {[0.42, 0.52, 0.62].map((t, i) => (
        <g key={t}>
          <circle cx={x + w * t} cy={y + d * 0.5} r={5} fill={i === 1 ? WHITE.lit : "#d8a2b4"} stroke={WHITE.deep} strokeWidth={0.7} />
          <circle cx={x + w * t} cy={y + d * 0.5} r={3} fill={shade(i === 1 ? WHITE.lit : "#d8a2b4", 0.86)} />
        </g>
      ))}
      <rect x={x + w - 46} y={y + 8} width={30} height={14} rx={2} fill={MOSS.face} />
      <rect x={x + w - 42} y={y + 11} width={22} height={8} rx={1.5} fill={MOSS.lit} />
    </Box>
  );
});

/** Long meeting table with laptops laid out along it. */
export const MeetingTable = memo(function MeetingTable({ x, y, w, d }: { x: number; y: number; w: number; d: number }) {
  return (
    <Box x={x} y={y} w={w} d={d} h={DESK_H} top={OAK.lit} front={OAK.face} side={OAK.dark} radius={4}>
      {[0.16, 0.5, 0.84].map((t) => (
        <g key={t}>
          <rect x={x + w * t - 13} y={y + 8} width={26} height={13} rx={1.6} fill={METAL.face} />
          <rect x={x + w * t - 11} y={y + 10} width={22} height={9} rx={1} fill="#7fb4ef" opacity={0.6} />
          <rect x={x + w * t - 13} y={y + d - 20} width={26} height={12} rx={1.6} fill={METAL.lit} />
        </g>
      ))}
      <circle cx={x + w * 0.33} cy={y + d * 0.5} r={5} fill={MOSS.face} />
      <circle cx={x + w * 0.67} cy={y + d * 0.5} r={5} fill={TERRA} />
    </Box>
  );
});

/**
 * Three-seat sofa. Seams between the cushions and a pair of throw pillows are
 * what keep it from reading as one undifferentiated block — at this scale a
 * plain rounded box the size of a sofa just looks like a plinth.
 */
export const Sofa = memo(function Sofa({ x, y, w, d }: { x: number; y: number; w: number; d: number }) {
  return (
    <g>
      <Box x={x} y={y} w={w} d={d} h={24} top={UPHOLSTERY.face} front={UPHOLSTERY.dark} side={UPHOLSTERY.deep} radius={7}>
        {[1, 2].map((i) => (
          <line
            key={i}
            x1={x + (w * i) / 3}
            y1={y + 5}
            x2={x + (w * i) / 3}
            y2={y + d - 5}
            stroke={UPHOLSTERY.deep}
            strokeWidth={1.4}
            strokeOpacity={0.7}
          />
        ))}
        {/* Throw pillows, lying on the seat against the back cushion. */}
        {[0.2, 0.8].map((t, i) => (
          <rect
            key={t}
            x={x + w * t - 9}
            y={y + 4}
            width={18}
            height={12}
            rx={3.5}
            fill={i === 0 ? TERRA : MOSS.face}
          />
        ))}
      </Box>
      <Box x={x} y={y - 6} w={w} d={12} h={44} top={UPHOLSTERY.lit} front={UPHOLSTERY.face} side={UPHOLSTERY.deep} radius={6} shadow={false} />
      <Box x={x - 7} y={y - 2} w={13} d={d + 2} h={34} top={UPHOLSTERY.lit} front={UPHOLSTERY.face} side={UPHOLSTERY.deep} radius={5} shadow={false} />
      <Box x={x + w - 6} y={y - 2} w={13} d={d + 2} h={34} top={UPHOLSTERY.lit} front={UPHOLSTERY.face} side={UPHOLSTERY.deep} radius={5} shadow={false} />
    </g>
  );
});

/** Single armchair: same anatomy as the sofa, one seat wide. */
export const Armchair = memo(function Armchair({ x, y, w, d }: { x: number; y: number; w: number; d: number }) {
  return (
    <g>
      <Box x={x} y={y} w={w} d={d} h={24} top={MOSS.face} front={MOSS.dark} side={shade(MOSS.dark, 0.8)} radius={7} />
      <Box x={x} y={y - 6} w={w} d={11} h={44} top={MOSS.lit} front={MOSS.face} side={MOSS.dark} radius={5} shadow={false} />
      <Box x={x - 6} y={y - 2} w={11} d={d + 2} h={34} top={MOSS.lit} front={MOSS.face} side={MOSS.dark} radius={4} shadow={false} />
      <Box x={x + w - 5} y={y - 2} w={11} d={d + 2} h={34} top={MOSS.lit} front={MOSS.face} side={MOSS.dark} radius={4} shadow={false} />
    </g>
  );
});

export const CoffeeTable = memo(function CoffeeTable({ x, y, w, d }: { x: number; y: number; w: number; d: number }) {
  return (
    <Box x={x} y={y} w={w} d={d} h={14} top={OAK.face} front={OAK.dark} side={OAK.deep} radius={4}>
      <rect x={x + 12} y={y + 10} width={30} height={20} rx={2} fill={WHITE.lit} stroke={WHITE.deep} strokeWidth={0.8} />
      <circle cx={x + w - 22} cy={y + d * 0.5} r={4.6} fill={TERRA} />
    </Box>
  );
});

/** Round canteen table, laid for three. */
export const RoundTable = memo(function RoundTable({ cx, cy, r }: { cx: number; cy: number; r: number }) {
  const dy = DESK_H * LIFT;
  const dx = DESK_H * LEAN;
  return (
    <g>
      <Cyl cx={cx} cy={cy} r={12} h={DESK_H - 3} top={METAL.face} side={METAL.dark} ry={5} />
      <ellipse cx={cx + dx} cy={cy - dy} rx={r} ry={r * 0.88} fill={OAK.lit} />
      <ellipse cx={cx + dx} cy={cy - dy} rx={r} ry={r * 0.88} fill="none" stroke={OAK.dark} strokeWidth={2} />
      {[-1, 0, 1].map((k) => (
        <g key={k} transform={`translate(${cx + dx + k * r * 0.5} ${cy - dy + (k === 0 ? -r * 0.34 : r * 0.3)})`}>
          <circle r={9} fill={WHITE.lit} stroke={WHITE.deep} strokeWidth={0.8} />
          <circle r={5} fill={TERRA} opacity={0.5} />
        </g>
      ))}
    </g>
  );
});

/** Slatted oak bench for the waiting strip. */
export const Bench = memo(function Bench({ x, y, w, d }: { x: number; y: number; w: number; d: number }) {
  return (
    <g>
      <Box x={x} y={y} w={w} d={d} h={SEAT_H} top={OAK.face} front={OAK.dark} side={OAK.deep} radius={3}>
        {[0.34, 0.66].map((t) => (
          <line key={t} x1={x + 3} y1={y + d * t} x2={x + w - 3} y2={y + d * t} stroke={OAK.deep} strokeWidth={1.2} strokeOpacity={0.6} />
        ))}
      </Box>
      <Box x={x} y={y - 5} w={w} d={5} h={SEAT_H + 22} top={OAK.lit} front={OAK.dark} side={OAK.deep} radius={2.5} shadow={false} />
    </g>
  );
});

// --- Gym ---------------------------------------------------------------------

/**
 * A treadmill, seen from above. The belt reads as the machine even at this
 * scale, so the deck is charcoal and the moving surface darker still; the
 * console at the north end carries a small blue panel to say "powered on".
 */
export const Treadmill = memo(function Treadmill({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <Box x={x} y={y} w={34} d={52} h={9} top={METAL.lit} front={METAL.dark} side={METAL.deep} radius={3}>
        <rect x={x + 5} y={y + 6} width={24} height={40} rx={2} fill={METAL.deep} />
        {[0.28, 0.5, 0.72].map((t) => (
          <line
            key={t}
            x1={x + 6}
            y1={y + 6 + 40 * t}
            x2={x + 28}
            y2={y + 6 + 40 * t}
            stroke={METAL.lit}
            strokeWidth={0.8}
            strokeOpacity={0.55}
          />
        ))}
      </Box>
      {/* Side handrail along the belt; the far rail hides behind the deck. */}
      <Box x={x + 31} y={y + 3} w={3} d={42} h={27} top={METAL.lit} front={METAL.face} side={METAL.dark} radius={1.5} shadow={false} />
      <Box x={x + 3} y={y - 9} w={28} d={10} h={31} top={METAL.dark} front={METAL.deep} side={shade(METAL.dark, 0.82)} radius={2} />
      <rect x={x + 9} y={y - 7.4} width={16} height={6} rx={1.5} fill="#7fb4ef" opacity={0.85} />
    </g>
  );
});

/**
 * A dumbbell rack: a low charcoal shelf with two rows of pairs, lightest at
 * the ends. The discs shrinking along the row is what makes it read as a rack
 * rather than as a row of coins.
 */
export const DumbbellRack = memo(function DumbbellRack({ x, y, w }: { x: number; y: number; w: number }) {
  const slots = Math.max(2, Math.floor((w - 10) / 17));
  return (
    <Box x={x} y={y} w={w} d={17} h={17} top={METAL.face} front={METAL.dark} side={METAL.deep} radius={2}>
      {Array.from({ length: slots }, (_, i) => {
        const dx = x + 6 + i * 17;
        // Two pairs per slot, one behind the other.
        return (
          <g key={i}>
            <rect x={dx} y={y + 3.6} width={12} height={2.2} rx={1.1} fill={METAL.lit} />
            <circle cx={dx + 2.4} cy={y + 4.7} r={3.2 - i * 0.18} fill={METAL.deep} />
            <circle cx={dx + 9.6} cy={y + 4.7} r={3.2 - i * 0.18} fill={METAL.deep} />
            <rect x={dx + 1} y={y + 10.6} width={10} height={2} rx={1} fill={METAL.face} />
            <circle cx={dx + 2.9} cy={y + 11.6} r={2.5 - i * 0.15} fill={METAL.dark} />
            <circle cx={dx + 8.1} cy={y + 11.6} r={2.5 - i * 0.15} fill={METAL.dark} />
          </g>
        );
      })}
    </Box>
  );
});

/**
 * A workout bench with a racked bar. The bar is drawn at bar height in scene
 * coordinates (not on the pad) so it floats above the upholstery the way a
 * real one floats above the bench.
 */
export const WorkoutBench = memo(function WorkoutBench({ x, y }: { x: number; y: number }) {
  const barZ = 34;
  return (
    <g>
      <Cyl cx={x + 13} cy={y + 8} r={2.2} h={barZ} top={METAL.face} side={METAL.dark} ry={1.5} />
      <Cyl cx={x + 43} cy={y + 8} r={2.2} h={barZ} top={METAL.face} side={METAL.dark} ry={1.5} />
      <rect x={px(x - 16, barZ)} y={py(y + 7, barZ)} width={88} height={2.4} rx={1.2} fill={METAL.lit} />
      {/* Plates on the bar, seen edge-on as short thick ticks. */}
      <rect x={px(x - 14, barZ)} y={py(y + 4, barZ)} width={3.2} height={8} rx={1.6} fill={TERRA} />
      <rect x={px(x + 62, barZ)} y={py(y + 4, barZ)} width={3.2} height={8} rx={1.6} fill={TERRA} />
      <Box x={x} y={y} w={56} d={17} h={13} top={FABRIC.face} front={FABRIC.dark} side={FABRIC.deep} radius={4} />
    </g>
  );
});

/**
 * A rolled-out yoga mat on the rubber. Flat ink only — anything taller would
 * fight the jog lane beside it.
 */
export const YogaMat = memo(function YogaMat({ x, y }: { x: number; y: number }) {
  return (
    <g pointerEvents="none">
      <rect x={x} y={y} width={46} height={22} rx={10} fill={MOSS.face} />
      <rect x={x + 5} y={y + 4} width={36} height={14} rx={7} fill={MOSS.lit} opacity={0.7} />
    </g>
  );
});

/**
 * The standup table in the members corner: a high oak bar table. It says
 * "humans gather here" without stealing the agents' meeting-room furniture.
 */
export const StandupTable = memo(function StandupTable({ x, y, w, d }: { x: number; y: number; w: number; d: number }) {
  return (
    <Box x={x} y={y} w={w} d={d} h={38} top={OAK.lit} front={OAK.face} side={OAK.dark} radius={3}>
      <rect x={x + w * 0.26} y={y + d * 0.28} width={26} height={17} rx={2} fill={WHITE.lit} stroke={WHITE.deep} strokeWidth={0.8} />
      <line x1={x + w * 0.26 + 4} y1={y + d * 0.28 + 5} x2={x + w * 0.26 + 22} y2={y + d * 0.28 + 5} stroke="#c3cbd6" strokeWidth={0.9} />
      <line x1={x + w * 0.26 + 4} y1={y + d * 0.28 + 9} x2={x + w * 0.26 + 22} y2={y + d * 0.28 + 9} stroke="#c3cbd6" strokeWidth={0.9} />
      <circle cx={x + w * 0.64} cy={y + d * 0.52} r={4.2} fill={TERRA} />
      <circle cx={x + w * 0.64} cy={y + d * 0.52} r={2.6} fill={shade(TERRA, 0.7)} />
      <rect x={x + w - 24} y={y + 6} width={16} height={5} rx={2} fill={MOSS.face} />
    </Box>
  );
});

/** Potted plant, seen from above: a canopy of leaf discs over a pot. */
export const Plant = memo(function Plant({ x, y, scale = 1 }: { x: number; y: number; scale?: number }) {
  const r = 13 * scale;
  return (
    <g>
      <Cyl cx={x} cy={y} r={r * 0.68} h={20 * scale} top={WHITE.face} side={WHITE.deep} ry={r * 0.5} />
      <g transform={`translate(${px(x, 34 * scale)} ${py(y, 34 * scale)})`}>
        <circle cx={-r * 0.5} cy={r * 0.2} r={r * 0.66} fill={MOSS.face} />
        <circle cx={r * 0.55} cy={r * 0.3} r={r * 0.6} fill={MOSS.dark} />
        <circle cx={0} cy={-r * 0.45} r={r * 0.72} fill={MOSS.lit} />
        <circle cx={r * 0.3} cy={-r * 0.1} r={r * 0.44} fill={MOSS.face} />
      </g>
    </g>
  );
});

/** A rug or carpet-tile field lying flat on the boards. */
export const Rug = memo(function Rug({
  x,
  y,
  w,
  d,
  fill,
  radius = 8,
}: {
  x: number;
  y: number;
  w: number;
  d: number;
  fill: string;
  radius?: number;
}) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={d} rx={radius} fill={fill} />
      <rect x={x} y={y} width={w} height={d} rx={radius} fill="none" stroke={shade(fill, 0.9)} strokeWidth={1.2} />
    </g>
  );
});

/** Ceiling pendant seen from below: the fitting plus the pool it throws. */
export const Pendant = memo(function Pendant({ x, y, r = 30 }: { x: number; y: number; r?: number }) {
  return (
    <g pointerEvents="none">
      <circle cx={x} cy={y} r={r} fill="url(#office-lamp)" />
      <circle cx={x} cy={y} r={5.5} fill="#ffe9bd" />
      <circle cx={x} cy={y} r={5.5} fill="none" stroke={METAL.face} strokeWidth={1.4} />
    </g>
  );
});

// --- People ----------------------------------------------------------------

/** Illustration-only identity palettes; picked deterministically per agent. */
export const CLOTHES = ["#5f7fc4", "#5f9b78", "#d99a52", "#c67d95", "#7f74b8", "#5a9bb5"] as const;
export const SKINS = ["#f0c8a2", "#dda577", "#a8764f", "#87593a"] as const;
export const HAIRS = ["#31281f", "#5f4126", "#1c1f26", "#b9b3ab"] as const;

export function pick<T>(list: readonly T[], seed: string): T {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return list[Math.abs(h) % list.length] as T;
}

export interface SpriteColors {
  clothes: string;
  skin: string;
  hair: string;
}

/** Head radius. Big enough that a real avatar is legible at scene scale. */
export const HEAD_R = 12;
/** Humans read as taller and broader than the agent figures sharing the floor. */
export const HUMAN_SCALE = 1.3;
/** Height of the head's centre above the floor, standing and seated. */
export const HEAD_Z = 64;
export const SIT_HEAD_Z = 50;
/** Screen clearance above a sprite's floor point: head top plus its label. */
export const NAME_LIFT = 13;
export function headClearance(headZ: number, labelled: boolean): number {
  return headZ * LIFT + HEAD_R + (labelled ? NAME_LIFT : 2);
}

/** Face drawn when an agent has no avatar of its own. */
function ProceduralFace({ colors }: { colors: SpriteColors }) {
  const r = HEAD_R;
  return (
    <g>
      <circle r={r} fill={colors.skin} />
      <path d={`M ${-r} 0 a ${r} ${r} 0 0 1 ${r * 2} 0 z`} fill={colors.hair} transform="rotate(180)" />
      <path
        d={`M ${-r} -0.5 a ${r} ${r} 0 0 1 ${r * 0.9} ${-r * 0.86} l 0 -2.6 a ${r} ${r * 0.6} 0 0 0 ${-r * 0.9} ${r * 0.86} z`}
        fill={shade(colors.hair, 1.2)}
      />
      <circle cx={-3.8} cy={2.2} r={1.2} fill="#2b3038" />
      <circle cx={3.8} cy={2.2} r={1.2} fill="#2b3038" />
      <path d="M -2.8 6.2 q 2.8 2.1 5.6 0" fill="none" stroke="#2b3038" strokeOpacity={0.5} strokeWidth={0.9} strokeLinecap="round" />
    </g>
  );
}

/**
 * The agent's own avatar, clipped into the head. Falls back to a drawn face
 * when the agent has no avatar or the image fails to load — the office should
 * never show a hole where a head goes.
 */
function AvatarHead({
  colors,
  avatarUrl,
  clipId,
}: {
  colors: SpriteColors;
  avatarUrl: string | null;
  clipId: string;
}) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [avatarUrl]);
  const r = HEAD_R;
  if (!avatarUrl || broken) {
    return (
      <g>
        <circle r={r} fill={WHITE.lit} />
        <ProceduralFace colors={colors} />
        <circle r={r - 0.5} fill="none" stroke={METAL.dark} strokeOpacity={0.3} strokeWidth={1.1} />
      </g>
    );
  }
  const inner = r - 1;
  return (
    <g>
      <circle r={r} fill={WHITE.lit} />
      <clipPath id={clipId}>
        <circle r={inner} />
      </clipPath>
      <image
        href={avatarUrl}
        x={-inner}
        y={-inner}
        width={inner * 2}
        height={inner * 2}
        preserveAspectRatio="xMidYMid slice"
        clipPath={`url(#${clipId})`}
        onError={() => setBroken(true)}
      />
      <circle r={r - 0.5} fill="none" stroke={METAL.dark} strokeOpacity={0.35} strokeWidth={1.1} />
    </g>
  );
}

const TROUSER = "#3d4654";

export type Posture = "standing" | "sitting" | "walking";

export interface PersonProps {
  agentId: string;
  name: string;
  /** Trimmed name shown above the head, or null when a desk names them. */
  label: string | null;
  /** Floor position. */
  x: number;
  y: number;
  posture: Posture;
  colors: SpriteColors;
  avatarUrl: string | null;
  /** Walk-cycle frame; ignored unless walking. */
  frame?: 0 | 1;
  /** Human figures are scaled up and get hair plus an open collar so they read as people, not agents. */
  human?: boolean;
  onClick?: () => void;
}

/**
 * One agent standing on the floor. The body is drawn in elevation coordinates
 * (u across, v up) and pushed through the projection by a matrix, so it leans
 * with everything else; the head is drawn afterwards as a true circle at its
 * projected centre, because the avatar has to stay round.
 */
export const Person = memo(function Person({
  agentId,
  name,
  label,
  x,
  y,
  posture,
  colors,
  avatarUrl,
  frame = 0,
  human = false,
  onClick,
}: PersonProps) {
  const sitting = posture === "sitting";
  const walking = posture === "walking";
  const s = human ? HUMAN_SCALE : 1;
  const headZ = (sitting ? SIT_HEAD_Z : HEAD_Z) * s;
  const shoulder = headZ - 13;
  const hip = sitting ? 18 : 28;
  const swing = walking ? (frame === 0 ? 3.4 : -3.4) : 0;
  const hx = px(x, headZ);
  const hy = py(y, headZ);
  return (
    <g data-agent={agentId} className={onClick ? "cursor-pointer" : undefined} onClick={onClick}>
      <title>{name}</title>
      <ellipse cx={x} cy={y} rx={13 * s} ry={5.4 * s} fill={SHADOW} opacity={0.17} />
      <g transform={`translate(${x} ${y}) matrix(1 0 ${LEAN} ${-LIFT} 0 0) scale(${s})`}>
        {/* Legs. Seated, only the knees show above the seat pad. */}
        <rect x={-6.6 + swing} y={0} width={6} height={hip + 2} rx={3} fill={TROUSER} />
        <rect x={0.6 - swing} y={0} width={6} height={hip + 2} rx={3} fill={shade(TROUSER, 1.16)} />
        {/* Arms, hung outside the torso so the silhouette stays legible. */}
        <rect x={-12.4} y={hip + 2} width={4.6} height={shoulder - hip - 4} rx={2.3} fill={shade(colors.clothes, 1.12)} />
        <rect x={7.8} y={hip + 2} width={4.6} height={shoulder - hip - 4} rx={2.3} fill={shade(colors.clothes, 0.82)} />
        {/* Torso, lit down its left edge. */}
        <rect x={-9.5} y={hip} width={19} height={shoulder - hip} rx={5.5} fill={colors.clothes} />
        <rect x={-9.5} y={hip} width={5} height={shoulder - hip} rx={2.5} fill={shade(colors.clothes, 1.18)} opacity={0.8} />
        <rect x={4.5} y={hip} width={5} height={shoulder - hip} rx={2.5} fill={shade(colors.clothes, 0.8)} opacity={0.85} />
        {/* Shoulders and neck. */}
        <rect x={-10.5} y={shoulder - 6} width={21} height={7} rx={3.5} fill={shade(colors.clothes, 0.92)} />
        <rect x={-3.2} y={shoulder} width={6.4} height={5} rx={2.4} fill={shade(colors.skin, 0.88)} />
        {human ? (
          <path d={`M ${-4.4} ${shoulder - 6} L 0 ${shoulder - 1} L 4.4 ${shoulder - 6} Z`} fill={colors.skin} />
        ) : null}
      </g>
      <g transform={`translate(${hx} ${hy}) scale(${s})`}>
        <AvatarHead colors={colors} avatarUrl={avatarUrl} clipId={`office-av-${agentId}`} />
        {human && !avatarUrl ? (
          <g>
            <clipPath id={`office-hair-${agentId}`}>
              <circle r={HEAD_R - 0.6} />
            </clipPath>
            {/* Fringe straight across; the head ring frames it like a cap. */}
            <g clipPath={`url(#office-hair-${agentId})`}>
              <rect x={-HEAD_R} y={-HEAD_R - 0.5} width={HEAD_R * 2} height={HEAD_R * 1.12} fill={colors.hair} />
            </g>
          </g>
        ) : null}
      </g>
      {label ? (
        <text
          x={hx}
          y={hy - HEAD_R * s - 5}
          textAnchor="middle"
          fontSize={human ? 9.5 : 8.5}
          fontWeight={700}
          fill={METAL.deep}
          stroke={WHITE.lit}
          strokeWidth={2.8}
          strokeOpacity={0.85}
          paintOrder="stroke"
        >
          {label}
        </text>
      ) : null}
    </g>
  );
});

/** Where a walker paces: a run along the floor at a fixed depth. */
export interface WalkRoute {
  x0: number;
  x1: number;
  y: number;
  /** Scene units per second. */
  speed: number;
  /** Seconds of phase offset so co-present walkers do not march in step. */
  offset: number;
}

const REDUCED_MOTION =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;

/**
 * A self-animated walker pacing the floor. Owns its own ticker (120ms steps,
 * the two-frame leg cadence) so only this subtree re-renders while strolling;
 * honours prefers-reduced-motion by standing still at the start of its run.
 */
export function Walker(props: Omit<PersonProps, "x" | "y" | "posture" | "frame"> & { route: WalkRoute }) {
  const { route, ...person } = props;
  const secondsRef = useRef(route.offset);
  const [state, setState] = useState(() => walkAt(route, route.offset));

  useEffect(() => {
    if (REDUCED_MOTION?.matches) return;
    const id = setInterval(() => {
      secondsRef.current += 0.12;
      setState(walkAt(route, secondsRef.current));
    }, 120);
    return () => clearInterval(id);
  }, [route]);

  const still = REDUCED_MOTION?.matches === true;
  return (
    <Person
      {...person}
      x={state.x}
      y={route.y}
      posture={still ? "standing" : "walking"}
      frame={state.frame}
    />
  );
}

/** Position along a there-and-back run at `seconds`. */
export function walkAt(route: WalkRoute, seconds: number): { x: number; frame: 0 | 1 } {
  const span = route.x1 - route.x0;
  if (span <= 0) return { x: route.x0, frame: 0 };
  const loop = span * 2;
  const travelled = (((seconds * route.speed) % loop) + loop) % loop;
  const x = travelled <= span ? route.x0 + travelled : route.x1 - (travelled - span);
  return { x, frame: Math.floor(seconds * 4) % 2 === 0 ? 0 : 1 };
}
