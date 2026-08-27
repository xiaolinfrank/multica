"use client";

import { memo, useEffect, useRef, useState } from "react";

// Front-elevation drawing primitives for the Agent Office floor plan.
//
// The office is drawn as a wall of room boxes seen head-on — a dollhouse
// cutaway. Every room is an axis-aligned rectangle, so the rooms tile the
// canvas edge to edge with nothing wasted, and each one opens into a shallow
// one-point-perspective interior: a back wall inset from the frame, two side
// returns, a ceiling and a floor that widens toward the viewer. That single
// vanishing point buys enough depth to seat two ranks of desks without the
// diagonal dead corners a 45-degree projection leaves behind.
//
// It also turns the back wall into a real design surface, which is what the
// decor below is for: oak slats and wainscot, plaster, slim black metal,
// glass and greenery — warm wood, modern lines.
//
// Everything is plain SVG. Furniture needs concrete illustration colours
// (semantic tokens cannot express oak or brushed steel), so this file keeps a
// fixed palette; everything user-themed — names, bubbles, room captions —
// stays in tokens. The interiors are opaque and lit, so the office reads the
// same warm way whether the page around it is light or dark.

/** Scene box. Rooms tile it exactly; the SVG viewBox is these numbers. */
export const SCENE_W = 900;
export const SCENE_H = 420;

// --- Palette ---------------------------------------------------------------

const OAK = { lit: "#dcb689", face: "#c69c6b", dark: "#ab8155", deep: "#8b6740" };
const WALNUT = { lit: "#7d5942", face: "#664732", dark: "#503527", deep: "#3a2619" };
const PLASTER = { lit: "#f7f2e9", face: "#ece5d8", dark: "#dbd2c2", deep: "#c7bcaa" };
const METAL = { lit: "#4c525b", face: "#343a42", dark: "#22262c", deep: "#15181c" };
const LINEN = { lit: "#d6ccbd", face: "#c1b7a7", dark: "#a79c8c" };
const MOSS = { lit: "#88ad8d", face: "#628d6c", dark: "#4a7055" };
const TERRA = "#c2704f";
const SCREEN_ON = "#7fb4ef";
const SCREEN_OFF = "#3f4750";

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
      {/* Oak floor: the far end of the room falls away from the light. */}
      <linearGradient id="office-floor" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={OAK.dark} />
        <stop offset="100%" stopColor={OAK.lit} />
      </linearGradient>
      {/* Back wall: light spills in from the left return. */}
      <linearGradient id="office-wall" x1="0" y1="0" x2="1" y2="0.35">
        <stop offset="0%" stopColor={PLASTER.lit} />
        <stop offset="100%" stopColor={PLASTER.dark} />
      </linearGradient>
      <linearGradient id="office-glass" x1="0" y1="0" x2="0.4" y2="1">
        <stop offset="0%" stopColor="#dbe9f2" stopOpacity="0.75" />
        <stop offset="100%" stopColor="#b6cddc" stopOpacity="0.5" />
      </linearGradient>
      <linearGradient id="office-screen" x1="0" y1="0" x2="0.3" y2="1">
        <stop offset="0%" stopColor="#9fd0ff" />
        <stop offset="100%" stopColor="#4f7fb8" />
      </linearGradient>
      <radialGradient id="office-lamp">
        <stop offset="0%" stopColor="#ffe6b0" stopOpacity="0.55" />
        <stop offset="100%" stopColor="#ffe6b0" stopOpacity="0" />
      </radialGradient>
      <radialGradient id="office-blob">
        <stop offset="0%" stopColor="#3a2a18" stopOpacity="0.34" />
        <stop offset="60%" stopColor="#3a2a18" stopOpacity="0.14" />
        <stop offset="100%" stopColor="#3a2a18" stopOpacity="0" />
      </radialGradient>
    </defs>
  );
}

// --- Room geometry ---------------------------------------------------------

export interface RoomRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Screen height of the floor, front line to back line. */
  depth: number;
}

/** Ceiling band, back-wall rise and side inset of the perspective opening. */
const CEIL = 11;
const RISE = 12;
const INSET = 20;
/** Structural band under the front floor line; carries the room caption. */
const SLAB = 20;

/** The interior lines of one room box, in scene units. */
export interface RoomBox {
  /** Outer frame. */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Back wall, inset from the frame by the perspective opening. */
  xb0: number;
  xb1: number;
  backTop: number;
  /** Wall/floor junction — the back rank stands here. */
  horizonY: number;
  /** Front floor line — the front rank stands here. */
  floorY: number;
}

export function roomBox(r: RoomRect): RoomBox {
  const floorY = r.y + r.h - SLAB;
  return {
    x0: r.x,
    x1: r.x + r.w,
    y0: r.y,
    y1: r.y + r.h,
    xb0: r.x + INSET,
    xb1: r.x + r.w - INSET,
    backTop: r.y + CEIL + RISE,
    horizonY: floorY - r.depth,
    floorY,
  };
}

/** Headroom above a sprite standing at `baseY` before it hits the ceiling. */
export function headroom(box: RoomBox, baseY: number): number {
  return baseY - box.backTop - 6;
}

const pts = (...points: Array<[number, number]>) =>
  points.map(([x, y]) => `${x},${y}`).join(" ");

/** Soft contact shadow that seats a prop on the floor. */
function Contact({ x, y, rx, ry = rx * 0.28 }: { x: number; y: number; rx: number; ry?: number }) {
  return <ellipse cx={x} cy={y} rx={rx} ry={ry} fill="url(#office-blob)" />;
}

// --- Room shell ------------------------------------------------------------

/** Oak plank seams, converging on the room's vanishing point. */
function FloorPlanks({ box }: { box: RoomBox }) {
  const { x0, x1, xb0, xb1, horizonY, floorY } = box;
  const seams: React.ReactNode[] = [];
  const lanes = 9;
  for (let i = 1; i < lanes; i += 1) {
    const t = i / lanes;
    seams.push(
      <line
        key={`v${i}`}
        x1={xb0 + (xb1 - xb0) * t}
        y1={horizonY}
        x2={x0 + (x1 - x0) * t}
        y2={floorY}
        stroke={OAK.deep}
        strokeOpacity={0.28}
        strokeWidth={0.7}
      />,
    );
  }
  // Two board ends, spaced so the near one is visibly wider than the far one.
  for (const t of [0.34, 0.7]) {
    const y = horizonY + (floorY - horizonY) * t;
    seams.push(
      <line
        key={`h${t}`}
        x1={xb0 + (x0 - xb0) * t}
        y1={y}
        x2={xb1 + (x1 - xb1) * t}
        y2={y}
        stroke={OAK.deep}
        strokeOpacity={0.2}
        strokeWidth={0.7}
      />,
    );
  }
  return <g>{seams}</g>;
}

/** Vertical oak battens — the accent wall behind the meeting and lounge. */
function SlatWall({
  x,
  y,
  w,
  h,
  pitch = 9,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  pitch?: number;
}) {
  const slats: React.ReactNode[] = [];
  const count = Math.floor(w / pitch);
  const pad = (w - count * pitch) / 2;
  for (let i = 0; i < count; i += 1) {
    const sx = x + pad + i * pitch;
    slats.push(
      <g key={i}>
        <rect x={sx} y={y} width={pitch - 3} height={h} fill={OAK.face} />
        <rect x={sx} y={y} width={1.4} height={h} fill={OAK.lit} />
      </g>,
    );
  }
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} fill={WALNUT.dark} />
      {slats}
    </g>
  );
}

/** Horizontal oak wainscot with a capping rail. */
function Wainscot({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} fill={OAK.face} />
      <rect x={x} y={y} width={w} height={2.4} fill={OAK.lit} />
      <line x1={x} y1={y + h * 0.45} x2={x + w} y2={y + h * 0.45} stroke={OAK.dark} strokeWidth={0.8} />
      <rect x={x} y={y - 2.6} width={w} height={2.6} fill={OAK.dark} />
    </g>
  );
}

/** A framed print in a slim black frame. */
function ArtFrame({
  x,
  y,
  w,
  h,
  ink,
  variant,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  ink: string;
  variant: 0 | 1 | 2;
}) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} fill={PLASTER.lit} stroke={METAL.dark} strokeWidth={1.4} />
      {variant === 0 ? (
        <circle cx={x + w / 2} cy={y + h * 0.52} r={Math.min(w, h) * 0.26} fill={ink} opacity={0.75} />
      ) : variant === 1 ? (
        <path
          d={`M ${x + 4} ${y + h - 5} L ${x + w * 0.4} ${y + h * 0.38} L ${x + w * 0.62} ${y + h * 0.66} L ${x + w - 4} ${y + 5}`}
          fill="none"
          stroke={ink}
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <g>
          <rect x={x + 4} y={y + h * 0.5} width={w - 8} height={h * 0.16} fill={ink} opacity={0.6} />
          <rect x={x + 4} y={y + h * 0.72} width={(w - 8) * 0.55} height={h * 0.12} fill={ink} opacity={0.35} />
        </g>
      )}
    </g>
  );
}

/** Wall-mounted display in a black bezel; `text` is the line it shows. */
function WallScreen({
  x,
  y,
  w,
  h,
  text,
  live,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string | null;
  live: boolean;
}) {
  return (
    <g>
      <rect x={x - 2} y={y - 2} width={w + 4} height={h + 4} rx={2.5} fill={METAL.dark} />
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={1.5}
        fill={live ? "url(#office-screen)" : SCREEN_OFF}
        opacity={live ? 0.95 : 0.8}
      />
      {text ? (
        <text
          x={x + w / 2}
          y={y + h / 2 + 3.4}
          textAnchor="middle"
          fontSize={9}
          fontWeight={700}
          fill="#f4f9ff"
          opacity={live ? 0.96 : 0.55}
        >
          {text}
        </text>
      ) : null}
      {/* A screen with nothing to say still reflects the room. */}
      <path d={`M ${x} ${y + h} L ${x + w * 0.32} ${y} L ${x + w * 0.5} ${y} L ${x + w * 0.16} ${y + h} Z`} fill="#ffffff" opacity={0.07} />
    </g>
  );
}

/** Linear pendant over a work surface. */
function LinearPendant({ x, y, w, drop }: { x: number; y: number; w: number; drop: number }) {
  return (
    <g>
      <line x1={x + w * 0.22} y1={y} x2={x + w * 0.22} y2={y + drop} stroke={METAL.face} strokeWidth={0.9} />
      <line x1={x + w * 0.78} y1={y} x2={x + w * 0.78} y2={y + drop} stroke={METAL.face} strokeWidth={0.9} />
      <rect x={x} y={y + drop} width={w} height={4} rx={2} fill={METAL.dark} />
      <rect x={x + 1.5} y={y + drop + 3.4} width={w - 3} height={1.6} rx={0.8} fill="#ffe9bd" />
      <ellipse cx={x + w / 2} cy={y + drop + 14} rx={w * 0.6} ry={13} fill="url(#office-lamp)" />
    </g>
  );
}

/** Globe pendant, for the tea corner and canteen. */
function GlobePendant({ x, y, drop, r = 5 }: { x: number; y: number; drop: number; r?: number }) {
  return (
    <g>
      <line x1={x} y1={y} x2={x} y2={y + drop} stroke={METAL.face} strokeWidth={0.9} />
      <circle cx={x} cy={y + drop + r} r={r} fill="#ffeec9" />
      <circle cx={x - r * 0.3} cy={y + drop + r * 0.7} r={r * 0.35} fill="#fffaf0" />
      <ellipse cx={x} cy={y + drop + r + 11} rx={r * 2.6} ry={10} fill="url(#office-lamp)" />
    </g>
  );
}

/** Open oak shelf carrying a few objects. */
function Shelf({ x, y, w, items }: { x: number; y: number; w: number; items: string[] }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={3} fill={OAK.lit} />
      <rect x={x} y={y + 3} width={w} height={1.6} fill={OAK.deep} opacity={0.55} />
      {items.map((color, i) => {
        const bw = 4.2;
        const bh = 9 + ((i * 5) % 6);
        return (
          <rect
            key={i}
            x={x + 5 + i * (bw + 1.6)}
            y={y - bh}
            width={bw}
            height={bh}
            rx={0.8}
            fill={color}
          />
        );
      })}
    </g>
  );
}

/** Black-framed glazing that closes a room off without blocking the light. */
function GlassPanel({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} fill="url(#office-glass)" />
      <rect x={x} y={y} width={w} height={h} fill="none" stroke={METAL.dark} strokeWidth={1.6} />
      <line x1={x + w / 2} y1={y} x2={x + w / 2} y2={y + h} stroke={METAL.dark} strokeWidth={1.2} />
      <path d={`M ${x + 3} ${y + h - 3} L ${x + w * 0.42} ${y + 3}`} stroke="#ffffff" strokeOpacity={0.35} strokeWidth={2} />
    </g>
  );
}

export type WallZone = "desk" | "meeting" | "tea" | "lounge" | "canteen" | "waiting";

/** What each room hangs on its back wall. See the per-room notes inline. */
function WallDecor({ box, zone, board }: { box: RoomBox; zone: WallZone; board: string | null }) {
  const { xb0, xb1, backTop, horizonY } = box;
  const w = xb1 - xb0;
  const h = horizonY - backTop;
  const cx = (xb0 + xb1) / 2;

  switch (zone) {
    // Open plan: plaster over an oak wainscot, one floating shelf, the clock,
    // and the running board — the number the room is actually judged on.
    case "desk":
      return (
        <g>
          <Wainscot x={xb0} y={horizonY - h * 0.34} w={w} h={h * 0.34} />
          <LinearPendant x={xb0 + w * 0.08} y={backTop} w={w * 0.34} drop={h * 0.14} />
          <LinearPendant x={xb0 + w * 0.58} y={backTop} w={w * 0.34} drop={h * 0.14} />
          <Shelf
            x={xb0 + 14}
            y={backTop + h * 0.52}
            w={w * 0.26}
            items={[TERRA, OAK.dark, MOSS.face, "#8fa9d6", PLASTER.deep]}
          />
          <g transform={`translate(${xb0 + w * 0.36} ${backTop + h * 0.34})`}>
            <circle r={8} fill={PLASTER.lit} stroke={METAL.dark} strokeWidth={1.4} />
            <line y2={-5} stroke={METAL.dark} strokeWidth={1.3} strokeLinecap="round" />
            <line x2={3.4} stroke={METAL.dark} strokeWidth={1.1} strokeLinecap="round" />
          </g>
          <WallScreen
            x={cx + w * 0.12}
            y={backTop + h * 0.24}
            w={w * 0.3}
            h={h * 0.32}
            text={board}
            live={board !== null}
          />
        </g>
      );

    // Squad room: a full slat wall, the shared screen, glazing to the corridor.
    case "meeting":
      return (
        <g>
          <SlatWall x={xb0} y={backTop} w={w} h={h} />
          <WallScreen
            x={cx - w * 0.28}
            y={backTop + h * 0.16}
            w={w * 0.56}
            h={h * 0.46}
            text={board}
            live={board !== null}
          />
          <LinearPendant x={cx - w * 0.3} y={backTop - RISE} w={w * 0.6} drop={h * 0.08} />
        </g>
      );

    // Tea corner: tiled splashback over the counter run, mugs on open shelves.
    case "tea":
      return (
        <g>
          <rect x={xb0} y={backTop} width={w} height={h} fill={PLASTER.lit} />
          <g>
            {Array.from({ length: Math.ceil(w / 11) }, (_, i) =>
              Array.from({ length: 3 }, (_, j) => (
                <rect
                  key={`${i}-${j}`}
                  x={xb0 + i * 11 + 0.6}
                  y={horizonY - h * 0.52 + j * 11 + 0.6}
                  width={9.8}
                  height={9.8}
                  rx={1.2}
                  fill={j % 2 === i % 2 ? "#eef2f1" : "#e2eae7"}
                />
              )),
            )}
          </g>
          <Shelf x={xb0 + 12} y={backTop + h * 0.3} w={w - 24} items={[TERRA, PLASTER.lit, MOSS.face, "#d8a2b4"]} />
          <GlobePendant x={xb0 + w * 0.22} y={backTop - RISE} drop={h * 0.2} />
          <GlobePendant x={xb0 + w * 0.5} y={backTop - RISE} drop={h * 0.28} />
          <GlobePendant x={xb0 + w * 0.78} y={backTop - RISE} drop={h * 0.2} />
        </g>
      );

    // Lounge: slat wall as a gallery hang, warm and quiet.
    case "lounge":
      return (
        <g>
          <SlatWall x={xb0} y={backTop} w={w} h={h} pitch={11} />
          {[0, 1, 2].map((i) => (
            <ArtFrame
              key={i}
              x={xb0 + w * (0.1 + i * 0.29)}
              y={backTop + h * (i === 1 ? 0.16 : 0.24)}
              w={w * 0.21}
              h={h * (i === 1 ? 0.44 : 0.34)}
              ink={[TERRA, MOSS.dark, "#7c92c8"][i] as string}
              variant={i as 0 | 1 | 2}
            />
          ))}
        </g>
      );

    // Canteen: half-height oak, a chalkboard menu, globes over the tables.
    case "canteen":
      return (
        <g>
          <rect x={xb0} y={backTop} width={w} height={h} fill="url(#office-wall)" />
          <Wainscot x={xb0} y={horizonY - h * 0.42} w={w} h={h * 0.42} />
          <g>
            <rect
              x={cx - w * 0.22}
              y={backTop + h * 0.14}
              width={w * 0.44}
              height={h * 0.36}
              rx={2}
              fill="#2f3a35"
              stroke={OAK.dark}
              strokeWidth={2}
            />
            {[0.3, 0.52, 0.74].map((t, i) => (
              <rect
                key={t}
                x={cx - w * 0.16}
                y={backTop + h * 0.14 + h * 0.36 * t}
                width={w * (i === 2 ? 0.2 : 0.3)}
                height={2}
                rx={1}
                fill="#e8efe9"
                opacity={0.55}
              />
            ))}
          </g>
          <GlobePendant x={cx - w * 0.26} y={backTop - RISE} drop={h * 0.22} r={4.4} />
          <GlobePendant x={cx + w * 0.26} y={backTop - RISE} drop={h * 0.22} r={4.4} />
        </g>
      );

    // Waiting strip: plaster, a coat rail, one poster. Deliberately spare.
    case "waiting":
    default:
      return (
        <g>
          <rect x={xb0} y={backTop} width={w} height={h} fill="url(#office-wall)" />
          <GlassPanel x={xb0 + 4} y={backTop + 4} w={w * 0.34} h={h - 8} />
          <g>
            <rect x={cx - w * 0.02} y={horizonY - h * 0.5} width={w * 0.36} height={2.6} rx={1.3} fill={OAK.dark} />
            {[0.12, 0.4, 0.68].map((t) => (
              <circle
                key={t}
                cx={cx - w * 0.02 + w * 0.36 * t + 4}
                cy={horizonY - h * 0.5 + 5}
                r={2}
                fill={METAL.face}
              />
            ))}
          </g>
          <ArtFrame
            x={cx + w * 0.06}
            y={backTop + h * 0.14}
            w={w * 0.24}
            h={h * 0.3}
            ink={TERRA}
            variant={1}
          />
        </g>
      );
  }
}

/**
 * One room box: ceiling, side returns, back wall with its decor, the oak
 * floor, and the structural slab under it that carries the room caption.
 */
export const RoomShell = memo(function RoomShell({
  box,
  zone,
  board = null,
}: {
  box: RoomBox;
  zone: WallZone;
  /** Line shown on this room's wall display, when it has one. */
  board?: string | null;
}) {
  const { x0, x1, y0, y1, xb0, xb1, backTop, horizonY, floorY } = box;
  return (
    <g>
      {/* Ceiling, then the two side returns. Light enters from the left, so
          the left return is the lit one and the right falls into shadow. */}
      <polygon points={pts([x0, y0], [x1, y0], [xb1, backTop], [xb0, backTop])} fill={PLASTER.deep} />
      <polygon
        points={pts([x0, y0], [xb0, backTop], [xb0, horizonY], [x0, floorY])}
        fill={PLASTER.lit}
      />
      <polygon
        points={pts([x1, y0], [xb1, backTop], [xb1, horizonY], [x1, floorY])}
        fill={PLASTER.dark}
      />
      <rect x={xb0} y={backTop} width={xb1 - xb0} height={horizonY - backTop} fill="url(#office-wall)" />
      <WallDecor box={box} zone={zone} board={board} />

      {/* Floor, its planks, and the oak skirting where wall meets floor. */}
      <polygon points={pts([xb0, horizonY], [xb1, horizonY], [x1, floorY], [x0, floorY])} fill="url(#office-floor)" />
      <FloorPlanks box={box} />
      <rect x={xb0} y={horizonY - 4} width={xb1 - xb0} height={4} fill={OAK.deep} />

      {/* Structural slab. It reads as this room's floor edge and as the
          ceiling of the room below, and carries the caption. */}
      <rect x={x0} y={floorY} width={x1 - x0} height={y1 - floorY} fill={WALNUT.face} />
      <rect x={x0} y={floorY} width={x1 - x0} height={2.4} fill={OAK.lit} opacity={0.7} />
      <rect x={x0} y={y1 - 1.2} width={x1 - x0} height={1.2} fill={WALNUT.deep} />
    </g>
  );
});

// --- Furniture -------------------------------------------------------------
//
// Every piece is drawn in local coordinates with the floor at y = 0 and up
// negative, then placed with translate(x, baseY) and scaled for its rank.

function Piece({
  x,
  baseY,
  scale = 1,
  children,
}: {
  x: number;
  baseY: number;
  scale?: number;
  children: React.ReactNode;
}) {
  return <g transform={`translate(${x} ${baseY}) scale(${scale})`}>{children}</g>;
}

/** Height of a desk's work surface, and of the seats around the office. */
export const DESK_TOP = 26;
const SEAT_H = 16;
/**
 * Height an occupant's hips sit at, per seat. A sprite's whole upper body is
 * built off this, so a stool has to lift its occupant as much as it lifts the
 * seat pad or the two come apart.
 */
export const SIT_ON = { chair: 18, stool: 26, sofa: 22, bench: 17 } as const;
const STOOL_H = 24;

/** The desk nameplate. Names are trimmed to it by the caller. */
export const NAMEPLATE_W = 56;
export const NAMEPLATE_FONT = 6.4;

/** Task chair, seen from behind its occupant. */
export const TaskChair = memo(function TaskChair({
  x,
  baseY,
  scale = 1,
}: {
  x: number;
  baseY: number;
  scale?: number;
}) {
  return (
    <Piece x={x} baseY={baseY} scale={scale}>
      <Contact x={0} y={0} rx={17} />
      <rect x={-1.8} y={-SEAT_H} width={3.6} height={SEAT_H - 2} fill={METAL.face} />
      <path d={`M -11 -1 L 11 -1 M 0 -2 L -9 4 M 0 -2 L 9 4`} stroke={METAL.dark} strokeWidth={2} strokeLinecap="round" />
      <rect x={-13} y={-SEAT_H - 3.5} width={26} height={4.5} rx={2.2} fill={LINEN.dark} />
      <rect x={-11} y={-SEAT_H - 22} width={22} height={19} rx={5} fill={LINEN.face} />
      <rect x={-11} y={-SEAT_H - 22} width={4} height={19} rx={2} fill={LINEN.lit} />
    </Piece>
  );
});

/**
 * Solid oak chair for the canteen. A round table stands on a pedestal and
 * hides almost nothing, so the seat under it has to be worth looking at —
 * a task chair's star base and gas lift read as clutter down there.
 */
export const WoodChair = memo(function WoodChair({ x, baseY }: { x: number; baseY: number }) {
  return (
    <Piece x={x} baseY={baseY}>
      <Contact x={0} y={0} rx={14} />
      <path d={`M -10 0 L -8.4 -${SEAT_H} M 10 0 L 8.4 -${SEAT_H}`} stroke={OAK.deep} strokeWidth={2.6} strokeLinecap="round" />
      <rect x={-10} y={-SEAT_H - 3} width={20} height={3.4} rx={1.4} fill={OAK.face} />
      <rect x={-10} y={-SEAT_H - 3} width={20} height={1.2} rx={0.6} fill={OAK.lit} />
      <rect x={-8.6} y={-SEAT_H - 21} width={2.4} height={18} rx={1.2} fill={OAK.dark} />
      <rect x={6.2} y={-SEAT_H - 21} width={2.4} height={18} rx={1.2} fill={OAK.dark} />
      <rect x={-8.6} y={-SEAT_H - 21} width={17.2} height={3} rx={1.5} fill={OAK.face} />
      <rect x={-8.6} y={-SEAT_H - 13} width={17.2} height={2.4} rx={1.2} fill={OAK.dark} />
    </Piece>
  );
});

/**
 * One workstation: oak top on black legs, a modesty panel carrying the
 * occupant's nameplate, and a monitor set to one side so it never covers the
 * face behind it. The screen lights up while that agent has work running.
 */
export const Workstation = memo(function Workstation({
  x,
  baseY,
  scale = 1,
  busy,
  name,
}: {
  x: number;
  baseY: number;
  scale?: number;
  busy: boolean;
  /** Nameplate text, already trimmed to the panel by the caller. */
  name: string | null;
}) {
  const halfW = 46;
  return (
    <Piece x={x} baseY={baseY} scale={scale}>
      <Contact x={0} y={0} rx={halfW + 4} />
      <rect x={-halfW + 5} y={-DESK_TOP + 3} width={3.5} height={DESK_TOP - 3} fill={METAL.face} />
      <rect x={halfW - 8.5} y={-DESK_TOP + 3} width={3.5} height={DESK_TOP - 3} fill={METAL.dark} />
      {/* Modesty panel + nameplate */}
      <rect x={-halfW + 6} y={-DESK_TOP + 4} width={halfW * 2 - 12} height={13} fill={OAK.dark} />
      <rect x={-NAMEPLATE_W / 2} y={-DESK_TOP + 5.5} width={NAMEPLATE_W} height={9.5} rx={1.6} fill={PLASTER.lit} opacity={0.94} />
      {name ? (
        <text x={0} y={-DESK_TOP + 12.7} textAnchor="middle" fontSize={NAMEPLATE_FONT} fontWeight={700} fill={METAL.dark}>
          {name}
        </text>
      ) : null}
      {/* Work surface */}
      <rect x={-halfW} y={-DESK_TOP} width={halfW * 2} height={4} rx={1.2} fill={OAK.face} />
      <rect x={-halfW} y={-DESK_TOP} width={halfW * 2} height={1.6} rx={0.8} fill={OAK.lit} />
      {/* Monitor, parked on the east half clear of the occupant's head. */}
      <g transform={`translate(${halfW - 28} ${-DESK_TOP})`}>
        <rect x={-6} y={-2.2} width={12} height={2.2} rx={1} fill={METAL.dark} />
        <rect x={-1.6} y={-8} width={3.2} height={6} fill={METAL.face} />
        <rect x={-17} y={-30} width={34} height={22} rx={2} fill={METAL.dark} />
        <rect x={-15.2} y={-28.2} width={30.4} height={18.4} rx={1.2} fill={busy ? "url(#office-screen)" : SCREEN_OFF} opacity={busy ? 1 : 0.75} />
        {busy ? (
          <g fill="#ffffff">
            <rect x={-12} y={-25} width={16} height={1.8} rx={0.9} opacity={0.85} />
            <rect x={-12} y={-21.4} width={22} height={1.8} rx={0.9} opacity={0.6} />
            <rect x={-12} y={-17.8} width={11} height={1.8} rx={0.9} opacity={0.45} />
          </g>
        ) : null}
      </g>
      {/* Keyboard and mug, so an empty desk still reads as somebody's desk. */}
      <rect x={-30} y={-DESK_TOP - 2.4} width={26} height={2.4} rx={1} fill={METAL.face} />
      <Mug x={-38} y={-DESK_TOP} color={TERRA} />
    </Piece>
  );
});

/** A mug standing on a surface. */
function Mug({ x, y, color }: { x: number; y: number; color: string }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <path d={`M 3.4 -7 a 2.2 2.2 0 0 1 0 4.4`} fill="none" stroke={shade(color, 0.8)} strokeWidth={1.2} />
      <rect x={-3.6} y={-8.4} width={7.2} height={8.4} rx={1.2} fill={color} />
      <rect x={-3.6} y={-8.4} width={2} height={8.4} rx={1} fill={shade(color, 1.2)} />
      <ellipse cx={0} cy={-8.4} rx={3.6} ry={1.1} fill={shade(color, 0.7)} />
    </g>
  );
}

/**
 * Long oak conference table; the squad sits behind it, facing the room. The
 * panelled front is load-bearing, not decoration: in elevation a table on
 * bare legs hides nothing, and the chairs behind it float.
 */
export const MeetingTable = memo(function MeetingTable({
  x,
  baseY,
  w,
}: {
  x: number;
  baseY: number;
  w: number;
}) {
  const half = w / 2;
  return (
    <Piece x={x} baseY={baseY}>
      <Contact x={0} y={0} rx={half + 6} />
      <rect x={-half + 14} y={-DESK_TOP + 4} width={4} height={DESK_TOP - 4} fill={METAL.face} />
      <rect x={half - 18} y={-DESK_TOP + 4} width={4} height={DESK_TOP - 4} fill={METAL.dark} />
      <rect x={-half + 8} y={-DESK_TOP + 4} width={w - 16} height={DESK_TOP - 10} fill={OAK.dark} />
      <rect x={-half + 8} y={-DESK_TOP + 4} width={w - 16} height={1.6} fill={OAK.deep} />
      <rect x={-half} y={-DESK_TOP} width={w} height={5} rx={2} fill={OAK.face} />
      <rect x={-half} y={-DESK_TOP} width={w} height={1.8} rx={0.9} fill={OAK.lit} />
      {/* Two open laptops and a carafe. */}
      {[-half * 0.5, half * 0.42].map((off, i) => (
        <g key={i} transform={`translate(${off} ${-DESK_TOP})`}>
          <rect x={-10} y={-1.6} width={20} height={1.8} rx={0.9} fill={METAL.lit} />
          <path d="M -8.6 -1.8 L -6.6 -13 L 6.6 -13 L 8.6 -1.8 Z" fill={METAL.face} />
          <path d="M -6.6 -3 L -5.2 -11.6 L 5.2 -11.6 L 6.6 -3 Z" fill={SCREEN_ON} opacity={0.75} />
        </g>
      ))}
      <Mug x={half * 0.05} y={-DESK_TOP} color={MOSS.face} />
    </Piece>
  );
});

/** Tea-corner counter: oak top, panelled front, espresso machine on the end. */
export const TeaCounter = memo(function TeaCounter({
  x,
  baseY,
  w,
}: {
  x: number;
  baseY: number;
  w: number;
}) {
  const half = w / 2;
  const top = 34;
  return (
    <Piece x={x} baseY={baseY}>
      <Contact x={0} y={0} rx={half + 4} />
      <rect x={-half} y={-top + 5} width={w} height={top - 5} fill={OAK.dark} />
      {[0.25, 0.5, 0.75].map((t) => (
        <rect key={t} x={-half + w * t - 0.6} y={-top + 7} width={1.2} height={top - 9} fill={WALNUT.face} opacity={0.6} />
      ))}
      <rect x={-half - 2} y={-top} width={w + 4} height={5.5} rx={1.6} fill={OAK.face} />
      <rect x={-half - 2} y={-top} width={w + 4} height={1.8} rx={0.9} fill={OAK.lit} />
      {/* Espresso machine */}
      <g transform={`translate(${-half + 20} ${-top})`}>
        <rect x={-10} y={-20} width={20} height={20} rx={2} fill={METAL.face} />
        <rect x={-10} y={-20} width={20} height={4} rx={1.5} fill={METAL.lit} />
        <circle cx={-4} cy={-11} r={2.2} fill="#ffd479" />
        <rect x={1} y={-13} width={7} height={2} rx={1} fill={METAL.lit} />
      </g>
      <Mug x={half * 0.35} y={-top} color="#d8a2b4" />
      <Mug x={half * 0.6} y={-top} color={PLASTER.lit} />
    </Piece>
  );
});

export const Stool = memo(function Stool({ x, baseY }: { x: number; baseY: number }) {
  return (
    <Piece x={x} baseY={baseY}>
      <Contact x={0} y={0} rx={11} />
      <rect x={-1.6} y={-STOOL_H} width={3.2} height={STOOL_H} fill={METAL.face} />
      <rect x={-8} y={-3.5} width={16} height={2} rx={1} fill={METAL.dark} />
      <rect x={-10} y={-STOOL_H - 3} width={20} height={3.4} rx={1.7} fill={OAK.face} />
    </Piece>
  );
});

/** Three-seat sofa in off-white linen on an oak base. */
export const Sofa = memo(function Sofa({ x, baseY, w }: { x: number; baseY: number; w: number }) {
  const half = w / 2;
  return (
    <Piece x={x} baseY={baseY}>
      <Contact x={0} y={0} rx={half + 6} />
      <rect x={-half + 4} y={-SEAT_H - 26} width={w - 8} height={26} rx={5} fill={LINEN.dark} />
      <rect x={-half} y={-SEAT_H - 6} width={w} height={7} rx={3} fill={LINEN.face} />
      <rect x={-half} y={-SEAT_H - 6} width={w} height={2.4} rx={1.2} fill={LINEN.lit} />
      <rect x={-half - 3} y={-SEAT_H - 18} width={9} height={18} rx={4} fill={LINEN.face} />
      <rect x={half - 6} y={-SEAT_H - 18} width={9} height={18} rx={4} fill={LINEN.dark} />
      <rect x={-half + 6} y={-3.5} width={4} height={3.5} fill={OAK.deep} />
      <rect x={half - 10} y={-3.5} width={4} height={3.5} fill={OAK.deep} />
    </Piece>
  );
});

export const Armchair = memo(function Armchair({ x, baseY }: { x: number; baseY: number }) {
  return (
    <Piece x={x} baseY={baseY}>
      <Contact x={0} y={0} rx={20} />
      <rect x={-14} y={-SEAT_H - 24} width={28} height={24} rx={6} fill={MOSS.dark} />
      <rect x={-16} y={-SEAT_H - 6} width={32} height={7} rx={3} fill={MOSS.face} />
      <rect x={-16} y={-SEAT_H - 6} width={32} height={2.2} rx={1.1} fill={MOSS.lit} />
      <rect x={-18} y={-SEAT_H - 16} width={7} height={16} rx={3} fill={MOSS.face} />
      <rect x={13} y={-SEAT_H - 16} width={7} height={16} rx={3} fill={MOSS.dark} />
      <rect x={-12} y={-3.5} width={3} height={3.5} fill={OAK.deep} />
      <rect x={10} y={-3.5} width={3} height={3.5} fill={OAK.deep} />
    </Piece>
  );
});

export const CoffeeTable = memo(function CoffeeTable({ x, baseY }: { x: number; baseY: number }) {
  return (
    <Piece x={x} baseY={baseY}>
      <Contact x={0} y={0} rx={22} />
      <rect x={-20} y={-13} width={40} height={3.4} rx={1.6} fill={OAK.face} />
      <rect x={-20} y={-13} width={40} height={1.2} rx={0.6} fill={OAK.lit} />
      <rect x={-16} y={-9.6} width={2.6} height={9.6} fill={METAL.face} />
      <rect x={13.4} y={-9.6} width={2.6} height={9.6} fill={METAL.dark} />
      <rect x={-9} y={-16} width={14} height={3} rx={1} fill={PLASTER.deep} />
      <Mug x={11} y={-13} color={TERRA} />
    </Piece>
  );
});

/** Round canteen table; diners sit behind it. */
export const CanteenTable = memo(function CanteenTable({ x, baseY }: { x: number; baseY: number }) {
  return (
    <Piece x={x} baseY={baseY}>
      <Contact x={0} y={0} rx={38} />
      <rect x={-2.6} y={-DESK_TOP + 4} width={5.2} height={DESK_TOP - 4} fill={METAL.face} />
      <ellipse cx={0} cy={-1.5} rx={13} ry={2.4} fill={METAL.dark} />
      <ellipse cx={0} cy={-DESK_TOP} rx={40} ry={5.4} fill={OAK.dark} />
      <ellipse cx={0} cy={-DESK_TOP - 1.8} rx={40} ry={5.4} fill={OAK.face} />
      <ellipse cx={0} cy={-DESK_TOP - 2.6} rx={36} ry={4} fill={OAK.lit} opacity={0.45} />
      {[-18, 0, 18].map((off) => (
        <g key={off}>
          <ellipse cx={off} cy={-DESK_TOP - 3.4} rx={7} ry={2.4} fill={PLASTER.lit} />
          <ellipse cx={off} cy={-DESK_TOP - 4} rx={3.6} ry={1.3} fill={TERRA} opacity={0.65} />
        </g>
      ))}
    </Piece>
  );
});

/**
 * Slatted bench for the waiting strip. Walnut rather than oak on purpose: an
 * oak bench standing on an oak floor is invisible, and an empty waiting strip
 * then reads as bare floor instead of as somewhere to sit.
 */
export const Bench = memo(function Bench({ x, baseY, w }: { x: number; baseY: number; w: number }) {
  const half = w / 2;
  const backTop = -SEAT_H - 22;
  return (
    <Piece x={x} baseY={baseY}>
      <Contact x={0} y={0} rx={half + 4} />
      {[-half + 10, half - 14].map((lx) => (
        <g key={lx}>
          <rect x={lx} y={-SEAT_H + 2} width={4} height={SEAT_H - 2} fill={METAL.dark} />
          <rect x={lx + 0.4} y={backTop} width={3.2} height={SEAT_H + 22} fill={WALNUT.dark} />
        </g>
      ))}
      {[0, 1].map((i) => (
        <rect key={`b${i}`} x={-half + 6} y={backTop + i * 8} width={w - 12} height={4.4} rx={2.2} fill={i === 0 ? WALNUT.face : WALNUT.dark} />
      ))}
      <rect x={-half} y={-SEAT_H - 4} width={w} height={4.6} rx={2} fill={WALNUT.face} />
      <rect x={-half} y={-SEAT_H - 4} width={w} height={1.6} rx={0.8} fill={WALNUT.lit} />
      <rect x={-half} y={-SEAT_H + 1.4} width={w} height={2.6} rx={1.2} fill={WALNUT.deep} />
    </Piece>
  );
});

/** Potted plant. Three of the four leaf masses catch the light from the left. */
export const Plant = memo(function Plant({
  x,
  baseY,
  scale = 1,
}: {
  x: number;
  baseY: number;
  scale?: number;
}) {
  return (
    <Piece x={x} baseY={baseY} scale={scale}>
      <Contact x={0} y={0} rx={14} />
      <path d="M -8 -14 L 8 -14 L 6 0 L -6 0 Z" fill={TERRA} />
      <path d="M -8 -14 L -3 -14 L -4 0 L -6 0 Z" fill={shade(TERRA, 1.2)} />
      <rect x={-9} y={-16} width={18} height={2.6} rx={1.2} fill={shade(TERRA, 0.85)} />
      <g fill={MOSS.face}>
        <ellipse cx={-8} cy={-24} rx={7} ry={9} transform="rotate(-22 -8 -24)" />
        <ellipse cx={8} cy={-23} rx={6.5} ry={8.5} transform="rotate(20 8 -23)" fill={MOSS.dark} />
        <ellipse cx={-1} cy={-33} rx={7} ry={10} fill={MOSS.lit} />
        <ellipse cx={5} cy={-30} rx={5} ry={7} transform="rotate(14 5 -30)" />
      </g>
      <line x1={0} y1={-16} x2={0} y2={-28} stroke={MOSS.dark} strokeWidth={1.2} />
    </Piece>
  );
});

/** Flat wool rug lying on the floor, drawn in the room's perspective. */
export const Rug = memo(function Rug({
  box,
  from,
  to,
  near = 0.92,
  far = 0.28,
  fill,
}: {
  box: RoomBox;
  /** Horizontal span as a fraction of the room's width. */
  from: number;
  to: number;
  /** Depth band as a fraction of the floor, 0 at the back wall. */
  near?: number;
  far?: number;
  fill: string;
}) {
  const { x0, x1, xb0, xb1, horizonY, floorY } = box;
  const edge = (t: number, depth: number): [number, number] => {
    const left = xb0 + (x0 - xb0) * depth;
    const right = xb1 + (x1 - xb1) * depth;
    return [left + (right - left) * t, horizonY + (floorY - horizonY) * depth];
  };
  return (
    <polygon
      points={pts(edge(from, far), edge(to, far), edge(to, near), edge(from, near))}
      fill={fill}
      opacity={0.85}
    />
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
const HEAD_R = 11;
/** Height of a sprite's head top above its floor point, standing. */
export const STAND_TOP = 70;
/** The same, seated on a seat `seatH` high. */
export function sitTop(seatH: number): number {
  return seatH + 44;
}
/** Extra clearance the name label above the head adds on top of that. */
export const NAME_LIFT = 12;

/** Face drawn when an agent has no avatar of its own. */
function ProceduralFace({ cy, colors }: { cy: number; colors: SpriteColors }) {
  const r = HEAD_R;
  return (
    <g>
      <circle cy={cy} r={r} fill={colors.skin} />
      <path d={`M 0 ${cy - r} a ${r} ${r} 0 0 1 0 ${r * 2} z`} fill={shade(colors.skin, 0.92)} />
      <path
        d={`M ${-r} ${cy - 1.5} a ${r} ${r} 0 0 1 ${r * 2} 0 l 0 -2.4 a ${r} ${r * 0.62} 0 0 0 ${-r * 2} 0 z`}
        fill={colors.hair}
      />
      <path
        d={`M ${-r} ${cy - 1.5} a ${r} ${r} 0 0 1 ${r * 0.86} ${-r * 0.9} l 0 -2.4 a ${r} ${r * 0.62} 0 0 0 ${-r * 0.86} ${r * 0.9} z`}
        fill={shade(colors.hair, 1.18)}
      />
      <circle cx={-3.6} cy={cy + 1.4} r={1.15} fill="#2b3038" />
      <circle cx={3.6} cy={cy + 1.4} r={1.15} fill="#2b3038" />
      <path d={`M -2.6 ${cy + 5.2} q 2.6 2 5.2 0`} fill="none" stroke="#2b3038" strokeOpacity={0.5} strokeWidth={0.9} strokeLinecap="round" />
    </g>
  );
}

/**
 * The agent's own avatar, clipped into the head. Falls back to a drawn face
 * when the agent has no avatar or the image fails to load — the office should
 * never show a hole where a head goes.
 */
function AvatarHead({
  cy,
  colors,
  avatarUrl,
  clipId,
}: {
  cy: number;
  colors: SpriteColors;
  avatarUrl: string | null;
  clipId: string;
}) {
  const [broken, setBroken] = useState(false);
  const r = HEAD_R;
  useEffect(() => setBroken(false), [avatarUrl]);
  if (!avatarUrl || broken) return <ProceduralFace cy={cy} colors={colors} />;
  const inner = r - 1;
  return (
    <g>
      <circle cy={cy} r={r} fill={PLASTER.lit} />
      <clipPath id={clipId}>
        <circle cy={cy} r={inner} />
      </clipPath>
      <image
        href={avatarUrl}
        x={-inner}
        y={cy - inner}
        width={inner * 2}
        height={inner * 2}
        preserveAspectRatio="xMidYMid slice"
        clipPath={`url(#${clipId})`}
        onError={() => setBroken(true)}
      />
      {/* A rim keeps the avatar from dissolving into the wall behind it. */}
      <circle cy={cy} r={r - 0.5} fill="none" stroke={METAL.dark} strokeOpacity={0.35} strokeWidth={1.1} />
    </g>
  );
}

function Torso({ top, bottom, colors }: { top: number; bottom: number; colors: SpriteColors }) {
  const halfW = 11;
  const r = 6;
  return (
    <g>
      <rect x={-halfW} y={top} width={halfW * 2} height={bottom - top} rx={r} fill={colors.clothes} />
      <path
        d={`M 1.5 ${top} L ${halfW - r} ${top} a ${r} ${r} 0 0 1 ${r} ${r} L ${halfW} ${bottom - r} a ${r} ${r} 0 0 1 ${-r} ${r} L 1.5 ${bottom} Z`}
        fill={shade(colors.clothes, 0.84)}
      />
      <rect x={-halfW + 1.4} y={top + 4} width={3} height={bottom - top - 8} rx={1.5} fill={shade(colors.clothes, 1.2)} opacity={0.75} />
      {/* Collar */}
      <path d={`M -5 ${top + 1} q 5 5 10 0`} fill="none" stroke={shade(colors.clothes, 0.68)} strokeWidth={1.6} strokeLinecap="round" />
    </g>
  );
}

function Arms({ top, length, colors }: { top: number; length: number; colors: SpriteColors }) {
  return (
    <g>
      <rect x={-14.6} y={top} width={4} height={length} rx={2} fill={shade(colors.clothes, 1.1)} />
      <rect x={10.6} y={top} width={4} height={length} rx={2} fill={shade(colors.clothes, 0.8)} />
    </g>
  );
}

const TROUSER = "#3d4654";

export type Posture = "standing" | "sitting" | "walking";

export interface PersonProps {
  agentId: string;
  name: string;
  /** Trimmed name shown under the sprite, or null when the room labels it. */
  label: string | null;
  x: number;
  baseY: number;
  scale?: number;
  posture: Posture;
  /** Seat height for a sitting sprite: chair, stool or bench. */
  seatH?: number;
  colors: SpriteColors;
  avatarUrl: string | null;
  /** Walk-cycle frame; ignored unless walking. */
  frame?: 0 | 1;
  onClick?: () => void;
}

/**
 * One agent, facing the viewer. The avatar is the identity, so the head is
 * drawn last and never occluded; the name above it is a secondary cue, sits
 * clear of any furniture drawn in front of the body, and is trimmed to its
 * seat's slot by the caller.
 */
export const Person = memo(function Person({
  agentId,
  name,
  label,
  x,
  baseY,
  scale = 1,
  posture,
  seatH = SIT_ON.chair,
  colors,
  avatarUrl,
  frame = 0,
  onClick,
}: PersonProps) {
  const sitting = posture === "sitting";
  const walking = posture === "walking";
  const hip = sitting ? seatH : 26;
  const torsoTop = sitting ? -seatH - 22 : -48;
  const torsoBottom = sitting ? -seatH : -26;
  const headCy = sitting ? -seatH - 33 : -59;
  const swing = walking ? (frame === 0 ? 15 : -15) : 0;
  return (
    <g
      transform={`translate(${x} ${baseY}) scale(${scale})`}
      data-agent={agentId}
      className={onClick ? "cursor-pointer" : undefined}
      onClick={onClick}
    >
      <title>{name}</title>
      <Contact x={0} y={0} rx={15} ry={4} />
      {sitting ? (
        <g>
          {/* Thighs run toward the viewer, so they read as a short band. */}
          <rect x={-10.5} y={-hip} width={21} height={8} rx={3.4} fill={shade(TROUSER, 1.12)} />
          <rect x={-8.5} y={-hip + 5} width={6} height={hip - 4} rx={2.6} fill={TROUSER} />
          <rect x={2.5} y={-hip + 5} width={6} height={hip - 4} rx={2.6} fill={shade(TROUSER, 0.86)} />
          <ellipse cx={-5.5} cy={-0.8} rx={4.2} ry={2} fill={METAL.deep} />
          <ellipse cx={5.5} cy={-0.8} rx={4.2} ry={2} fill={METAL.dark} />
        </g>
      ) : (
        <g>
          {(
            [
              [-5.2, swing, shade(TROUSER, 1.12)],
              [5.2, -swing, TROUSER],
            ] as const
          ).map(([hx, angle, fill], i) => (
            <g key={i} transform={`rotate(${angle} ${hx} ${-hip})`}>
              <rect x={hx - 3.2} y={-hip} width={6.4} height={hip} rx={2.8} fill={fill} />
              <ellipse cx={hx} cy={-0.8} rx={4.4} ry={2} fill={i === 0 ? METAL.deep : METAL.dark} />
            </g>
          ))}
        </g>
      )}
      <Arms top={torsoTop + 4} length={torsoBottom - torsoTop - 6} colors={colors} />
      <Torso top={torsoTop} bottom={torsoBottom} colors={colors} />
      <rect x={-3.4} y={torsoTop - 4} width={6.8} height={5} rx={2} fill={shade(colors.skin, 0.86)} />
      <AvatarHead cy={headCy} colors={colors} avatarUrl={avatarUrl} clipId={`office-av-${agentId}`} />
      {label ? (
        <text
          y={-(sitting ? sitTop(seatH) : STAND_TOP) - 5}
          textAnchor="middle"
          fontSize={8.5}
          fontWeight={700}
          fill={METAL.deep}
          stroke={PLASTER.lit}
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

/** Where a walker paces: a horizontal run at a fixed depth in its room. */
export interface WalkRoute {
  x0: number;
  x1: number;
  baseY: number;
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
 * A self-animated walker pacing its room. Owns its own ticker (120ms steps,
 * the two-frame leg cadence) so only this subtree re-renders while strolling;
 * honours prefers-reduced-motion by standing still at the start of its run.
 */
export function Walker(props: Omit<PersonProps, "x" | "baseY" | "posture" | "frame"> & { route: WalkRoute }) {
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
      baseY={route.baseY}
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
