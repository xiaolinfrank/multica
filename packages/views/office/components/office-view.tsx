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
export const SCENE_H = 840;

/** Screen units risen per unit of height, and the sideways lean with it. */
export const LIFT = 0.62;
export const LEAN = 0.16;
/** The same lean as an angle, for surfaces that carry upright content. */
const LEAN_DEG = 9.09;

/** Height of the north wall. Tall enough to carry the office's big screen. */
export const WALL_H = 190;

/** The interior floor, in world units on the z = 0 plane. The plate carries
 * an east strip beyond the canteen: the project office up north and the gym
 * down south.
 *
 * The room is deep rather than wide on purpose. A shallow plate gave the scene
 * a 20:11 aspect that no page column ever matches, so a third of the page sat
 * empty under it; at this depth the plate is close enough to the shape of the
 * space it is given that the fit leaves no visible band, and every zone gets a
 * real aisle between it and its neighbour to print its caption in. */
export const FLOOR = { x0: 22, x1: 1160, y0: 124, y1: 826 } as const;

/** Projects a world point to scene coordinates. */
export function px(x: number, z = 0): number {
  return x + z * LEAN;
}
export function py(y: number, z = 0): number {
  return y - z * LIFT;
}

// --- Palette ---------------------------------------------------------------

// Every colour in the scene is a CSS custom property from packages/ui/styles/
// tokens.css, so the same geometry paints a daylit studio under `:root` and a
// night office under `.dark`. Nothing here is a literal: a hex committed in
// this file would be the one surface that ignores the theme.
//
// The palette steps by PLANE rather than by material, because when almost
// every surface is a neutral, hue stops doing any work and value has to carry
// the whole drawing: the wall is the brightest thing in the room, furniture
// tops come next, the floor sits below both, and every front and side face
// drops two clear steps further. That ordering is what still reads as a solid
// standing on a floor once the colour has been taken away. One light, from
// the north-west, in both themes — so the west edge of anything is the bright
// one, and the east face is always the darkest of the three.

/** Four-step value ramp: top face, south face, east face, deepest edge. */
interface Ramp {
  lit: string;
  face: string;
  dark: string;
  deep: string;
}

const ramp = (name: string): Ramp => ({
  lit: `var(--office-${name}-lit)`,
  face: `var(--office-${name}-face)`,
  dark: `var(--office-${name}-dark)`,
  deep: `var(--office-${name}-deep)`,
});

/** Plaster, paint and white joinery — what most of this office is made of. */
const SHELL = ramp("shell");
/** Pale oak: worktops, the meeting table, the canteen and the bench. */
const OAK = ramp("wood");
/** Charcoal. Screens, chair columns, bezels — the only dark in the room. */
const METAL = ramp("metal");
/** Task-chair mesh. Mid grey, so a chair never melts into the floor. */
const FABRIC = ramp("fabric");
/** Soft seating in bouclé, shaded hard enough to keep its shape. */
const UPHOLSTERY = ramp("soft");
/** Planting, and the greener of the two soft-seating fabrics. */
const MOSS = ramp("moss");
/** The single warm accent: mugs, lanyards, kanban cards. */
const TERRA = "var(--office-accent)";
const TERRA_DEEP = "var(--office-accent-deep)";
const SCREEN_OFF = "var(--office-screen-off)";
/** A powered panel seen from above: laptop lids, the treadmill console. */
const SCREEN_LIVE = "var(--office-screen-live)";
/** Second accent, for the things one terracotta cannot carry alone. */
const TERRA_2 = "var(--office-accent-2)";
/** Specular sheen across glass and screens — white in either theme. */
const SHEEN = "var(--office-sheen)";
/** Ink and its halo for anything printed into the scene. The halo is always
 * the far end of the value range from the ink, so a name stays readable over
 * whatever it happens to float across. */
const INK = "var(--office-ink)";
const INK_HUMAN = "var(--office-ink-human)";
const HALO = "var(--office-halo)";
/** Warm filament: the pendant bulbs and the coffee machine's ready light. */
const BULB = "var(--office-bulb)";
/** Contact shadow, alpha included — see the token for why. */
const SHADOW = "var(--office-shadow)";
/** Catch-light and crease, laid over whatever material a solid is made of. */
const EDGE_LIGHT = "var(--office-edge-light)";
const EDGE_SHADE = "var(--office-edge-shade)";
/** Silhouette rim for the figures. Identity colours cannot follow the theme,
 * so a figure is separated from the floor by a drawn edge instead of a tint. */
const FIGURE_RIM = "var(--office-figure-rim)";

/**
 * Carpet per zone. Every tint is a step off the tile it sits on, each takes a
 * different hue so eight pale fields stay tellable apart, and the spread from
 * the darkest to the lightest is wide enough to survive greyscale — hue alone
 * is not a distinction everyone can use.
 */
export const ZONE_FLOOR: Record<string, string> = {
  desk: "var(--office-zone-desk)",
  meeting: "var(--office-zone-meeting)",
  pmo: "var(--office-zone-pmo)",
  tea: "var(--office-zone-tea)",
  lounge: "var(--office-zone-lounge)",
  canteen: "var(--office-zone-canteen)",
  waiting: "var(--office-zone-waiting)",
  gym: "var(--office-zone-gym)",
};

/**
 * Multiplies a hex colour toward black (k < 1) or white (k > 1). Each agent
 * owns one identity colour; its lit and shaded sides are derived from that, so
 * a sprite gains volume without needing a palette entry per body part. Only
 * identity colours reach this — they are real hex values chosen per agent, not
 * theme tokens, and they are the one thing in the scene that must not change
 * between light and dark.
 */
export function shade(hex: string, k: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) =>
    Math.max(0, Math.min(255, Math.round(k <= 1 ? c * k : c + (255 - c) * (k - 1)))),
  );
  return `#${channels.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * What {@link shade} does to a colour this file cannot read: a var() has no
 * value until the browser resolves it, so the darkening has to happen in CSS.
 * `pct` is the share of the original colour kept, mirroring shade()'s k * 100.
 */
const darken = (c: string, pct: number): string => `color-mix(in srgb, ${c} ${pct}%, black)`;

/** Gradients and filters shared by the whole scene; mounted once. */
export function SceneDefs() {
  return (
    <defs>
      {/* Large-format pale tile, falling off away from the north glazing. */}
      <linearGradient id="office-floor" x1="0" y1="0" x2="0.2" y2="1">
        <stop offset="0%" stopColor="var(--office-floor-lit)" />
        <stop offset="100%" stopColor="var(--office-floor-deep)" />
      </linearGradient>
      <linearGradient id="office-wall" x1="0" y1="0" x2="1" y2="0.25">
        <stop offset="0%" stopColor={SHELL.lit} />
        <stop offset="100%" stopColor={SHELL.face} />
      </linearGradient>
      <linearGradient id="office-glass" x1="0" y1="0" x2="0.4" y2="1">
        <stop offset="0%" stopColor="var(--office-glass-lit)" />
        <stop offset="100%" stopColor="var(--office-glass-deep)" />
      </linearGradient>
      <linearGradient id="office-screen" x1="0" y1="0" x2="0.35" y2="1">
        <stop offset="0%" stopColor="var(--office-screen-lit)" />
        <stop offset="100%" stopColor="var(--office-screen-deep)" />
      </linearGradient>
      {/* The spill a live monitor throws onto its desktop, and the pool a
          pendant throws on the floor. Both carry their alpha in the token so
          the night scene can make the lamps the brightest thing in the room
          without the daylit one glowing like a nightclub. */}
      <radialGradient id="office-glow">
        <stop offset="0%" stopColor="var(--office-glow)" />
        <stop offset="100%" stopColor="var(--office-glow)" stopOpacity="0" />
      </radialGradient>
      {/* Colour-agnostic barrel shading, laid over whatever a cylinder is
          made of: a catch-light down the west side, a crease down the east.
          One gradient serves every Cyl because it only adds light and shade,
          never hue. */}
      <linearGradient id="office-cyl" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stopColor={EDGE_LIGHT} />
        <stop offset="42%" stopColor={EDGE_LIGHT} stopOpacity="0" />
        <stop offset="60%" stopColor={EDGE_SHADE} stopOpacity="0" />
        <stop offset="100%" stopColor={EDGE_SHADE} />
      </linearGradient>
      <radialGradient id="office-lamp">
        <stop offset="0%" stopColor="var(--office-lamp)" />
        <stop offset="100%" stopColor="var(--office-lamp)" stopOpacity="0" />
      </radialGradient>
    </defs>
  );
}

// --- Solids ----------------------------------------------------------------

const pts = (...points: Array<[number, number]>) =>
  points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");

/**
 * The contact shadow that seats a solid on the floor. Drawn on the footprint
 * itself and thrown south-east, opposite the one north-west light every solid
 * in this scene is lit by — a shadow that spread evenly, or fell toward the
 * light, is what made the old props read as floating over the boards.
 * Strength lives in the token, because the same 13% grey that seats a desk on
 * white tile is invisible on the night floor.
 */
function Shadow({ x, y, w, d, h }: { x: number; y: number; w: number; d: number; h: number }) {
  const s = Math.min(7, 2.2 + h * 0.07);
  return (
    <rect
      x={x + s * 0.45}
      y={y + d - s * 0.45}
      width={w + s * 0.5}
      height={s * 1.7}
      rx={s}
      fill={SHADOW}
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
  const f = front ?? darken(top, 82);
  const s = side ?? darken(top, 68);
  // A chamfer is what separates a solid from a coloured rectangle, but on a
  // chair back twenty units wide the two hairlines are all you see, so only
  // props big enough to carry them get them.
  const chamfered = w >= 26 && d >= 12 && h >= 8;
  const r = Math.min(radius, 3);
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
      {chamfered ? (
        <g pointerEvents="none">
          {/* Catch-light along the north and west edges — the two the light
              actually reaches — then the bright turn where the top face rolls
              over into the front. */}
          <path
            d={`M ${x + dx + 0.9} ${y - dy + d - r} L ${x + dx + 0.9} ${y - dy + r} L ${x + dx + r} ${y - dy + 0.9} L ${x + dx + w - r} ${y - dy + 0.9}`}
            fill="none"
            stroke={EDGE_LIGHT}
            strokeWidth={1.1}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <line
            x1={x + dx + r}
            y1={y + d - dy + 0.5}
            x2={x + w + dx - r}
            y2={y + d - dy + 0.5}
            stroke={EDGE_LIGHT}
            strokeWidth={1}
            strokeLinecap="round"
          />
        </g>
      ) : null}
      {children ? <g transform={`translate(${dx} ${-dy})`}>{children}</g> : null}
    </g>
  );
});

/**
 * A cylinder — round tables, stools, pedestals, planters.
 *
 * The top defaults to a true circle, and callers should leave it that way.
 * The projection is a pure shear in z: `(x + z·LEAN, y − z·LIFT)` is the
 * identity inside any constant-z plane, so a horizontal disc at any height
 * projects to a circle, never to an ellipse. `ry` exists only for the rare
 * piece that is genuinely oval in plan.
 */
export const Cyl = memo(function Cyl({
  cx,
  cy,
  r,
  h,
  top,
  side,
  ry = r,
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
  const s = side ?? darken(top, 74);
  const barrel = `M ${cx - r} ${cy} A ${r} ${ry} 0 0 0 ${cx + r} ${cy} L ${cx + r + dx} ${cy - dy} A ${r} ${ry} 0 0 1 ${cx - r + dx} ${cy - dy} Z`;
  return (
    <g>
      {/* The contact blob keeps its squash: it is a soft shadow, not a
          projected disc. */}
      <ellipse cx={cx + r * 0.2} cy={cy + ry * 0.55} rx={r * 1.02} ry={ry * 0.5} fill={SHADOW} />
      <path d={barrel} fill={s} />
      {/* A flat-filled barrel reads as a card standing on edge. The shared
          gradient rounds it without knowing what it is made of. */}
      <path d={barrel} fill="url(#office-cyl)" />
      <ellipse cx={cx + dx} cy={cy - dy} rx={r} ry={ry} fill={top} />
      <path
        d={`M ${cx + dx - r * 0.95} ${cy - dy - ry * 0.22} A ${r} ${ry} 0 0 1 ${cx + dx + r * 0.1} ${cy - dy - ry * 0.96}`}
        fill="none"
        stroke={EDGE_LIGHT}
        strokeWidth={1.1}
        strokeLinecap="round"
      />
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
        <line key={`r${y}`} x1={x0} y1={y} x2={x1} y2={y} stroke="var(--office-grout)" strokeOpacity={0.5} strokeWidth={0.9} />
      ))}
      {cols.map((x) => (
        <line key={`c${x}`} x1={x} y1={y0} x2={x} y2={y1} stroke="var(--office-grout)" strokeOpacity={0.42} strokeWidth={0.9} />
      ))}
      {/* Daylight pooling in from the north glazing — moonlight after dark,
          which is why the strength travels with the colour. */}
      <rect x={x0} y={y0} width={x1 - x0} height={130} fill="var(--office-daylight)" />
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
        <rect x={slatFrom} y={0} width={slatTo - slatFrom} height={WALL_H} fill={SHELL.face} />
        {slats.map((x) => (
          <rect key={x} x={x} y={0} width={6.5} height={WALL_H} fill={SHELL.lit} />
        ))}
        <rect x={x0} y={0} width={x1 - x0} height={18} fill={SHELL.face} />
        <rect x={x0} y={18} width={x1 - x0} height={2.5} fill={SHELL.deep} />
      </WallPlane>
      {/* Cap: the wall's own top surface. It faces straight up, so it is the
          best-lit plane in the room and cannot be the darkest paint in the
          ramp — that read as a black line ruled across the top of the wall. */}
      <polygon
        points={pts(
          [px(x0, WALL_H), py(FLOOR.y0, WALL_H)],
          [px(x1, WALL_H), py(FLOOR.y0, WALL_H)],
          [px(x1, WALL_H) - 12, py(FLOOR.y0, WALL_H) - 7],
          [px(x0, WALL_H) - 12, py(FLOOR.y0, WALL_H) - 7],
        )}
        fill={SHELL.face}
      />
      {/* Skirting where the wall meets the boards. */}
      <rect x={x0} y={FLOOR.y0 - 4} width={x1 - x0} height={4} fill={SHELL.deep} />
    </g>
  );
});

/** Thin returns closing the floor off on the other three sides. */
export const FloorEdges = memo(function FloorEdges() {
  const { x0, x1, y0, y1 } = FLOOR;
  return (
    <g>
      {/* West catches the light, east is turned away from it — the same rule
          every solid in the scene follows. They used to be the other way
          round, which lit the room from both sides at once. */}
      <rect x={x0 - 8} y={y0 - 4} width={8} height={y1 - y0 + 12} fill={SHELL.dark} />
      <rect x={x1} y={y0 - 4} width={8} height={y1 - y0 + 12} fill={SHELL.deep} />
      <rect x={x0 - 8} y={y1} width={x1 - x0 + 16} height={8} fill={SHELL.dark} />
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
      <path d={`M 0 ${-h} L ${w * 0.42} ${-h} L ${w * 0.16} 0 L 0 0 Z`} fill={SHEEN} />
      {children}
      <rect x={0} y={-h} width={w} height={h} rx={3} fill="none" stroke="var(--office-screen-edge)" strokeWidth={1} />
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
            stroke="var(--office-glass-frame)"
            strokeWidth={1.5}
            strokeOpacity={0.7}
          />
        );
      })}
      <rect x={x + dx} y={y - dy} width={w} height={d} rx={1.5} fill="var(--office-glass-rail)" />
      <rect x={x + dx} y={y - dy} width={w} height={d} rx={1.5} fill="none" stroke="var(--office-glass-frame)" strokeWidth={0.8} />
      <rect x={x} y={y} width={w} height={d} rx={1.5} fill="var(--office-glass-frame)" opacity={0.45} />
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
 *
 * A desk nobody owns is drawn as a desk nobody owns: the worktop drops a step
 * out of the light, the mug goes away and the nameplate with it. Eight
 * identical bright slabs, six of them empty, is what made a quiet office read
 * as an empty warehouse.
 */
export const Desk = memo(function Desk({
  x,
  y,
  w,
  d,
  busy,
  name,
  occupied,
}: {
  x: number;
  y: number;
  w: number;
  d: number;
  busy: boolean;
  /** Nameplate text, already trimmed to the desktop by the caller. */
  name: string | null;
  /** Somebody is sitting here right now — not merely assigned the desk. */
  occupied: boolean;
}) {
  const vacant = name === null;
  const cx = x + w * 0.5;
  return (
    <Box
      x={x}
      y={y}
      w={w}
      d={d}
      h={DESK_H}
      top={vacant ? SHELL.face : SHELL.lit}
      front={vacant ? SHELL.deep : SHELL.dark}
      side={SHELL.deep}
      radius={2}
    >
      {busy ? <ellipse cx={cx} cy={y + 17} rx={w * 0.3} ry={7} fill="url(#office-glow)" /> : null}
      {/* Monitor. Box children are lifted onto the top face, so these are real
          solids standing on the worktop rather than ink painted across it —
          the stand and the panel each cast their own shadow, which is what
          stops eight desks reading as eight identical white benches.
          Its occupant sits north of the desk, so what faces the camera is the
          back of the panel; "live" is the light it leaks along the bezel and
          throws onto the worktop, not a screen we could not actually see. */}
      <Box x={cx - 4} y={y + 9} w={8} d={5} h={5} top={METAL.face} front={METAL.dark} side={METAL.deep} radius={1} shadow={false} />
      <Box
        x={cx - 15}
        y={y + 6}
        w={30}
        d={4}
        h={12}
        top={METAL.face}
        front={METAL.dark}
        side={METAL.deep}
        radius={1.2}
        shadow={false}
      />
      <rect
        x={px(cx - 14, DESK_H + 12)}
        y={py(y + 6.4, DESK_H + 12)}
        width={28}
        height={1.6}
        rx={0.8}
        fill={busy ? SCREEN_LIVE : SCREEN_OFF}
      />
      {/* Keyboard and mug belong to whoever is sitting here; an empty desk is
          a cleared desk. */}
      {occupied ? (
        <>
          <Box x={cx - 16} y={y + d - 20} w={32} d={10} h={2.5} top={SHELL.dark} front={SHELL.deep} side={SHELL.deep} radius={1.2} shadow={false} />
          <Cyl cx={x + w - 14} cy={y + d - 14} r={4.6} h={7} top={darken(TERRA, 84)} side={TERRA} />
        </>
      ) : null}
      {name ? (
        <>
          <rect
            x={x + 6}
            y={y + d - 11}
            width={w - 12}
            height={9}
            rx={2}
            fill="var(--office-plate)"
            stroke="var(--office-plate-line)"
            strokeWidth={0.7}
          />
          <text x={cx} y={y + d - 4} textAnchor="middle" fontSize={7} fontWeight={700} fill={INK}>
            {name}
          </text>
        </>
      ) : null}
    </Box>
  );
});

/** Angles of the five castor spokes, measured clockwise from due east. */
const CASTORS = [198, 252, 306, 18, 90] as const;

/**
 * Task chair, seen from above: a five-star base on castors, two armrests, a
 * seat pad, and a back panel deliberately narrower than the pad. A back as
 * wide and tall as the seat reads as a headstone at this angle, not a chair.
 *
 * The base is five real spokes rather than one stroked path: a wireframe
 * standing among solids is the single loudest thing in an otherwise shaded
 * room. The star is a true circle because the floor plane is undistorted.
 */
export const TaskChair = memo(function TaskChair({
  x,
  y,
  tucked = false,
}: {
  x: number;
  y: number;
  /** Pushed in under the worktop, the way an unclaimed chair is left. */
  tucked?: boolean;
}) {
  const cy = tucked ? y + 8 : y;
  return (
    <g>
      <ellipse cx={x} cy={cy + 8} rx={13} ry={5} fill={SHADOW} />
      {CASTORS.map((a) => {
        const rad = (a * Math.PI) / 180;
        const ex = x + 10 * Math.cos(rad);
        const ey = cy + 6 + 10 * Math.sin(rad);
        return (
          <g key={a}>
            <line x1={x} y1={cy + 6} x2={ex} y2={ey} stroke={METAL.dark} strokeWidth={2.6} strokeLinecap="round" />
            <circle cx={ex} cy={ey} r={1.9} fill={METAL.deep} />
          </g>
        );
      })}
      <Cyl cx={x} cy={cy + 6} r={3} h={SEAT_H - 4} top={METAL.lit} side={METAL.face} />
      <Box x={x - 11.5} y={cy + 1} w={3} d={11} h={SEAT_H + 6} top={METAL.face} front={METAL.dark} side={METAL.deep} radius={1.5} shadow={false} />
      <Box x={x + 8.5} y={cy + 1} w={3} d={11} h={SEAT_H + 6} top={METAL.face} front={METAL.dark} side={METAL.deep} radius={1.5} shadow={false} />
      <Box x={x - 10} y={cy - 3} w={20} d={17} h={SEAT_H} top={FABRIC.face} front={FABRIC.dark} side={FABRIC.deep} radius={5} shadow={false} />
      {/* The back is the tallest part of a chair and the first thing to clutter
          a room. Six empty desks each showing a full-height back read as six
          headstones, so a tucked chair keeps only a low headrest. */}
      <Box
        x={x - 9}
        y={cy - 9}
        w={18}
        d={6}
        h={SEAT_H + (tucked ? 7 : 19)}
        top={FABRIC.lit}
        front={FABRIC.face}
        side={FABRIC.deep}
        radius={3.5}
        shadow={false}
      />
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
      <ellipse cx={x} cy={y + 7} rx={10} ry={4} fill={SHADOW} />
      {/* Four legs, drawn before the seat so the pad sits on top of them. */}
      {[-7.5, 7.5].flatMap((dx) =>
        [-1, 11].map((dy) => (
          <Box
            key={`${dx}:${dy}`}
            x={x + dx - 1.4}
            y={y + dy}
            w={2.8}
            d={2.8}
            h={SEAT_H - 3}
            top={OAK.dark}
            front={OAK.deep}
            side={OAK.deep}
            radius={1.2}
            shadow={false}
          />
        )),
      )}
      <Box x={x - 9.5} y={y - 3} w={19} d={16} h={SEAT_H} top={OAK.face} front={OAK.dark} side={OAK.deep} radius={3} shadow={false} />
      <Box x={x - 8} y={y - 8} w={16} d={4.5} h={SEAT_H + 15} top={OAK.lit} front={OAK.face} side={OAK.dark} radius={2.5} shadow={false} />
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
    <Box x={x} y={y} w={w} d={d} h={34} top={OAK.lit} front={SHELL.dark} side={SHELL.deep} radius={2}>
      <rect x={x + 14} y={y + 5} width={26} height={22} rx={3} fill={METAL.face} />
      <rect x={x + 17} y={y + 8} width={20} height={7} rx={2} fill={METAL.lit} />
      <circle cx={x + 27} cy={y + 22} r={2.6} fill={BULB} />
      {[0.42, 0.52, 0.62].map((t, i) => (
        <g key={t}>
          <circle cx={x + w * t} cy={y + d * 0.5} r={5} fill={i === 1 ? SHELL.lit : TERRA_2} stroke={SHELL.deep} strokeWidth={0.7} />
          <circle cx={x + w * t} cy={y + d * 0.5} r={3} fill={darken(i === 1 ? SHELL.lit : TERRA_2, 86)} />
        </g>
      ))}
      <rect x={x + w - 46} y={y + 8} width={30} height={14} rx={2} fill={MOSS.face} />
      <rect x={x + w - 42} y={y + 11} width={22} height={8} rx={1.5} fill={MOSS.lit} />
    </Box>
  );
});


/**
 * The project office's kanban board: a standing whiteboard on castored legs,
 * with three columns of cards. It carries no lettering — the board's face is
 * a vertical plane, and this projection leaves only horizontal surfaces
 * undistorted, so the squad's name is printed in the zone caption instead of
 * being squashed to 62% across the board.
 */
export const KanbanBoard = memo(function KanbanBoard({
  x,
  y,
  w,
  h = 58,
  base = 18,
}: {
  /** World x of the board's left edge and the floor line it stands on. */
  x: number;
  y: number;
  w: number;
  /** Panel height, and how high off the floor its bottom edge sits. */
  h?: number;
  base?: number;
}) {
  const top = base + h;
  /** A point on the board's face: `u` along it, `z` above the floor. */
  const p = (u: number, z: number): [number, number] => [px(x + u, z), py(y, z)];
  const quad = (u0: number, u1: number, z0: number, z1: number) =>
    pts(p(u0, z0), p(u1, z0), p(u1, z1), p(u0, z1));
  // Three columns of cards, thinning left to right: the backlog is always
  // fuller than the done column, and that gradient is what makes the board
  // read as a board rather than as decorative confetti.
  const columns = [3, 2, 1];
  const colW = (w - 16) / 3;
  return (
    <g>
      <ellipse cx={x + w / 2} cy={y + 2} rx={w * 0.44} ry={5} fill={SHADOW} />
      {[9, w - 9].map((u) => (
        <polygon key={u} points={quad(u - 2, u + 2, 0, base + 6)} fill={METAL.dark} />
      ))}
      <polygon points={quad(0, w, base, top)} fill={SHELL.lit} stroke={METAL.dark} strokeWidth={1.2} />
      {/* Marker tray along the bottom rail. */}
      <polygon points={quad(6, w - 6, base - 3, base + 1)} fill={METAL.face} />
      {columns.map((count, c) => {
        const u0 = 8 + c * colW;
        return (
          <g key={c}>
            <polygon points={quad(u0, u0 + colW - 6, top - 8, top - 3)} fill={METAL.lit} opacity={0.8} />
            {Array.from({ length: count }, (_, r) => (
              <polygon
                key={r}
                points={quad(u0 + 3, u0 + colW - 11, top - 16 - r * 12, top - 24 - r * 12)}
                fill={[TERRA, BULB, MOSS.lit][(c + r) % 3]}
                opacity={0.9}
              />
            ))}
          </g>
        );
      })}
    </g>
  );
});

/** Long meeting table with laptops laid out along it. */
export const MeetingTable = memo(function MeetingTable({
  x,
  y,
  w,
  d,
  seats = 3,
}: {
  x: number;
  y: number;
  w: number;
  d: number;
  /** Places per side. The laptops land on the seats, so this has to match the
   * seat table the floor lays out around the same rectangle. */
  seats?: number;
}) {
  return (
    <Box x={x} y={y} w={w} d={d} h={DESK_H} top={OAK.lit} front={OAK.face} side={OAK.dark} radius={4}>
      {Array.from({ length: seats }, (_, i) => (i + 0.5) / seats).map((t) => (
        <g key={t}>
          <rect x={x + w * t - 13} y={y + 8} width={26} height={13} rx={1.6} fill={METAL.face} />
          <rect x={x + w * t - 11} y={y + 10} width={22} height={9} rx={1} fill={SCREEN_LIVE} opacity={0.6} />
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
      <Box x={x} y={y} w={w} d={d} h={24} top={MOSS.face} front={MOSS.dark} side={MOSS.deep} radius={7} />
      <Box x={x} y={y - 6} w={w} d={11} h={44} top={MOSS.lit} front={MOSS.face} side={MOSS.dark} radius={5} shadow={false} />
      <Box x={x - 6} y={y - 2} w={11} d={d + 2} h={34} top={MOSS.lit} front={MOSS.face} side={MOSS.dark} radius={4} shadow={false} />
      <Box x={x + w - 5} y={y - 2} w={11} d={d + 2} h={34} top={MOSS.lit} front={MOSS.face} side={MOSS.dark} radius={4} shadow={false} />
    </g>
  );
});

export const CoffeeTable = memo(function CoffeeTable({ x, y, w, d }: { x: number; y: number; w: number; d: number }) {
  return (
    <Box x={x} y={y} w={w} d={d} h={14} top={OAK.face} front={OAK.dark} side={OAK.deep} radius={4}>
      <rect x={x + 12} y={y + 10} width={30} height={20} rx={2} fill={SHELL.lit} stroke={SHELL.deep} strokeWidth={0.8} />
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
      <Cyl cx={cx} cy={cy} r={12} h={DESK_H - 3} top={METAL.face} side={METAL.dark} />
      <circle cx={cx + dx} cy={cy - dy} r={r} fill={OAK.lit} />
      <circle cx={cx + dx} cy={cy - dy} r={r} fill="none" stroke={OAK.dark} strokeWidth={2} />
      {[-1, 0, 1].map((k) => (
        <g key={k} transform={`translate(${cx + dx + k * r * 0.5} ${cy - dy + (k === 0 ? -r * 0.34 : r * 0.3)})`}>
          <circle r={9} fill={SHELL.lit} stroke={SHELL.deep} strokeWidth={0.8} />
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
      <Box x={x + 3} y={y - 9} w={28} d={10} h={31} top={METAL.dark} front={METAL.deep} side={METAL.deep} radius={2} />
      <rect x={x + 9} y={y - 7.4} width={16} height={6} rx={1.5} fill={SCREEN_LIVE} opacity={0.85} />
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
      <Cyl cx={x + 13} cy={y + 8} r={2.2} h={barZ} top={METAL.face} side={METAL.dark} />
      <Cyl cx={x + 43} cy={y + 8} r={2.2} h={barZ} top={METAL.face} side={METAL.dark} />
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
      <rect x={x + w * 0.26} y={y + d * 0.28} width={26} height={17} rx={2} fill={SHELL.lit} stroke={SHELL.deep} strokeWidth={0.8} />
      <line x1={x + w * 0.26 + 4} y1={y + d * 0.28 + 5} x2={x + w * 0.26 + 22} y2={y + d * 0.28 + 5} stroke={SHELL.deep} strokeWidth={0.9} />
      <line x1={x + w * 0.26 + 4} y1={y + d * 0.28 + 9} x2={x + w * 0.26 + 22} y2={y + d * 0.28 + 9} stroke={SHELL.deep} strokeWidth={0.9} />
      <circle cx={x + w * 0.64} cy={y + d * 0.52} r={4.2} fill={TERRA} />
      <circle cx={x + w * 0.64} cy={y + d * 0.52} r={2.6} fill={TERRA_DEEP} />
      <rect x={x + w - 24} y={y + 6} width={16} height={5} rx={2} fill={MOSS.face} />
    </Box>
  );
});

/** Potted plant, seen from above: a canopy of leaf discs over a pot. */
export const Plant = memo(function Plant({ x, y, scale = 1 }: { x: number; y: number; scale?: number }) {
  const r = 13 * scale;
  return (
    <g>
      <Cyl cx={x} cy={y} r={r * 0.68} h={20 * scale} top={SHELL.face} side={SHELL.deep} />
      {/* Two tiers: one flat ring of equal discs is a broccoli head, two with
          a value step between them is a plant. */}
      <g transform={`translate(${px(x, 22 * scale)} ${py(y, 22 * scale)})`}>
        <circle cx={-r * 0.72} cy={r * 0.42} r={r * 0.56} fill={MOSS.deep} />
        <circle cx={r * 0.78} cy={r * 0.5} r={r * 0.52} fill={MOSS.deep} />
        <circle cx={r * 0.1} cy={r * 0.62} r={r * 0.6} fill={MOSS.dark} />
      </g>
      <g transform={`translate(${px(x, 34 * scale)} ${py(y, 34 * scale)})`}>
        <circle cx={-r * 0.5} cy={r * 0.2} r={r * 0.66} fill={MOSS.face} />
        <circle cx={r * 0.55} cy={r * 0.3} r={r * 0.6} fill={MOSS.dark} />
        <circle cx={0} cy={-r * 0.45} r={r * 0.72} fill={MOSS.lit} />
        <circle cx={r * 0.3} cy={-r * 0.1} r={r * 0.44} fill={MOSS.face} />
        <circle cx={0} cy={-r * 0.45} r={r * 0.72} fill="none" stroke={EDGE_LIGHT} strokeWidth={0.9} />
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
      <rect x={x} y={y} width={w} height={d} rx={radius} fill="none" stroke={darken(fill, 88)} strokeWidth={1.2} />
    </g>
  );
});

/** Ceiling pendant seen from below: the fitting plus the pool it throws. */
export const Pendant = memo(function Pendant({ x, y, r = 30 }: { x: number; y: number; r?: number }) {
  return (
    <g pointerEvents="none">
      <circle cx={x} cy={y} r={r} fill="url(#office-lamp)" />
      <circle cx={x} cy={y} r={5.5} fill={BULB} />
      <circle cx={x} cy={y} r={5.5} fill="none" stroke={METAL.face} strokeWidth={1.4} />
    </g>
  );
});

// --- People ----------------------------------------------------------------

/**
 * Illustration-only identity palettes; picked deterministically per agent or
 * member. These are the one set of colours that must NOT follow the theme —
 * an agent's colour is its identity — so they stay hex and go through
 * {@link shade}, never through the `--office-*` tokens.
 *
 * The wheel is split in half: agents take the cool side, members the warm
 * side, so no colour ever appears in both casts and the two drawing languages
 * are backed up by two colour families.
 */
export const CLOTHES = ["#4f6fb8", "#4c8f9c", "#6a6ab5", "#3f88a8", "#5b8f74", "#7a6cc0"] as const;
export const MEMBER_CLOTHES = ["#c4703f", "#b8564f", "#c08a3a", "#a85a7a", "#8a7a3a"] as const;
export const SKINS = ["#f0c8a2", "#dda577", "#a8764f", "#87593a"] as const;
/** Raised off the night floor's own value; the rim stroke does the rest. */
export const HAIRS = ["#4a3b2c", "#7a5734", "#454b57", "#c9bdaa"] as const;

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
/** Height of the head's centre above the floor, standing and seated. */
export const HEAD_Z = 64;
export const SIT_HEAD_Z = 50;
/** Screen clearance above a sprite's floor point: head top plus its label. */
export const NAME_LIFT = 13;
/**
 * Room a badge pill takes above the head, measured from the head's top edge to
 * the pill's own top plus a hair of margin. A badge sits above the name label,
 * so it is the tallest ink a sprite can draw and it — not the label — is what
 * the bubble layer has to clear.
 *
 * It also has to clear the name label directly under it: the label's haloed
 * ascender reaches `HEAD_R + 5 + NAME_FONT + halo/2` above the head centre,
 * and the pill's bottom edge is at `HEAD_R + BADGE_LIFT - 15`. At 29 the two
 * touched. office-view.test.ts pins the inequality.
 */
export const BADGE_LIFT = 33;
export function headClearance(headZ: number, labelled: boolean, badged = false): number {
  const above = badged ? BADGE_LIFT : labelled ? NAME_LIFT : 2;
  return headZ * LIFT + HEAD_R + above;
}

/** Eyes and mouth. Drawn on the skin disc, which is an identity colour and
 * therefore the same in both themes — so these stay a fixed dark too. */
const FACE_INK = "#2b3038";

/**
 * What an agent is doing, as opposed to whether it counts as on duty. The
 * office header groups `waiting` under "working" because that question is
 * *are they on the clock*; this one asks *what are they doing right now*, and
 * an agent parked in the waiting corner is doing nothing. Two questions, two
 * groupings — do not collapse them.
 */
export type PersonMood = "working" | "resting" | "idle";

/** Face drawn when an agent has no avatar of its own. */
function ProceduralFace({ colors, mood = "resting" }: { colors: SpriteColors; mood?: PersonMood }) {
  const r = HEAD_R;
  return (
    <g>
      <circle r={r} fill={colors.skin} />
      <path d={`M ${-r} 0 a ${r} ${r} 0 0 1 ${r * 2} 0 z`} fill={colors.hair} transform="rotate(180)" />
      <path
        d={`M ${-r} -0.5 a ${r} ${r} 0 0 1 ${r * 0.9} ${-r * 0.86} l 0 -2.6 a ${r} ${r * 0.6} 0 0 0 ${-r * 0.9} ${r * 0.86} z`}
        fill={shade(colors.hair, 1.2)}
      />
      {mood === "resting" ? (
        <>
          {/* Eyes closed: two shallow arcs. */}
          <path d="M -5.1 2.2 a 3 3 0 0 1 2.6 0" fill="none" stroke={FACE_INK} strokeWidth={1.1} strokeLinecap="round" />
          <path d="M 2.5 2.2 a 3 3 0 0 1 2.6 0" fill="none" stroke={FACE_INK} strokeWidth={1.1} strokeLinecap="round" />
          <path d="M -2.8 6.2 q 2.8 2.1 5.6 0" fill="none" stroke={FACE_INK} strokeOpacity={0.5} strokeWidth={0.9} strokeLinecap="round" />
        </>
      ) : (
        <>
          <circle cx={-3.8} cy={2.2} r={1.3} fill={FACE_INK} />
          <circle cx={3.8} cy={2.2} r={1.3} fill={FACE_INK} />
          <rect
            x={mood === "working" ? -1.7 : -1.2}
            y={5.9}
            width={mood === "working" ? 3.4 : 2.4}
            height={0.9}
            rx={0.45}
            fill={FACE_INK}
            fillOpacity={0.6}
          />
        </>
      )}
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
  mood,
}: {
  colors: SpriteColors;
  avatarUrl: string | null;
  clipId: string;
  mood?: PersonMood;
}) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [avatarUrl]);
  const r = HEAD_R;
  if (!avatarUrl || broken) {
    return (
      <g>
        <circle r={r} fill={SHELL.lit} />
        <ProceduralFace colors={colors} mood={mood} />
        <circle r={r - 0.5} fill="none" stroke={METAL.dark} strokeOpacity={0.3} strokeWidth={1.1} />
      </g>
    );
  }
  const inner = r - 1;
  return (
    <g>
      <circle r={r} fill={SHELL.lit} />
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

const TROUSER = "#4a5464";

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
  /** Small pill above the name label, e.g. the captain tag; null for none. */
  badge?: string | null;
  /** What they are doing; drives posture detail and expression. */
  mood?: PersonMood;
  onClick?: () => void;
}

/**
 * One agent standing on the floor. The body is drawn in elevation coordinates
 * (u across, v up) and pushed through the projection by a matrix, so it leans
 * with everything else; the head is drawn afterwards as a true circle at its
 * projected centre, because the avatar has to stay round.
 */
/** Rough width of the badge text at its 6.5px size: CJK glyphs run
 * full-width, everything else about two-thirds. Only the pill needs it. */
export const badgeTextW = (text: string): number =>
  [...text].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e7f ? 6.5 : 4.3), 0);

/** Outer width of the badge pill drawn around `text`: dot, gap and padding. */
export const badgePillW = (text: string): number => badgeTextW(text) + 24;

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
  badge,
  mood = "resting",
  onClick,
}: PersonProps) {
  const sitting = posture === "sitting";
  const walking = posture === "walking";
  const headZ = sitting ? SIT_HEAD_Z : HEAD_Z;
  // Resting drops the shoulders a notch; the slouch is the body half of the
  // expression, and it survives a real avatar covering the face.
  const shoulder = headZ - (mood === "resting" && !walking ? 15 : 13);
  const hip = sitting ? 18 : 28;
  const swing = walking ? (frame === 0 ? 3.4 : -3.4) : 0;
  // Working reaches for the desk, idle keeps the arms in; the arms also
  // counter-swing with the legs while walking.
  const armX = mood === "working" ? 11.4 : mood === "idle" ? 11.6 : 12.4;
  const armTop = mood === "working" ? shoulder - 9 : shoulder - 2;
  const hx = px(x, headZ);
  const hy = py(y, headZ);
  const badgeW = badge ? badgeTextW(badge) : 0;
  return (
    <g data-agent={agentId} className={onClick ? "cursor-pointer" : undefined} onClick={onClick}>
      <title>{name}</title>
      {mood === "working" ? <ellipse cx={x} cy={y} rx={16} ry={7} fill="url(#office-glow)" /> : null}
      <ellipse cx={x} cy={y} rx={13} ry={5.4} fill={SHADOW} opacity={0.17} />
      <g transform={`translate(${x} ${y}) matrix(1 0 ${LEAN} ${-LIFT} 0 0)`}>
        {/* Feet first, so the legs sit in front of them. */}
        <rect x={-7.4 + swing} y={-2.6} width={7.6} height={3.4} rx={1.7} fill={shade(TROUSER, 0.8)} />
        <rect x={-0.2 - swing} y={-2.6} width={7.6} height={3.4} rx={1.7} fill={shade(TROUSER, 0.8)} />
        {/* Legs. Seated, only the knees show above the seat pad. */}
        <rect x={-6.6 + swing} y={0} width={6} height={hip + 2} rx={3} fill={TROUSER} />
        <rect x={0.6 - swing} y={0} width={6} height={hip + 2} rx={3} fill={shade(TROUSER, 1.16)} />
        {/* Arms, hung outside the torso so the silhouette stays legible, with
            a hand on the end of each. */}
        <rect
          x={-armX - 1.2}
          y={hip + 2 - swing * 0.5}
          width={5}
          height={Math.max(4, armTop - hip - 2)}
          rx={2.5}
          fill={shade(colors.clothes, 1.12)}
        />
        <rect
          x={armX - 3.8}
          y={hip + 2 + swing * 0.5}
          width={5}
          height={Math.max(4, armTop - hip - 2)}
          rx={2.5}
          fill={shade(colors.clothes, 0.82)}
        />
        <circle cx={-armX + 1.3} cy={hip + 3.4 - swing * 0.5} r={2.7} fill={shade(colors.skin, 0.94)} />
        <circle cx={armX - 1.3} cy={hip + 3.4 + swing * 0.5} r={2.7} fill={shade(colors.skin, 0.94)} />
        {/* Torso, lit down its left edge. Squarer than the members' capsule,
            which is the silhouette half of telling the two casts apart. */}
        <rect x={-9.5} y={hip} width={19} height={shoulder - hip} rx={4} fill={colors.clothes} />
        <rect x={-9.5} y={hip} width={5} height={shoulder - hip} rx={2.5} fill={shade(colors.clothes, 1.18)} opacity={0.8} />
        <rect x={4.5} y={hip} width={5} height={shoulder - hip} rx={2.5} fill={shade(colors.clothes, 0.8)} opacity={0.85} />
        {/* Shoulders and neck. */}
        <rect x={-11} y={shoulder - 6} width={22} height={7.5} rx={2.6} fill={shade(colors.clothes, 0.92)} />
        <rect x={-3.2} y={shoulder} width={6.4} height={5} rx={2.4} fill={shade(colors.skin, 0.88)} />
        <rect
          x={-11}
          y={hip}
          width={22}
          height={shoulder - hip + 1.5}
          rx={4.5}
          fill="none"
          stroke={FIGURE_RIM}
          strokeWidth={1}
        />
      </g>
      <g transform={`translate(${hx} ${hy}) ${mood === "idle" ? "rotate(-2)" : ""}`}>
        <circle r={HEAD_R + 0.5} fill="none" stroke={FIGURE_RIM} strokeWidth={1} />
        <AvatarHead colors={colors} avatarUrl={avatarUrl} clipId={`office-av-${agentId}`} mood={mood} />
      </g>
      {mood === "idle" && label === null ? (
        <text x={hx} y={hy - HEAD_R - 6} textAnchor="middle" fontSize={7} fontWeight={700} fill={INK} fillOpacity={0.55}>
          …
        </text>
      ) : null}
      {label ? (
        <text
          x={hx}
          y={hy - HEAD_R - 5}
          textAnchor="middle"
          fontSize={8.5}
          fontWeight={700}
          fill={INK}
          stroke={HALO}
          strokeWidth={2.8}
          strokeOpacity={0.85}
          paintOrder="stroke"
        >
          {label}
        </text>
      ) : null}
      {badge ? (
        <g pointerEvents="none">
          {/* Laid out from the pill's own left edge so the dot, the label and
              both paddings stay in step whatever the badge text measures. */}
          <rect
            x={hx - badgePillW(badge) / 2}
            y={hy - HEAD_R - BADGE_LIFT + 2}
            width={badgePillW(badge)}
            height={13}
            rx={6.5}
            fill="var(--office-plate)"
            opacity={0.96}
          />
          <circle
            cx={hx - badgePillW(badge) / 2 + 8}
            cy={hy - HEAD_R - BADGE_LIFT + 8.5}
            r={2}
            fill={TERRA}
          />
          <text
            x={hx - badgePillW(badge) / 2 + 15 + badgeW / 2}
            y={hy - HEAD_R - BADGE_LIFT + 11.5}
            textAnchor="middle"
            fontSize={6.5}
            fontWeight={700}
            fill={INK}
          >
            {badge}
          </text>
        </g>
      ) : null}
    </g>
  );
});

/**
 * A human member seen from above: shoulders capsule, hair-ringed head, hands
 * at the sides. Deliberately a different drawing language from the agent
 * Person figures (front-facing miniatures) so the two casts read apart at a
 * glance, and sized one notch larger than the agents.
 */
export const HUMAN_HEAD_R = 15;
/** Vertical distance from the head centre to the name-label baseline. */
export const HUMAN_LABEL_DY = HUMAN_HEAD_R + 10;

export interface HumanFigureProps {
  id: string;
  name: string;
  /** Trimmed name shown above the head. */
  label: string | null;
  /** Floor position (footprint centre). */
  x: number;
  y: number;
  colors: SpriteColors;
  avatarUrl: string | null;
  frame?: number;
  /** Receives the click so the caller can measure the figure it landed on. */
  onClick?: (e: React.MouseEvent<SVGGElement>) => void;
}

export const HumanFigure = memo(function HumanFigure({
  id,
  name,
  label,
  x,
  y,
  colors,
  avatarUrl,
  frame = 0,
  onClick,
}: HumanFigureProps) {
  const hy = y - 6;
  // Hands drift slightly with the phase tick so standing people feel alive.
  const bob = frame === 0 ? 1.3 : -1.3;
  return (
    <g data-member={id} className={onClick ? "cursor-pointer" : undefined} onClick={onClick}>
      <title>{name}</title>
      {/* Ground shadow plus a wide presence ring, one size above the agents'. */}
      <ellipse cx={x} cy={y} rx={19} ry={8} fill={SHADOW} opacity={0.16} />
      <ellipse cx={x} cy={y} rx={15.5} ry={6.4} fill={shade(colors.clothes, 1.4)} opacity={0.3} />
      {/* Shoulders capsule, lit down its left edge like the furniture. */}
      <g transform={`translate(${x} ${y})`}>
        <rect x={-18} y={-10} width={36} height={20} rx={10} fill={colors.clothes} />
        <rect x={-18} y={-10} width={11} height={20} rx={5.5} fill={shade(colors.clothes, 1.16)} opacity={0.85} />
        <rect x={7} y={-10} width={11} height={20} rx={5.5} fill={shade(colors.clothes, 0.8)} opacity={0.9} />
        {/* Hands at the sides. */}
        <circle cx={-14.5} cy={1.5 + bob} r={3.6} fill={shade(colors.skin, 0.95)} />
        <circle cx={14.5} cy={-1.5 - bob} r={3.6} fill={shade(colors.skin, 0.95)} />
        <rect x={-18} y={-10} width={36} height={20} rx={10} fill="none" stroke={FIGURE_RIM} strokeWidth={1.1} />
      </g>
      {/* Head from above: hair ring around the face disc or avatar photo. */}
      <g transform={`translate(${x} ${hy})`}>
        <circle r={HUMAN_HEAD_R} fill={colors.hair} />
        <circle r={HUMAN_HEAD_R} fill="none" stroke={FIGURE_RIM} strokeWidth={1} />
        <AvatarHead colors={colors} avatarUrl={avatarUrl} clipId={`office-hum-${id}`} />
      </g>
      {label ? (
        <text
          x={x}
          y={hy - HUMAN_LABEL_DY}
          textAnchor="middle"
          fontSize={9.5}
          fontWeight={700}
          fill={INK_HUMAN}
          stroke={HALO}
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
