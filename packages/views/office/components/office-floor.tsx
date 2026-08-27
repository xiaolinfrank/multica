"use client";

import { Fragment, memo, useMemo } from "react";
import type { OfficeTranslate } from "./office-i18n";
import type { Agent } from "@multica/core/types";
import {
  assignPoses,
  hashString,
  type AgentPose,
  type OfficeScene,
  type OfficeZoneId,
} from "@multica/core/office";
import {
  BUBBLE_FONT,
  estimateTextWidth,
  layoutBubbles,
  NAME_FONT,
  type Rect,
  type SpriteAnchor,
} from "./office-layout";
import {
  BackWalls,
  BarStool,
  CanteenTable,
  CoffeeBar,
  CoffeeTable,
  CLOTHES,
  Desk,
  DESK_SEAT,
  FloorTiles,
  HAIRS,
  iso,
  IsoDefs,
  LABEL_TOP,
  MeetingTable,
  OfficeChair,
  pick,
  Plant,
  Rug,
  SittingPerson,
  SKINS,
  Sofa,
  StandingPerson,
  TILE_H,
  TILE_W,
  WaitingBench,
  WalkingPerson,
  Whiteboard,
  type SpriteColors,
  type WalkRoute,
} from "./office-iso";

// The office floor proper: one game-style isometric room drawn in SVG.
// Furniture and rugs render unconditionally so an idle office still reads
// as an office; agents take the seats their zone gives them (overflow
// stands at the back), and a leisure room with three or more people sends
// one of them strolling around the carpet. Static sprites are depth-sorted
// together with furniture; walkers draw above their own room band. Thought
// bubbles are foreignObject boxes inside the same SVG so they scale with
// the floor and float above heads — never on top of an agent.

export interface OfficeFloorProps {
  scene: OfficeScene;
  /** Wall-clock phase from the page; drives seat rotation & stroller pick. */
  phase: number;
  agentById: ReadonlyMap<string, Agent>;
  t: OfficeTranslate;
  /** Resolves the thought bubble for an agent, or null for none. */
  bubbleFor: (agentId: string) => string | null;
  onAgentClick?: (agentId: string) => void;
}

const GRID_W = 12;
const GRID_D = 11;

type RoomRect = { x: number; y: number; w: number; d: number };
type furn = Exclude<OfficeZoneId, "absent">;

const ROOMS: Record<furn, RoomRect> = {
  desk: { x: 0.5, y: 0.5, w: 6.1, d: 3.9 },
  meeting: { x: 0.7, y: 4.75, w: 5.9, d: 4.3 },
  tea: { x: 7.0, y: 0.5, w: 5.0, d: 2.35 },
  lounge: { x: 7.0, y: 3.15, w: 5.0, d: 2.65 },
  canteen: { x: 7.0, y: 6.1, w: 5.0, d: 3.05 },
  waiting: { x: 2.3, y: 9.55, w: 4.3, d: 0.85 },
};

/** Carpet tint per room. Low-alpha ink so it works on either theme. */
const ZONE_TINT: Record<furn, string> = {
  desk: "#7c9cf526",
  meeting: "#9d8ff526",
  tea: "#8fd0a926",
  lounge: "#f2b26b26",
  canteen: "#e58fb124",
  waiting: "#8d97a226",
};

/**
 * Eight workstations, two rows of four. The anchor is the desk's centre; the
 * agent sits at DESK_SEAT from it, so the tabletop depth-sorts in front of the
 * body. Spacing exceeds the desk's own width, so the row reads as four
 * separate workstations rather than one continuous slab.
 */
const DESKS = Array.from({ length: 8 }, (_, i) => ({
  gx: 1.38 + (i % 4) * 1.32,
  gy: i < 4 ? 1.25 : 3.1,
}));

const MEETING_CHAIRS = [
  { gx: 2.45, gy: 6.3 },
  { gx: 3.55, gy: 6.3 },
  { gx: 4.65, gy: 6.3 },
  { gx: 2.45, gy: 7.85 },
  { gx: 3.55, gy: 7.85 },
  { gx: 4.65, gy: 7.85 },
];

/**
 * Stools down the counter. Spaced a full cell apart: any closer and adjacent
 * name labels, which are far wider than the bodies under them, collide.
 */
const TEA_STOOLS = [
  { gx: 9.9, gy: 0.8 },
  { gx: 9.9, gy: 1.75 },
  { gx: 9.9, gy: 2.7 },
];

const LOUNGE_SEATS = [
  { gx: 7.72, gy: 4.98 },
  { gx: 8.57, gy: 4.98 },
  { gx: 9.42, gy: 4.98 },
  { gx: 10.75, gy: 4.42 },
];

const CANTEEN_TABLES = [
  { cx: 8.2, cy: 7.1 },
  { cx: 10.15, cy: 8.25 },
];

const CANTEEN_SEATS = CANTEEN_TABLES.flatMap(({ cx, cy }) => [
  { gx: cx - 0.9, gy: cy - 0.12 },
  { gx: cx + 0.9, gy: cy - 0.12 },
  { gx: cx, gy: cy + 0.78 },
]);

const WAITING_SEATS = [0, 1, 2, 3].map((i) => ({ gx: 2.9 + i * 0.9, gy: 10.16 }));

const WALK_ROUTES: Record<"lounge" | "tea" | "canteen", WalkRoute> = {
  lounge: {
    points: [
      { gx: 7.6, gy: 3.7 },
      { gx: 11.1, gy: 3.7 },
      { gx: 11.1, gy: 5.55 },
      { gx: 7.6, gy: 5.55 },
    ],
    speed: 0.4,
    offset: 13,
  },
  tea: {
    points: [
      { gx: 7.5, gy: 0.92 },
      { gx: 9.2, gy: 0.92 },
      { gx: 9.2, gy: 2.55 },
      { gx: 7.5, gy: 2.55 },
    ],
    speed: 0.36,
    offset: 31,
  },
  canteen: {
    points: [
      { gx: 7.4, gy: 6.55 },
      { gx: 11.5, gy: 6.55 },
      { gx: 11.5, gy: 9.0 },
      { gx: 7.4, gy: 9.0 },
    ],
    speed: 0.44,
    offset: 47,
  },
};

function seatSpot(zone: furn, n: number): { gx: number; gy: number } | null {
  switch (zone) {
    case "desk": {
      const d = DESKS[n % DESKS.length];
      return d ? { gx: d.gx + DESK_SEAT.dx, gy: d.gy + DESK_SEAT.dy } : null;
    }
    case "meeting":
      return MEETING_CHAIRS[n % MEETING_CHAIRS.length] ?? null;
    case "tea":
      return TEA_STOOLS[n % TEA_STOOLS.length] ?? null;
    case "lounge":
      return LOUNGE_SEATS[n % LOUNGE_SEATS.length] ?? null;
    case "canteen":
      return CANTEEN_SEATS[n % CANTEEN_SEATS.length] ?? null;
    case "waiting":
      return WAITING_SEATS[n % WAITING_SEATS.length] ?? null;
    default:
      return null;
  }
}

function zoneLabel(rect: RoomRect): [number, number] {
  const [sx, sy] = iso(rect.x + rect.w / 2, rect.y + 0.28);
  return [sx, sy];
}

/** Ink extent of a room caption above and below its anchor, in scene units. */
const CAPTION_TOP = -12.5;
const CAPTION_BOTTOM_NAME = -2;
const CAPTION_BOTTOM_HINT = 12;
const CAPTION_GAP = 5;

interface Renderable {
  depth: number;
  /** People break ties against furniture so bodies never hide under props. */
  tieBreaker: number;
  node: React.ReactNode;
}

/** A pose resolved to a seat: where the sprite stands and how deep it sits. */
interface Placement {
  pose: AgentPose;
  sx: number;
  sy: number;
  depth: number;
}

/** Scene box with no bubbles in it; the top edge grows to fit lifted ones. */
const VIEW_LEFT = -(GRID_D * TILE_W) / 2 - 36;
const VIEW_W = (GRID_W + GRID_D) * (TILE_W / 2) + 76;
const VIEW_TOP = -74;
const VIEW_BOTTOM = VIEW_TOP + (GRID_W + GRID_D) * (TILE_H / 2) + 112;

export const OfficeFloor = memo(function OfficeFloor({
  scene,
  phase,
  agentById,
  t,
  bubbleFor,
  onAgentClick,
}: OfficeFloorProps) {
  const { floor } = scene;

  const poses = useMemo(() => assignPoses(floor, phase), [floor, phase]);

  // Zone counts power both the badge lines and the per-room empty hints.
  const zoneCounts = useMemo(
    () => ({
      desk: floor.desks.length,
      meeting: floor.meetings.reduce((n, m) => n + m.attendeeAgentIds.length, 0),
      lounge: floor.lounge.length,
      tea: floor.tea.length,
      canteen: floor.canteen.length,
      waiting: floor.waiting.length,
    }),
    [floor],
  );

  const colorsById = useMemo(() => {
    const out = new Map<string, SpriteColors>();
    for (const [id] of scene.floor.zoneByAgent) {
      out.set(id, {
        clothes: pick(CLOTHES, id),
        skin: pick(SKINS, `${id}-skin`),
        hair: pick(HAIRS, `${id}-hair`),
      });
    }
    return out;
  }, [scene.floor.zoneByAgent]);

  // ---- Seat assignment ----------------------------------------------------
  // Walked exactly once and shared by the sprites and the bubbles. Two
  // independent walks would hand the same zone's seats out in different
  // orders as soon as one of them skipped a pose, parking a bubble over
  // somebody else's head.
  const placements = useMemo<Placement[]>(() => {
    const nextSeat: Record<furn, number> = {
      desk: 0,
      meeting: 0,
      lounge: 0,
      tea: 0,
      canteen: 0,
      waiting: 0,
    };
    const out: Placement[] = [];
    for (const pose of poses) {
      if (!agentById.has(pose.agentId) || !colorsById.has(pose.agentId)) continue;
      if (pose.posture === "walking") {
        out.push({ pose, sx: 0, sy: 0, depth: Number.MAX_SAFE_INTEGER });
        continue;
      }
      const spot = seatSpot(pose.zone, nextSeat[pose.zone]);
      nextSeat[pose.zone] += 1;
      if (!spot) continue;
      const [sx, sy] = iso(spot.gx, spot.gy);
      out.push({ pose, sx, sy, depth: spot.gx + spot.gy });
    }
    return out;
  }, [poses, agentById, colorsById]);

  // ---- Draw list: static furniture + placed people, depth-sorted ----------
  const items = useMemo<Renderable[]>(() => {
    const list: Renderable[] = [];
    const add = (depth: number, tieBreaker: number, key: string, node: React.ReactNode) =>
      list.push({ depth, tieBreaker, node: <Fragment key={key}>{node}</Fragment> });

    // Furniture — every piece renders even when the room is empty.
    DESKS.forEach((d, i) => {
      const occupant = floor.desks[i];
      // The chair sorts before its occupant, the desk after both, so an empty
      // station still shows a chair tucked under the tabletop.
      add(
        d.gx + d.gy + DESK_SEAT.dx + DESK_SEAT.dy - 0.05,
        0,
        `dchair${i}`,
        <OfficeChair gx={d.gx + DESK_SEAT.dx - 0.29} gy={d.gy + DESK_SEAT.dy - 0.27} variant="task" />,
      );
      add(d.gx + d.gy, 0, `desk${i}`, <Desk gx={d.gx} gy={d.gy} busy={(occupant?.runningCount ?? 0) > 0} />);
    });
    add(3.55 + 6.95, 0, "meet-table", <MeetingTable cx={3.55} cy={6.95} />);
    MEETING_CHAIRS.forEach((c, i) =>
      add(c.gx + c.gy, 0, `mchair${i}`, <OfficeChair gx={c.gx - 0.29} gy={c.gy - 0.27} />),
    );
    add(3.3 + 5.05, 0, "whiteboard", <Whiteboard gx={3.3} gy={5.05} />);
    add(10.02 + 0.75, 0, "coffeebar", <CoffeeBar gx={10.02} gy={0.75} />);
    TEA_STOOLS.forEach((s, i) => add(s.gx + s.gy, 1, `stool${i}`, <BarStool gx={s.gx} gy={s.gy} />));
    add(7.3 + 4.72, 0, "sofa", <Sofa gx={7.3} gy={4.72} />);
    add(10.35 + 4.85, 0, "ctable", <CoffeeTable gx={10.35} gy={4.85} />);
    CANTEEN_TABLES.forEach((t0, i) =>
      add(t0.cx + t0.cy, 0, `canT${i}`, <CanteenTable cx={t0.cx} cy={t0.cy} />),
    );
    CANTEEN_SEATS.forEach((s, i) =>
      add(s.gx + s.gy, 0, `canS${i}`, <OfficeChair gx={s.gx - 0.26} gy={s.gy - 0.24} />),
    );
    add(2.85 + 10.3, 0, "bench", <WaitingBench gx={2.85} gy={10.3} />);
    (
      [
        [0.45, 9.7],
        [11.3, 0.45],
        [6.55, 0.45],
        [11.35, 5.9],
        [6.55, 9.9],
      ] as const
    ).forEach(([gx, gy], i) => add(gx + gy, 0, `plant${i}`, <Plant gx={gx} gy={gy} />));

    // People — drawn on the seats the shared placement pass handed out.
    for (const { pose, sx, sy, depth } of placements) {
      const colors = colorsById.get(pose.agentId);
      const agent = agentById.get(pose.agentId);
      if (!colors || !agent) continue;
      const click = onAgentClick ? () => onAgentClick(pose.agentId) : undefined;
      if (pose.posture === "walking") {
        const base = WALK_ROUTES[pose.zone as "lounge" | "tea" | "canteen"];
        list.push({
          depth,
          tieBreaker: 0,
          node: (
            <WalkingPerson
              key={`w-${pose.agentId}`}
              agentId={pose.agentId}
              name={agent.name}
              sx={0}
              sy={0}
              facing={1}
              colors={colors}
              route={{ ...base, offset: base.offset + (hashString(pose.agentId) % 17) }}
            />
          ),
        });
        continue;
      }
      list.push({
        depth,
        tieBreaker: 1,
        node:
          pose.posture === "standing" ? (
            <StandingPerson
              agentId={pose.agentId}
              name={agent.name}
              sx={sx}
              sy={sy}
              facing={1}
              colors={colors}
              onClick={click}
            />
          ) : (
            <SittingPerson
              agentId={pose.agentId}
              name={agent.name}
              sx={sx}
              sy={sy}
              facing={1}
              colors={colors}
              onClick={click}
            />
          ),
      });
    }

    list.sort((a, b) => a.depth - b.depth || a.tieBreaker - b.tieBreaker);
    return list;
  }, [placements, colorsById, agentById, onAgentClick, floor]);

  // Total running capacity headline for the desk band.
  const runningLine = useMemo(() => {
    if (floor.desks.length === 0) return null;
    let running = 0;
    let cap = 0;
    for (const d of floor.desks) {
      running += d.runningCount;
      cap += d.capacity;
    }
    return `${t("figure.running")} ${running}/${cap}`;
  }, [floor.desks, t]);

  // ---- Room signage -------------------------------------------------------
  // Captions sit at each room's north edge, above the furniture they name.
  // A sprite seated in that strip would be painted over by its own room's
  // name, so a caption with somebody under it rises until it clears them.
  const signage = useMemo(() => {
    return (Object.entries(ROOMS) as Array<[furn, RoomRect]>).map(([zone, rect]) => {
      const empty = zoneCounts[zone] === 0;
      const hint =
        zone === "waiting" ? t(`zones.${zone}.hint`) : empty ? t(`zones.${zone}.empty`) : null;
      const name = t(`zones.${zone}.name`);
      const [lx, base] = zoneLabel(rect);
      const halfW =
        Math.max(estimateTextWidth(name, 11), hint ? estimateTextWidth(hint, 8) : 0) / 2 + 3;
      const bottom = hint ? CAPTION_BOTTOM_HINT : CAPTION_BOTTOM_NAME;

      let ly = base;
      // Each pass moves strictly upwards past one sprite, so this terminates;
      // the guard only covers pathological input.
      for (let guard = 0; guard <= placements.length; guard += 1) {
        let moved = false;
        for (const p of placements) {
          if (p.pose.posture === "walking") continue;
          const reach =
            estimateTextWidth(agentById.get(p.pose.agentId)?.name ?? "", NAME_FONT) / 2 + 2;
          if (p.sx + reach <= lx - halfW || p.sx - reach >= lx + halfW) continue;
          const spriteTop =
            p.sy - LABEL_TOP[p.pose.posture === "standing" ? "standing" : "sitting"];
          if (ly + CAPTION_TOP >= p.sy || ly + bottom <= spriteTop) continue;
          ly = spriteTop - CAPTION_GAP - bottom;
          moved = true;
        }
        if (!moved) break;
      }
      return { zone, name, hint, lx, ly, halfW, bottom };
    });
  }, [zoneCounts, t, placements, agentById]);

  // Bubbles anchor to stationary seats only (a moving speaker would drag a
  // box across the room). Every seated sprite is handed to the layout, not
  // just the speaking ones, so a bubble can dodge a silent neighbour's head.
  const bubbles = useMemo(() => {
    const anchors: SpriteAnchor[] = [];
    for (const { pose, sx, sy } of placements) {
      if (pose.posture === "walking") continue;
      const name = agentById.get(pose.agentId)?.name ?? "";
      anchors.push({
        agentId: pose.agentId,
        sx,
        sy,
        clearance: LABEL_TOP[pose.posture === "standing" ? "standing" : "sitting"],
        labelWidth: estimateTextWidth(name, NAME_FONT),
        text: bubbleFor(pose.agentId),
      });
    }
    // Room captions and the running-capacity badge are already placed, so a
    // bubble has to go round them.
    const reserved: Rect[] = signage.map(({ lx, ly, halfW, bottom }) => ({
      left: lx - halfW,
      top: ly + CAPTION_TOP,
      right: lx + halfW,
      bottom: ly + bottom,
    }));
    const [bx, by] = iso(ROOMS.desk.x + ROOMS.desk.w, ROOMS.desk.y);
    if (runningLine) {
      reserved.push({
        left: bx - 4 - estimateTextWidth(runningLine, 9),
        top: by - 14 - 9,
        right: bx - 4,
        bottom: by - 14 + 2,
      });
    }
    return layoutBubbles(anchors, reserved);
  }, [placements, agentById, bubbleFor, runningLine, signage]);

  // A stack of lifted bubbles can reach above the empty scene box; grow the
  // viewBox rather than let them paint over the page header.
  const viewTop = useMemo(
    () =>
      Math.min(
        VIEW_TOP,
        ...bubbles.map((b) => b.y - 6),
        ...signage.map((s) => s.ly + CAPTION_TOP - 6),
      ),
    [bubbles, signage],
  );

  return (
    <div className="flex flex-col gap-3">
      <svg
        viewBox={`${VIEW_LEFT} ${viewTop} ${VIEW_W} ${VIEW_BOTTOM - viewTop}`}
        className="w-full"
        style={{ overflow: "visible" }}
        role="img"
        aria-label={t("title")}
      >
        <IsoDefs />
        {/* Room shell: the two back walls, then the tiled ground and its edge. */}
        <BackWalls w={GRID_W} d={GRID_D} />
        <FloorTiles w={GRID_W} d={GRID_D} />
        <polygon
          points={[iso(0, 0), iso(GRID_W, 0), iso(GRID_W, GRID_D), iso(0, GRID_D)]
            .map(([x, y]) => `${x},${y}`)
            .join(" ")}
          fill="none"
          stroke="#8b837552"
        />
        {/* Zone carpets, one hue each so the rooms read apart at a glance */}
        {(Object.entries(ROOMS) as Array<[furn, RoomRect]>).map(([zone, rect]) => (
          <Rug key={zone} rect={rect} fill={ZONE_TINT[zone]} stroke="#6f7a8c40" />
        ))}
        {items.map((item, i) => (
          <Fragment key={i}>{item.node}</Fragment>
        ))}
        {/* Room signage. Drawn above the furniture it names — on the carpet a
            tall desk row swallows it — and below the bubbles. */}
        {signage.map(({ zone, name, hint, lx, ly }) => (
          <g key={zone} pointerEvents="none">
            <text
              x={lx}
              y={ly - 4}
              textAnchor="middle"
              fontSize={11}
              fontWeight={700}
              opacity={0.6}
              stroke="var(--background)"
              strokeWidth={3}
              paintOrder="stroke"
              fill="var(--foreground)"
            >
              {name}
            </text>
            {hint ? (
              <text
                x={lx}
                y={ly + 10}
                textAnchor="middle"
                fontSize={8}
                opacity={0.5}
                stroke="var(--background)"
                strokeWidth={2.4}
                paintOrder="stroke"
                fill="var(--muted-foreground)"
              >
                {hint}
              </text>
            ) : null}
          </g>
        ))}
        {runningLine ? (
          <text
            x={iso(ROOMS.desk.x + ROOMS.desk.w, ROOMS.desk.y)[0] - 4}
            y={iso(ROOMS.desk.x + ROOMS.desk.w, ROOMS.desk.y)[1] - 14}
            textAnchor="end"
            fontSize={9}
            fontWeight={600}
            opacity={0.75}
            stroke="var(--background)"
            strokeWidth={2.4}
            paintOrder="stroke"
            fill="var(--foreground)"
            pointerEvents="none"
          >
            {runningLine}
          </text>
        ) : null}
        {bubbles.map((b) => (
          <foreignObject
            key={`b-${b.agentId}`}
            data-agent={b.agentId}
            x={b.x}
            y={b.y}
            width={b.width}
            height={b.height}
            style={{ overflow: "visible" }}
          >
            {/* The box is sized by layoutBubbles, so a one-line bubble must not
                be allowed to wrap into a second line the layout reserved no
                room for, and a longer one is clamped to the two it measured. */}
            <div
              className="flex size-full items-center justify-center overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-sm"
              style={{ fontSize: BUBBLE_FONT, lineHeight: 1.25, paddingInline: 6 }}
              title={b.text}
            >
              <span
                style={
                  b.lines === 1
                    ? { whiteSpace: "nowrap" }
                    : {
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }
                }
              >
                {b.text}
              </span>
            </div>
          </foreignObject>
        ))}
      </svg>

      {/* Out-of-office strip */}
      <div className="flex flex-wrap gap-2">
        {floor.absent.map((a) => {
          const agent = agentById.get(a.agentId);
          if (!agent) return null;
          return (
            <span
              key={a.agentId}
              className="flex items-center gap-1.5 rounded-full border bg-muted/40 py-1 pl-1 pr-2.5 text-caption text-muted-foreground"
            >
              <span className="flex size-6 items-center justify-center overflow-hidden rounded-full bg-muted text-micro">
                {agent.avatar_url ? (
                  <img src={agent.avatar_url} alt="" className="size-full object-cover opacity-60 grayscale" />
                ) : (
                  (agent.name || "?").trim().charAt(0).toUpperCase()
                )}
              </span>
              <span className="max-w-28 truncate" title={agent.name}>
                {agent.name}
              </span>
              <span>·</span>
              <span>{t(`zones.absent.${a.reason}`)}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
});
