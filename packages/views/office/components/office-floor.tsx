"use client";

import { Fragment, memo, useMemo } from "react";
import type { OfficeTranslate } from "./office-i18n";
import type { Agent } from "@multica/core/types";
import { resolvePublicFileUrl } from "@multica/core/workspace/avatar-url";
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
  fitText,
  layoutBubbles,
  NAME_FONT,
  type SpriteAnchor,
} from "./office-layout";
import {
  Armchair,
  Bench,
  CanteenTable,
  CLOTHES,
  CoffeeTable,
  HAIRS,
  MeetingTable,
  NAME_LIFT,
  NAMEPLATE_FONT,
  NAMEPLATE_W,
  Person,
  pick,
  Plant,
  roomBox,
  RoomShell,
  Rug,
  SCENE_H,
  SCENE_W,
  SceneDefs,
  SIT_ON,
  SKINS,
  sitTop,
  Sofa,
  STAND_TOP,
  Stool,
  TaskChair,
  TeaCounter,
  Walker,
  WoodChair,
  Workstation,
  type RoomBox,
  type RoomRect,
  type SpriteColors,
  type WalkRoute,
} from "./office-room";

// The office floor proper: six room boxes seen head-on, tiling the canvas.
//
// Rooms are axis-aligned rectangles, so nothing is wasted on empty diagonal
// corners, and each opens into a shallow one-point-perspective interior with
// two usable ranks of floor. Agents face the viewer, which is what lets their
// real avatar carry the identity; the desk room prints names on the desks and
// every other room floats one above the head.
//
// Furniture renders unconditionally so an idle office still reads as an
// office. Within a room the draw order is: shell, floor props, seating,
// people, then the furniture people sit *behind* (desks, tables, counters),
// so a tabletop hides a lower body exactly as it would in the room.

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

type furn = Exclude<OfficeZoneId, "absent">;

/**
 * The floor plan. Two bands of rooms filling the canvas exactly: the working
 * half on top (deeper, because the desk room carries two ranks), the social
 * half below. Widths are set by how many seats each room has to space out
 * without its occupants' name labels running together.
 */
const ROOMS: Record<furn, RoomRect> = {
  desk: { x: 0, y: 0, w: 470, h: 226, depth: 52 },
  tea: { x: 470, y: 0, w: 200, h: 226, depth: 52 },
  lounge: { x: 670, y: 0, w: 230, h: 226, depth: 52 },
  meeting: { x: 0, y: 226, w: 330, h: 194, depth: 40 },
  canteen: { x: 330, y: 226, w: 330, h: 194, depth: 40 },
  waiting: { x: 660, y: 226, w: 240, h: 194, depth: 40 },
};

const ROOM_ORDER = ["desk", "tea", "lounge", "meeting", "canteen", "waiting"] as const;

const BOX = Object.fromEntries(
  (Object.entries(ROOMS) as Array<[furn, RoomRect]>).map(([zone, rect]) => [zone, roomBox(rect)]),
) as Record<furn, RoomBox>;

/** One place a sprite can be, and how much label room it has there. */
interface Seat {
  x: number;
  baseY: number;
  scale: number;
  /** Seat height, which sets where the body sits. */
  seatH: number;
  /** Width the name label may occupy before it runs into its neighbour. */
  slot: number;
  /** 0 = against the wall, 1 = on the near floor line. Sets the draw order. */
  rank: 0 | 1;
  /** Desk-room seats print their name on the desk instead of above the head. */
  plate?: boolean;
}

/**
 * Eight workstations in two ranks. The near four stand on the front floor
 * line at full size; the far four are pushed back to the wall and dropped to
 * 0.9, which is all the perspective this shallow a room needs to separate
 * them. Occupants sit 14 units behind their desk so the tabletop covers the
 * lower body.
 */
const DESK_STATIONS = [
  ...Array.from({ length: 4 }, (_, i) => ({
    x: (i + 0.5) * (ROOMS.desk.w / 4),
    seatY: BOX.desk.floorY - 14,
    deskY: BOX.desk.floorY,
    scale: 1,
    rank: 1 as const,
  })),
  ...Array.from({ length: 4 }, (_, i) => ({
    x: BOX.desk.xb0 + (i + 0.5) * ((BOX.desk.xb1 - BOX.desk.xb0) / 4),
    seatY: BOX.desk.horizonY,
    deskY: BOX.desk.horizonY + 8,
    scale: 0.9,
    rank: 0 as const,
  })),
];

const TEA_STOOLS = Array.from({ length: 3 }, (_, i) => ({
  x: ROOMS.tea.x + (i + 0.5) * (ROOMS.tea.w / 3),
  baseY: BOX.tea.floorY - 24,
}));

/** Three on the sofa, one in the armchair beside it. */
const LOUNGE_SOFA_X = ROOMS.lounge.x + 88;
const LOUNGE_SEATS = [
  { x: LOUNGE_SOFA_X - 46, baseY: BOX.lounge.floorY - 12, seatH: SIT_ON.sofa },
  { x: LOUNGE_SOFA_X, baseY: BOX.lounge.floorY - 12, seatH: SIT_ON.sofa },
  { x: LOUNGE_SOFA_X + 46, baseY: BOX.lounge.floorY - 12, seatH: SIT_ON.sofa },
  { x: ROOMS.lounge.x + 190, baseY: BOX.lounge.floorY - 6, seatH: SIT_ON.sofa },
];

const MEETING_CHAIRS = Array.from({ length: 6 }, (_, i) => ({
  x: ROOMS.meeting.x + (i + 0.5) * (ROOMS.meeting.w / 6),
  baseY: BOX.meeting.floorY - 16,
}));

/** Two round tables, three diners each, sitting on the far side. */
const CANTEEN_TABLES = [ROOMS.canteen.x + 85, ROOMS.canteen.x + 245];
const CANTEEN_SEATS = CANTEEN_TABLES.flatMap((cx) =>
  [-48, 0, 48].map((off) => ({ x: cx + off, baseY: BOX.canteen.floorY - 14 })),
);

/** The bench spans its four seats exactly — nobody may perch off the end. */
const WAITING_BENCH = { x0: ROOMS.waiting.x + 24, x1: ROOMS.waiting.x + ROOMS.waiting.w - 56 };
const WAITING_SEATS = Array.from({ length: 4 }, (_, i) => ({
  x: WAITING_BENCH.x0 + (i + 0.5) * ((WAITING_BENCH.x1 - WAITING_BENCH.x0) / 4),
  baseY: BOX.waiting.floorY - 4,
}));

const SEATS: Record<furn, Seat[]> = {
  desk: DESK_STATIONS.map((d) => ({
    x: d.x,
    baseY: d.seatY,
    scale: d.scale,
    rank: d.rank,
    seatH: SIT_ON.chair,
    slot: NAMEPLATE_W - 4,
    plate: true,
  })),
  tea: TEA_STOOLS.map((s) => ({ ...s, scale: 1, rank: 1 as const, seatH: SIT_ON.stool, slot: 58 })),
  lounge: LOUNGE_SEATS.map((s) => ({ ...s, scale: 1, rank: 1 as const, slot: 44 })),
  meeting: MEETING_CHAIRS.map((s) => ({ ...s, scale: 1, rank: 1 as const, seatH: SIT_ON.chair, slot: 50 })),
  canteen: CANTEEN_SEATS.map((s) => ({ ...s, scale: 1, rank: 1 as const, seatH: SIT_ON.chair, slot: 44 })),
  waiting: WAITING_SEATS.map((s) => ({ ...s, scale: 1, rank: 1 as const, seatH: SIT_ON.bench, slot: 38 })),
};

/**
 * Where overflow stands: on the near floor line, in front of the furniture,
 * offset a quarter slot from the seats behind so a stander never lines up
 * with a seated head. Four lanes is enough — past that a room is so full that
 * the rail is the better place to read it.
 */
function standSpot(zone: furn, n: number): Seat {
  const rect = ROOMS[zone];
  return {
    x: rect.x + ((n % 4) + 0.22) * (rect.w / 4),
    baseY: BOX[zone].floorY,
    scale: 1,
    rank: 1,
    seatH: SIT_ON.chair,
    slot: rect.w / 4 - 8,
  };
}

const WALK_ROUTES: Record<"lounge" | "tea" | "canteen", WalkRoute> = {
  tea: { x0: ROOMS.tea.x + 26, x1: ROOMS.tea.x + ROOMS.tea.w - 26, baseY: BOX.tea.floorY - 4, speed: 15, offset: 0 },
  lounge: {
    x0: ROOMS.lounge.x + 26,
    x1: ROOMS.lounge.x + ROOMS.lounge.w - 26,
    baseY: BOX.lounge.floorY - 4,
    speed: 17,
    offset: 3,
  },
  canteen: {
    x0: ROOMS.canteen.x + 26,
    x1: ROOMS.canteen.x + ROOMS.canteen.w - 26,
    baseY: BOX.canteen.floorY - 2,
    speed: 19,
    offset: 6,
  },
};

/** How many monologues a room floats at once. */
const BUBBLE_CAP: Record<furn, number> = {
  desk: 3,
  meeting: 2,
  tea: 2,
  lounge: 2,
  canteen: 2,
  waiting: 1,
};

/** Tallest bubble the layout can produce, plus its border. */
const BUBBLE_MAX_H = 34;

/**
 * The agent's own avatar, as an absolute URL. Resolving is skipped entirely
 * when there is nothing to resolve, so an office of avatar-less agents never
 * touches the API client for a base URL it does not need.
 */
function avatarOf(agent: Agent | undefined): string | null {
  return agent?.avatar_url ? resolvePublicFileUrl(agent.avatar_url) : null;
}

/** A pose resolved to a seat. */
interface Placement {
  pose: AgentPose;
  seat: Seat;
  /** Height of this sprite's tallest ink above its floor point. */
  clearance: number;
}

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

  // Zone counts power both the wall boards and the per-room empty hints.
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
    for (const [id] of floor.zoneByAgent) {
      out.set(id, {
        clothes: pick(CLOTHES, id),
        skin: pick(SKINS, `${id}-skin`),
        hair: pick(HAIRS, `${id}-hair`),
      });
    }
    return out;
  }, [floor.zoneByAgent]);

  // ---- Seat assignment ----------------------------------------------------
  // Walked exactly once and shared by the sprites and the bubbles. Two
  // independent walks would hand the same zone's seats out in different
  // orders as soon as one of them skipped a pose, parking a bubble over
  // somebody else's head.
  const placements = useMemo(() => {
    const nextSeat: Record<furn, number> = {
      desk: 0,
      meeting: 0,
      lounge: 0,
      tea: 0,
      canteen: 0,
      waiting: 0,
    };
    const nextStand: Record<furn, number> = { ...nextSeat };
    const seated: Placement[] = [];
    const walking: AgentPose[] = [];
    for (const pose of poses) {
      if (!agentById.has(pose.agentId) || !colorsById.has(pose.agentId)) continue;
      const zone = pose.zone as furn;
      if (pose.posture === "walking") {
        walking.push(pose);
        continue;
      }
      if (pose.posture === "standing") {
        const seat = standSpot(zone, nextStand[zone]);
        nextStand[zone] += 1;
        seated.push({ pose, seat, clearance: STAND_TOP + NAME_LIFT });
        continue;
      }
      const seat = SEATS[zone][nextSeat[zone] % SEATS[zone].length];
      nextSeat[zone] += 1;
      if (!seat) continue;
      seated.push({
        pose,
        seat,
        clearance: seat.scale * sitTop(seat.seatH) + (seat.plate ? 0 : NAME_LIFT),
      });
    }
    return { seated, walking };
  }, [poses, agentById, colorsById]);

  /** Which agents are currently thinking out loud, capped per room. */
  const speaking = useMemo(() => {
    const byZone = new Map<furn, string[]>();
    for (const { pose } of placements.seated) {
      const list = byZone.get(pose.zone as furn) ?? [];
      list.push(pose.agentId);
      byZone.set(pose.zone as furn, list);
    }
    // Rotating the window with the phase keeps every agent's inner voice on
    // the board eventually, without stacking eight bubbles at once.
    const out = new Set<string>();
    for (const [zone, ids] of byZone) {
      const cap = Math.min(BUBBLE_CAP[zone], ids.length);
      const start = ids.length === 0 ? 0 : phase % ids.length;
      for (let i = 0; i < cap; i += 1) out.add(ids[(start + i) % ids.length] as string);
    }
    return out;
  }, [placements.seated, phase]);

  /** Everything the sprite layer needs, resolved once per agent. */
  const sprites = useMemo(() => {
    return placements.seated.map(({ pose, seat, clearance }) => {
      const agent = agentById.get(pose.agentId);
      const name = agent?.name ?? "";
      return {
        pose,
        seat,
        clearance,
        name,
        label: seat.plate ? null : fitText(name, seat.slot, NAME_FONT),
        avatarUrl: avatarOf(agent),
        colors: colorsById.get(pose.agentId) as SpriteColors,
      };
    });
  }, [placements.seated, agentById, colorsById]);

  const spritesByZone = useMemo(() => {
    const out = new Map<furn, typeof sprites>();
    for (const s of sprites) {
      const zone = s.pose.zone as furn;
      const list = out.get(zone) ?? [];
      list.push(s);
      out.set(zone, list);
    }
    return out;
  }, [sprites]);

  const walkers = useMemo(() => {
    return placements.walking.map((pose) => {
      const agent = agentById.get(pose.agentId);
      const zone = pose.zone as "lounge" | "tea" | "canteen";
      const base = WALK_ROUTES[zone];
      return {
        pose,
        zone,
        name: agent?.name ?? "",
        label: fitText(agent?.name ?? "", 54, NAME_FONT),
        avatarUrl: avatarOf(agent),
        colors: colorsById.get(pose.agentId) as SpriteColors,
        route: base ? { ...base, offset: base.offset + (hashString(pose.agentId) % 13) } : null,
      };
    });
  }, [placements.walking, agentById, colorsById]);

  /** The line on the open-plan wall board: the office's live load. */
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

  /** The meeting room's screen shows whose room it currently is. */
  const meetingBoard = useMemo(() => {
    const squad = floor.meetings[0];
    if (!squad) return null;
    return fitText(squad.squadName, (BOX.meeting.xb1 - BOX.meeting.xb0) * 0.5, 9);
  }, [floor.meetings]);

  // Bubbles anchor to stationary seats only (a moving speaker would drag a
  // box across the room). Every seated sprite is handed to the layout, not
  // just the speaking ones, so a bubble can dodge a silent neighbour's head,
  // and each carries the headroom its own room has before the ceiling.
  const bubbles = useMemo(() => {
    // Monologue variants are picked by hashing the agent id, so two neighbours
    // in the same mood land on the same line often enough to notice. One of
    // them stays quiet rather than echoing their colleague word for word.
    const said = new Map<furn, Set<string>>();
    const anchors: SpriteAnchor[] = sprites.map(({ pose, seat, clearance, label }) => {
      const zone = pose.zone as furn;
      const preferred = seat.baseY - clearance - 6;
      let text = speaking.has(pose.agentId) ? bubbleFor(pose.agentId) : null;
      if (text) {
        const heard = said.get(zone) ?? new Set<string>();
        if (heard.has(text)) text = null;
        else heard.add(text);
        said.set(zone, heard);
      }
      return {
        agentId: pose.agentId,
        sx: seat.x,
        sy: seat.baseY,
        clearance,
        labelWidth: Math.max(26 * seat.scale, label ? estimateTextWidth(label, NAME_FONT) : 0),
        text,
        // A room is a closed box: a bubble that cannot fit under this
        // ceiling is dropped rather than allowed to climb into the room above.
        maxLift: Math.max(0, preferred - BUBBLE_MAX_H - (BOX[zone].backTop + 4)),
      };
    });
    return layoutBubbles(anchors, [], { left: 6, right: SCENE_W - 6 });
  }, [sprites, speaking, bubbleFor]);

  return (
    <div className="flex flex-col gap-3">
      <svg
        viewBox={`0 0 ${SCENE_W} ${SCENE_H}`}
        className="w-full rounded-xl"
        role="img"
        aria-label={t("title")}
      >
        <SceneFrame />
        <g clipPath="url(#office-frame)">
          {ROOM_ORDER.map((zone) => (
            <Fragment key={zone}>
              <RoomShell
                box={BOX[zone]}
                zone={zone}
                board={zone === "desk" ? runningLine : zone === "meeting" ? meetingBoard : null}
              />
              <RoomContents
                zone={zone}
                box={BOX[zone]}
                floorDesks={floor.desks}
                agentById={agentById}
                sprites={spritesByZone.get(zone) ?? []}
                walkers={walkers.filter((w) => w.zone === zone)}
                onAgentClick={onAgentClick}
              />
              <Caption
                box={BOX[zone]}
                name={t(`zones.${zone}.name`)}
                hint={
                  zone === "waiting"
                    ? t("zones.waiting.hint")
                    : zoneCounts[zone] === 0
                      ? t(`zones.${zone}.empty`)
                      : null
                }
                count={zoneCounts[zone]}
              />
            </Fragment>
          ))}
          {bubbles.map((b) => (
            <foreignObject
              key={`b-${b.agentId}`}
              data-agent={b.agentId}
              x={b.x}
              y={b.y}
              width={b.width}
              height={b.height}
            >
              {/* The box is sized by layoutBubbles, so a one-line bubble must
                  not be allowed to wrap into a second line the layout reserved
                  no room for, and a longer one is clamped to the two it
                  measured. */}
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
        </g>
        <rect
          x={0.75}
          y={0.75}
          width={SCENE_W - 1.5}
          height={SCENE_H - 1.5}
          rx={10}
          fill="none"
          stroke="var(--border)"
          strokeWidth={1.5}
        />
      </svg>

      {/* Out-of-office strip */}
      <div className="flex flex-wrap gap-2">
        {floor.absent.map((a) => {
          const agent = agentById.get(a.agentId);
          if (!agent) return null;
          const avatar = avatarOf(agent);
          return (
            <span
              key={a.agentId}
              className="flex items-center gap-1.5 rounded-full border bg-muted/40 py-1 pl-1 pr-2.5 text-caption text-muted-foreground"
            >
              <span className="flex size-6 items-center justify-center overflow-hidden rounded-full bg-muted text-micro">
                {avatar ? (
                  <img src={avatar} alt="" className="size-full object-cover opacity-60 grayscale" />
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

/** Scene-wide defs plus the rounded frame everything is clipped to. */
function SceneFrame() {
  return (
    <>
      <SceneDefs />
      <clipPath id="office-frame">
        <rect x={0} y={0} width={SCENE_W} height={SCENE_H} rx={10} />
      </clipPath>
    </>
  );
}

/**
 * The room caption, printed on the structural slab under the floor. It is
 * below every sprite and every bubble in the scene, so unlike a caption laid
 * over the room it can never cover the people it names.
 */
function Caption({
  box,
  name,
  hint,
  count,
}: {
  box: RoomBox;
  name: string;
  hint: string | null;
  count: number;
}) {
  const y = (box.floorY + box.y1) / 2 + 3.6;
  return (
    <g pointerEvents="none">
      <text x={box.x0 + 12} y={y} fontSize={10} fontWeight={700} fill="#f2e7d8">
        {name}
      </text>
      {hint ? (
        <text
          x={box.x0 + 16 + estimateTextWidth(name, 10)}
          y={y}
          fontSize={8}
          fill="#f2e7d8"
          opacity={0.62}
        >
          {hint}
        </text>
      ) : null}
      {count > 0 ? (
        <text x={box.x1 - 12} y={y} textAnchor="end" fontSize={9} fontWeight={600} fill="#f2e7d8" opacity={0.8}>
          {count}
        </text>
      ) : null}
    </g>
  );
}

type Sprite = {
  pose: AgentPose;
  seat: Seat;
  name: string;
  label: string | null;
  avatarUrl: string | null;
  colors: SpriteColors;
};

type WalkerSprite = {
  pose: AgentPose;
  name: string;
  label: string;
  avatarUrl: string | null;
  colors: SpriteColors;
  route: WalkRoute | null;
};

/**
 * One room's contents. Seating goes down first, then the people on it, then
 * the surfaces they sit behind — that order is what makes a tabletop cover a
 * lower body instead of floating over a face.
 */
function RoomContents({
  zone,
  box,
  floorDesks,
  agentById,
  sprites,
  walkers,
  onAgentClick,
}: {
  zone: furn;
  box: RoomBox;
  floorDesks: OfficeScene["floor"]["desks"];
  agentById: ReadonlyMap<string, Agent>;
  sprites: Sprite[];
  walkers: WalkerSprite[];
  onAgentClick?: (agentId: string) => void;
}) {
  const person = (s: Sprite) => (
    <Person
      key={s.pose.agentId}
      agentId={s.pose.agentId}
      name={s.name}
      label={s.label}
      x={s.seat.x}
      baseY={s.seat.baseY}
      scale={s.seat.scale}
      posture={s.pose.posture === "standing" ? "standing" : "sitting"}
      seatH={s.seat.seatH}
      colors={s.colors}
      avatarUrl={s.avatarUrl}
      onClick={onAgentClick ? () => onAgentClick(s.pose.agentId) : undefined}
    />
  );
  // Anyone who overflowed their room's seating stands on the near floor line,
  // in front of the furniture, so they draw after it.
  const seatedPeople = sprites.filter((s) => s.pose.posture !== "standing");
  const standing = sprites.filter((s) => s.pose.posture === "standing").map(person);
  const people = seatedPeople.map(person);

  const strollers = walkers.map((w) =>
    w.route ? (
      <Walker
        key={`w-${w.pose.agentId}`}
        agentId={w.pose.agentId}
        name={w.name}
        label={w.label}
        colors={w.colors}
        avatarUrl={w.avatarUrl}
        route={w.route}
        onClick={onAgentClick ? () => onAgentClick(w.pose.agentId) : undefined}
      />
    ) : null,
  );

  switch (zone) {
    // Two ranks, drawn strictly back to front: a far desk painted after a near
    // agent would sit on their face.
    case "desk": {
      const station = (rank: 0 | 1) => (
        <>
          {DESK_STATIONS.map((d, i) =>
            d.rank === rank ? (
              <TaskChair key={`c${i}`} x={d.x} baseY={d.seatY + 3} scale={d.scale} />
            ) : null,
          )}
          {seatedPeople.filter((s) => s.seat.rank === rank).map(person)}
          {DESK_STATIONS.map((d, i) => {
            if (d.rank !== rank) return null;
            const occupant = floorDesks[i];
            const name = occupant ? (agentById.get(occupant.agentId)?.name ?? "") : "";
            return (
              <Workstation
                key={`d${i}`}
                x={d.x}
                baseY={d.deskY}
                scale={d.scale}
                busy={(occupant?.runningCount ?? 0) > 0}
                name={name ? fitText(name, NAMEPLATE_W - 6, NAMEPLATE_FONT) : null}
              />
            );
          })}
        </>
      );
      return (
        <g>
          {station(0)}
          {station(1)}
          {standing}
        </g>
      );
    }

    case "meeting":
      return (
        <g>
          <Rug box={box} from={0.14} to={0.86} near={0.94} far={0.1} fill="#8b6f52" />
          {MEETING_CHAIRS.map((c, i) => (
            <TaskChair key={i} x={c.x} baseY={c.baseY + 3} />
          ))}
          {people}
          <MeetingTable
            x={(box.x0 + box.x1) / 2}
            baseY={box.floorY - 2}
            w={(box.x1 - box.x0) * 0.82}
          />
          {standing}
        </g>
      );

    case "tea":
      return (
        <g>
          {TEA_STOOLS.map((s, i) => (
            <Stool key={i} x={s.x} baseY={s.baseY} />
          ))}
          {people}
          <TeaCounter x={(box.x0 + box.x1) / 2} baseY={box.floorY - 6} w={box.x1 - box.x0 - 30} />
          {strollers}
          {standing}
        </g>
      );

    case "lounge":
      return (
        <g>
          <Rug box={box} from={0.08} to={0.7} near={0.96} far={0.24} fill="#a8896a" />
          <Plant x={box.x1 - 22} baseY={box.horizonY + 10} scale={0.86} />
          <Sofa x={LOUNGE_SOFA_X} baseY={BOX.lounge.floorY - 12} w={132} />
          <Armchair x={ROOMS.lounge.x + 190} baseY={BOX.lounge.floorY - 6} />
          {people}
          <CoffeeTable x={LOUNGE_SOFA_X - 6} baseY={box.floorY - 1} />
          {strollers}
          {standing}
        </g>
      );

    case "canteen":
      return (
        <g>
          {CANTEEN_SEATS.map((s, i) => (
            <WoodChair key={i} x={s.x} baseY={s.baseY + 3} />
          ))}
          {people}
          {CANTEEN_TABLES.map((cx) => (
            <CanteenTable key={cx} x={cx} baseY={box.floorY - 2} />
          ))}
          {strollers}
          {standing}
        </g>
      );

    case "waiting":
    default:
      return (
        <g>
          <Plant x={box.x1 - 22} baseY={box.floorY - 2} scale={0.8} />
          <Bench
            x={(WAITING_BENCH.x0 + WAITING_BENCH.x1) / 2}
            baseY={box.floorY - 4}
            w={WAITING_BENCH.x1 - WAITING_BENCH.x0}
          />
          {people}
          {standing}
        </g>
      );
  }
}
