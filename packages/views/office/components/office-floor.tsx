"use client";

import { memo, useMemo, useState } from "react";
import type { OfficeTranslate } from "./office-i18n";
import type { Agent } from "@multica/core/types";
import { resolvePublicFileUrl } from "@multica/core/workspace/avatar-url";
import {
  assignPoses,
  hashString,
  type AgentPose,
  type OfficeScene,
  type OfficeTokenRow,
  type OfficeZoneId,
} from "@multica/core/office";
import {
  BUBBLE_FONT,
  estimateTextWidth,
  fitText,
  formatTokenCount,
  layoutBubbles,
  NAME_FONT,
  type SpriteAnchor,
} from "./office-layout";
import { memberSpot, type OfficeMemberFigure } from "./office-users";
import { OfficeStatusEditor } from "./office-status-editor";
import {
  Armchair,
  Bench,
  CLOTHES,
  CoffeeTable,
  Desk,
  DumbbellRack,
  FLOOR,
  FloorEdges,
  FloorSlab,
  GlassWall,
  HAIRS,
  headClearance,
  HEAD_R,
  HEAD_Z,
  MeetingTable,
  NorthWall,
  Pendant,
  Person,
  pick,
  Plant,
  px,
  py,
  RoundTable,
  Rug,
  SCENE_H,
  SCENE_W,
  SceneDefs,
  SIT_HEAD_Z,
  SKINS,
  Sofa,
  StandupTable,
  Stool,
  TaskChair,
  TeaCounter,
  Treadmill,
  Walker,
  WallScreen,
  WoodChair,
  WorkoutBench,
  YogaMat,
  ZONE_FLOOR,
  type SpriteColors,
  type WalkRoute,
} from "./office-view";

// The office floor proper: one open-plan storey seen from overhead.
//
// Zones are plain rectangles on the floor plane — a desk bank along the north
// light, a glazed meeting room, then tea, lounge, canteen and the waiting
// bench across the south half, with circulation between them. Nothing is
// rotated onto a diagonal, so the plan wastes no space and every caption
// printed on the boards reads straight; height is what makes it a 3D view
// (see office-view.tsx for the projection).
//
// Draw order is a single painter's pass over world Y: every prop and every
// agent goes into one list sorted from the back of the building to the front.
// That is what puts a glass partition in front of the people behind it and a
// canteen table in front of the diner facing it, with no per-zone special
// casing. Seating sorts one unit ahead of whoever is on it, so the chair back
// lands behind them and the pad under them.

export interface OfficeFloorProps {
  scene: OfficeScene;
  /** Wall-clock phase from the page; drives seat rotation & stroller pick. */
  phase: number;
  agentById: ReadonlyMap<string, Agent>;
  t: OfficeTranslate;
  /** Resolves the thought bubble for an agent, or null for none. */
  bubbleFor: (agentId: string) => string | null;
  onAgentClick?: (agentId: string) => void;
  /** Human members standing in the members corner (empty in a fresh floor). */
  users: readonly OfficeMemberFigure[];
  /** Saves the viewer's own custom status; "" clears it. */
  onUserStatusSave?: (status: string) => void;
}

type furn = Exclude<OfficeZoneId, "absent">;

interface Rect {
  x: number;
  y: number;
  w: number;
  d: number;
}

/**
 * The floor plate. The working half takes the north wall where the light and
 * the big board are; the social half fills the south. Each rectangle is the
 * zone's carpet field, sized to contain its occupants' heads — a sprite draws
 * upwards from its floor point, so a zone needs headroom north of its front
 * row, not just the furniture's own footprint.
 */
const ZONES: Record<furn, Rect> = {
  desk: { x: 40, y: 160, w: 468, d: 230 },
  meeting: { x: 556, y: 124, w: 384, d: 216 },
  tea: { x: 40, y: 418, w: 258, d: 98 },
  lounge: { x: 326, y: 414, w: 272, d: 174 },
  canteen: { x: 622, y: 372, w: 292, d: 226 },
  gym: { x: 952, y: 376, w: 198, d: 262 },
  waiting: { x: 40, y: 562, w: 258, d: 84 },
};

/**
 * The members corner: the north half of the east strip, humans only. It is
 * deliberately NOT an OfficeZoneId — agents never rotate into it — so it
 * keeps its own geometry and its own caption.
 */
const MEMBERS_ZONE: Rect = { x: 952, y: 124, w: 198, d: 236 };

const ZONE_ORDER = ["desk", "meeting", "tea", "lounge", "canteen", "gym", "waiting"] as const;

/**
 * Where each zone's caption is printed on the boards. Positions are explicit
 * rather than derived from the rectangle: the aisle a zone can spare is on a
 * different side for each one, and a caption that lands under a name label is
 * exactly the "text covering the agents" problem this layer exists to avoid.
 */
const ZONE_TAG: Record<furn, { x: number; y: number }> = {
  desk: { x: 44, y: 394 },
  meeting: { x: 560, y: 346 },
  tea: { x: 44, y: 519 },
  lounge: { x: 330, y: 591 },
  canteen: { x: 626, y: 601 },
  gym: { x: 956, y: 612 },
  waiting: { x: 44, y: 624 },
};

/** Caption position for the members corner (not part of ZONE_TAG's union). */
const MEMBERS_TAG = { x: 956, y: 344 };

/** One place a sprite can be, and how much label room it has there. */
interface Seat {
  x: number;
  y: number;
  /** Width the name label may occupy before it runs into its neighbour. */
  slot: number;
  /** Desk seats are named on the desktop instead of above the head. */
  plate?: boolean;
}

// --- Furniture layout ------------------------------------------------------

const DESK_W = 100;
const DESK_D = 52;
/** Two rows of four, each occupant seated on the north side of their desk. */
const DESKS = [222, 332].flatMap((rowY) =>
  Array.from({ length: 4 }, (_, i) => ({ x: 50 + i * 118, y: rowY })),
);

const MEETING_TABLE: Rect = { x: 600, y: 198, w: 300, d: 68 };
const MEETING_SEATS = [176, 288].flatMap((y) => [660, 750, 840].map((x) => ({ x, y })));

const TEA_COUNTER: Rect = { x: 50, y: 422, w: 230, d: 34 };
const TEA_SEATS = [92, 165, 238].map((x) => ({ x, y: 488 }));

const LOUNGE_SOFA: Rect = { x: 348, y: 424, w: 168, d: 58 };
const LOUNGE_ARMCHAIR: Rect = { x: 530, y: 428, w: 56, d: 56 };
const LOUNGE_TABLE: Rect = { x: 390, y: 508, w: 100, d: 48 };
const LOUNGE_SEATS = [390, 432, 474].map((x) => ({ x, y: 458 })).concat({ x: 558, y: 458 });

const CANTEEN_TABLES = [700, 838].map((cx) => ({ cx, cy: 470, r: 46 }));
const CANTEEN_SEATS = CANTEEN_TABLES.flatMap((tb) => [
  { x: tb.cx, y: 408 },
  { x: tb.cx - 48, y: 522 },
  { x: tb.cx + 48, y: 522 },
]);

const WAITING_BENCH: Rect = { x: 56, y: 584, w: 226, d: 30 };
const WAITING_SEATS = Array.from({ length: 4 }, (_, i) => ({
  x: WAITING_BENCH.x + (i + 0.5) * (WAITING_BENCH.w / 4),
  y: 600,
}));

// Gym: a rack along the north edge, two treadmills against the east mirror,
// a bench to sit at between sets, and a mat on the rubber.
const GYM_RACK: Rect = { x: 962, y: 386, w: 118, d: 17 };
const GYM_TREADMILLS = [
  { x: 1102, y: 420 },
  { x: 1102, y: 486 },
];
const GYM_BENCH: Rect = { x: 986, y: 470, w: 56, d: 17 };
const GYM_MAT: Rect = { x: 1016, y: 552, w: 46, d: 22 };

// The members corner: one high standup table, humans standing around it.
const MEMBERS_TABLE: Rect = { x: 984, y: 232, w: 140, d: 40 };

const SEATS: Record<furn, Seat[]> = {
  desk: DESKS.map((d) => ({ x: d.x + DESK_W / 2, y: d.y - 22, slot: DESK_W - 12, plate: true })),
  meeting: MEETING_SEATS.map((s) => ({ ...s, slot: 84 })),
  tea: TEA_SEATS.map((s) => ({ ...s, slot: 68 })),
  lounge: LOUNGE_SEATS.map((s) => ({ ...s, slot: 40 })),
  canteen: CANTEEN_SEATS.map((s) => ({ ...s, slot: 62 })),
  gym: [
    { x: GYM_BENCH.x + 15, y: GYM_BENCH.y + 12, slot: 34 },
    { x: GYM_BENCH.x + 40, y: GYM_BENCH.y + 12, slot: 34 },
  ],
  waiting: WAITING_SEATS.map((s) => ({ ...s, slot: 52 })),
};

/**
 * Where overflow stands: in the aisle along the zone's south edge, in front of
 * the furniture rather than inside it. Four lanes is as many as a zone can
 * show; past that the floor is so full that the rail reads better anyway.
 */
function standSpot(zone: furn, n: number): Seat {
  const z = ZONES[zone];
  return {
    x: z.x + ((n % 4) + 0.5) * (z.w / 4),
    y: z.y + z.d - 2,
    slot: z.w / 4 - 12,
  };
}

const WALK_ROUTES: Record<"lounge" | "tea" | "canteen" | "gym", WalkRoute> = {
  tea: { x0: 62, x1: 276, y: 508, speed: 16, offset: 0 },
  lounge: { x0: 340, x1: 584, y: 574, speed: 18, offset: 3 },
  canteen: { x0: 636, x1: 900, y: 582, speed: 20, offset: 6 },
  gym: { x0: 966, x1: 1136, y: 592, speed: 22, offset: 9 },
};

/** How many monologues a zone floats at once. */
const BUBBLE_CAP: Record<furn, number> = {
  desk: 3,
  meeting: 2,
  tea: 2,
  lounge: 2,
  canteen: 2,
  gym: 2,
  waiting: 1,
};

/** Tallest bubble the layout can produce, plus its border. */
const BUBBLE_MAX_H = 34;
/** Height of a zone caption pill. */
const TAG_H = 17;

/** The office's big board, and the meeting room's own display. */
const BOARD = { x: 88, base: 18, w: 384, h: 96 } as const;
const MEETING_BOARD = { x: 636, base: 60, w: 214, h: 52 } as const;

/**
 * The agent's own avatar, as an absolute URL. Resolving is skipped entirely
 * when there is nothing to resolve, so an office of avatar-less agents never
 * asks the API client for a base URL it does not need.
 */
function avatarOf(agent: Agent | undefined): string | null {
  return agent?.avatar_url ? resolvePublicFileUrl(agent.avatar_url) : null;
}

/** A pose resolved to a place on the floor. */
interface Placement {
  pose: AgentPose;
  seat: Seat;
  /** Index into the zone's seat list, or -1 for someone left standing. */
  seatIndex: number;
}

/** One thing on the floor, and the world Y that decides when it is painted. */
interface Drawn {
  key: string;
  y: number;
  node: React.ReactNode;
}

export const OfficeFloor = memo(function OfficeFloor({
  scene,
  phase,
  agentById,
  t,
  bubbleFor,
  onAgentClick,
  users,
  onUserStatusSave,
}: OfficeFloorProps) {
  const { floor } = scene;
  // Which member's status editor is open; only the viewer's own figure can
  // open one, so the id is only ever a self id in practice.
  const [editingUserId, setEditingUserId] = useState<string | null>(null);

  const poses = useMemo(() => assignPoses(floor, phase), [floor, phase]);

  const zoneCounts = useMemo<Record<furn, number>>(
    () => ({
      desk: floor.desks.length,
      meeting: floor.meetings.reduce((n, m) => n + m.attendeeAgentIds.length, 0),
      lounge: floor.lounge.length,
      tea: floor.tea.length,
      canteen: floor.canteen.length,
      gym: floor.gym.length,
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

  /** How much is running at each desk, for the monitor's busy light. */
  const deskRunning = useMemo(
    () => new Map(floor.desks.map((d) => [d.agentId, d.runningCount])),
    [floor.desks],
  );

  // ---- Seat assignment ----------------------------------------------------
  // Walked exactly once and shared by the sprites and the bubbles. Two
  // independent walks would hand the same zone's seats out in different orders
  // as soon as one of them skipped a pose, parking a bubble over somebody
  // else's head.
  const placements = useMemo(() => {
    const nextSeat: Record<furn, number> = {
      desk: 0,
      meeting: 0,
      lounge: 0,
      tea: 0,
      canteen: 0,
      gym: 0,
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
        seated.push({ pose, seat: standSpot(zone, nextStand[zone]), seatIndex: -1 });
        nextStand[zone] += 1;
        continue;
      }
      const list = SEATS[zone];
      const index = nextSeat[zone] % list.length;
      nextSeat[zone] += 1;
      const seat = list[index];
      if (!seat) continue;
      seated.push({ pose, seat, seatIndex: index });
    }
    return { seated, walking };
  }, [poses, agentById, colorsById]);

  /** Which agents are currently thinking out loud, capped per zone. */
  const speaking = useMemo(() => {
    const byZone = new Map<furn, string[]>();
    for (const { pose } of placements.seated) {
      const list = byZone.get(pose.zone as furn) ?? [];
      list.push(pose.agentId);
      byZone.set(pose.zone as furn, list);
    }
    // Rotating the window with the phase gets every agent's inner voice onto
    // the floor eventually, without floating eight bubbles at once.
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
    return placements.seated.map(({ pose, seat, seatIndex }) => {
      const agent = agentById.get(pose.agentId);
      const name = agent?.name ?? "";
      const standing = seatIndex < 0;
      const labelled = standing || seat.plate !== true;
      return {
        pose,
        seat,
        seatIndex,
        standing,
        headZ: standing ? HEAD_Z : SIT_HEAD_Z,
        name,
        label: labelled ? fitText(name, seat.slot, NAME_FONT) : null,
        avatarUrl: avatarOf(agent),
        colors: colorsById.get(pose.agentId) as SpriteColors,
      };
    });
  }, [placements.seated, agentById, colorsById]);

  const walkers = useMemo(() => {
    return placements.walking.map((pose) => {
      const agent = agentById.get(pose.agentId);
      const zone = pose.zone as "lounge" | "tea" | "canteen" | "gym";
      const base = WALK_ROUTES[zone];
      return {
        pose,
        name: agent?.name ?? "",
        label: fitText(agent?.name ?? "", 62, NAME_FONT),
        avatarUrl: avatarOf(agent),
        colors: colorsById.get(pose.agentId) as SpriteColors,
        route: { ...base, offset: base.offset + (hashString(pose.agentId) % 13) },
      };
    });
  }, [placements.walking, agentById, colorsById]);

  /**
   * Member figures, resolved to floor spots, sprite colors and the pill that
   * floats above each head. The pill geometry (not just the text) is derived
   * here so the editor can anchor to the same box the renderer paints.
   */
  const memberSprites = useMemo(() => {
    return users.map((user, i) => {
      const spot = memberSpot(i);
      const hx = px(spot.x, HEAD_Z);
      const hy = py(spot.y, HEAD_Z);
      // Above the name label: see Person for the label baseline.
      const labelTop = hy - HEAD_R - 13;
      const showSet = user.isSelf && user.status === "";
      const text = showSet
        ? t("status.set")
        : user.status !== ""
          ? fitText(user.status, 58, 7)
          : "";
      const inkW = text === "" ? 0 : estimateTextWidth(text, 7);
      const pillW = text === "" ? 0 : inkW + 12;
      return {
        user,
        spot,
        hx,
        hy,
        label: fitText(user.name, spot.slot, NAME_FONT),
        // Same guard as avatarOf: an office of avatar-less members never
        // asks the API client for a base URL it does not need.
        avatarUrl: user.avatarUrl ? resolvePublicFileUrl(user.avatarUrl) : null,
        colors: {
          clothes: pick(CLOTHES, user.userId),
          skin: pick(SKINS, `${user.userId}-skin`),
          hair: pick(HAIRS, `${user.userId}-hair`),
        } satisfies SpriteColors,
        pill: text === "" ? null : { text, set: showSet, x: hx - pillW / 2, y: labelTop - 15, w: pillW, h: 13 },
      };
    });
  }, [users, t]);

  /** Desk slot → who took it, so the desktop can carry their nameplate. */
  const deskNames = useMemo(() => {
    const out = new Map<number, { name: string; busy: boolean }>();
    for (const s of sprites) {
      if (s.pose.zone !== "desk" || s.seatIndex < 0) continue;
      out.set(s.seatIndex, {
        name: s.name,
        busy: (deskRunning.get(s.pose.agentId) ?? 0) > 0,
      });
    }
    return out;
  }, [sprites, deskRunning]);

  /** The floor's live load, shown on the big board beside the leaderboard. */
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

  /**
   * Zone captions, measured once. The bubble layer needs their boxes as well
   * as the renderer does — a monologue lifted over a caption printed on the
   * floor covers the caption, and both are text.
   */
  const zoneTags = useMemo(() => {
    return ZONE_ORDER.map((zone) => {
      const name = t(`zones.${zone}.name`);
      const count = zoneCounts[zone];
      const hint =
        zone === "waiting"
          ? t("zones.waiting.hint")
          : count === 0
            ? t(`zones.${zone}.empty`)
            : null;
      const nameW = estimateTextWidth(name, 10);
      const countW = count > 0 ? estimateTextWidth(String(count), 8.5) + 12 : 0;
      const hintW = hint ? estimateTextWidth(hint, 8) + 6 : 0;
      const { x, y } = ZONE_TAG[zone];
      return { zone, name, hint, count, nameW, countW, x, y, w: 12 + nameW + countW + hintW + 10 };
    });
  }, [t, zoneCounts]);

  const meetingLine = useMemo(() => {
    const squad = floor.meetings[0];
    return squad ? fitText(squad.squadName, MEETING_BOARD.w - 28, 12) : null;
  }, [floor.meetings]);

  /** The members-corner caption, in the same measured shape as zone tags. */
  const memberTag = useMemo(() => {
    const name = t("zones.members.name");
    const nameW = estimateTextWidth(name, 10);
    const countW = users.length > 0 ? estimateTextWidth(String(users.length), 8.5) + 12 : 0;
    return { name, count: users.length, nameW, countW, x: MEMBERS_TAG.x, y: MEMBERS_TAG.y, w: 12 + nameW + countW + 10 };
  }, [t, users.length]);

  // ---- The painter's list -------------------------------------------------
  const drawn = useMemo(() => {
    const list: Drawn[] = [];
    const add = (key: string, y: number, node: React.ReactNode) => list.push({ key, y, node });

    // Desks. The chair sorts one unit ahead of its occupant so the back lands
    // behind them; the desktop sorts on its own front edge, in front of them.
    SEATS.desk.forEach((seat, i) => {
      const desk = DESKS[i];
      if (!desk) return;
      const taken = deskNames.get(i);
      add(`chair-desk-${i}`, seat.y - 1, <TaskChair x={seat.x} y={seat.y} />);
      add(
        `desk-${i}`,
        desk.y + DESK_D,
        <Desk
          x={desk.x}
          y={desk.y}
          w={DESK_W}
          d={DESK_D}
          busy={taken?.busy === true}
          name={taken ? fitText(taken.name, DESK_W - 18, 7) : null}
        />,
      );
    });

    // Meeting room: glazed on the two sides that face the floor.
    const mtg = ZONES.meeting;
    add("glass-w", mtg.y + mtg.d, <GlassWall x={548} y={mtg.y} w={7} d={mtg.d} />);
    // The south run stops short of the west partition: that gap is the door.
    add("glass-s", mtg.y + mtg.d + 1, <GlassWall x={608} y={mtg.y + mtg.d} w={332} d={7} />);
    MEETING_SEATS.forEach((s, i) => add(`chair-mtg-${i}`, s.y - 1, <WoodChair x={s.x} y={s.y} />));
    add("mtg-table", MEETING_TABLE.y + MEETING_TABLE.d, <MeetingTable {...MEETING_TABLE} />);

    // Tea corner.
    add("tea-counter", TEA_COUNTER.y + TEA_COUNTER.d, <TeaCounter {...TEA_COUNTER} />);
    TEA_SEATS.forEach((s, i) => add(`stool-${i}`, s.y - 1, <Stool x={s.x} y={s.y} />));

    // Lounge.
    add("sofa", LOUNGE_SOFA.y - 5, <Sofa {...LOUNGE_SOFA} />);
    add("armchair", LOUNGE_ARMCHAIR.y - 5, <Armchair {...LOUNGE_ARMCHAIR} />);
    add("coffee", LOUNGE_TABLE.y + LOUNGE_TABLE.d, <CoffeeTable {...LOUNGE_TABLE} />);

    // Canteen.
    CANTEEN_SEATS.forEach((s, i) => add(`chair-cant-${i}`, s.y - 1, <WoodChair x={s.x} y={s.y} />));
    CANTEEN_TABLES.forEach((tb, i) =>
      add(`round-${i}`, tb.cy + tb.r, <RoundTable cx={tb.cx} cy={tb.cy} r={tb.r} />),
    );

    // Waiting strip, and the greenery marking the corners of the plate.
    add("bench", WAITING_BENCH.y - 6, <Bench {...WAITING_BENCH} />);
    add("plant-nw", 178, <Plant x={524} y={176} scale={0.95} />);
    add("plant-lounge", 428, <Plant x={340} y={426} scale={0.9} />);
    add("plant-wait", 574, <Plant x={296} y={572} scale={0.85} />);
    add("plant-se", 620, <Plant x={922} y={618} scale={0.9} />);

    // Gym: mirror on the east edge, rack and machines, bench and mat. The
    // mirror sorts with the wall band it stands on.
    add("gym-mirror", 636, <GlassWall x={1146} y={382} w={7} d={250} h={88} />);
    add("gym-rack", GYM_RACK.y + GYM_RACK.d, <DumbbellRack x={GYM_RACK.x} y={GYM_RACK.y} w={GYM_RACK.w} />);
    GYM_TREADMILLS.forEach((tm, i) => add(`gym-treadmill-${i}`, tm.y + 52, <Treadmill x={tm.x} y={tm.y} />));
    add("gym-bench", GYM_BENCH.y + 11, <WorkoutBench x={GYM_BENCH.x} y={GYM_BENCH.y} />);
    add("gym-mat", GYM_MAT.y + GYM_MAT.d, <YogaMat x={GYM_MAT.x} y={GYM_MAT.y} />);
    add("plant-members", 152, <Plant x={968} y={150} scale={0.8} />);
    add("plant-gym", 372, <Plant x={1140} y={368} scale={0.75} />);

    // The members corner's standup table.
    add("members-table", MEMBERS_TABLE.y + MEMBERS_TABLE.d, <StandupTable {...MEMBERS_TABLE} />);

    for (const s of sprites) {
      add(
        `p-${s.pose.agentId}`,
        s.seat.y,
        <Person
          agentId={s.pose.agentId}
          name={s.name}
          label={s.label}
          x={s.seat.x}
          y={s.seat.y}
          posture={s.standing ? "standing" : "sitting"}
          colors={s.colors}
          avatarUrl={s.avatarUrl}
          onClick={onAgentClick ? () => onAgentClick(s.pose.agentId) : undefined}
        />,
      );
    }

    for (const w of walkers) {
      add(
        `w-${w.pose.agentId}`,
        w.route.y,
        <Walker
          agentId={w.pose.agentId}
          name={w.name}
          label={w.label}
          colors={w.colors}
          avatarUrl={w.avatarUrl}
          route={w.route}
          onClick={onAgentClick ? () => onAgentClick(w.pose.agentId) : undefined}
        />,
      );
    }

    for (const m of memberSprites) {
      add(
        `u-${m.user.userId}`,
        m.spot.y,
        <Person
          agentId={m.user.userId}
          name={m.user.name}
          label={m.label}
          x={m.spot.x}
          y={m.spot.y}
          posture="standing"
          colors={m.colors}
          avatarUrl={m.avatarUrl}
          onClick={
            m.user.isSelf && onUserStatusSave
              ? () => setEditingUserId(m.user.userId)
              : undefined
          }
        />,
      );
    }

    // Stable sort: equal depths keep insertion order, which is furniture
    // before the people who belong to it.
    return list
      .map((item, i) => ({ item, i }))
      .sort((a, b) => a.item.y - b.item.y || a.i - b.i)
      .map(({ item }) => item);
  }, [sprites, walkers, memberSprites, deskNames, onAgentClick, onUserStatusSave]);

  // ---- Bubbles ------------------------------------------------------------
  const bubbles = useMemo(() => {
    // Monologue variants are picked by hashing the agent id into a handful of
    // lines, so two neighbours in the same mood land on the same one often
    // enough to notice. One of them stays quiet rather than echoing their
    // colleague word for word.
    const said = new Map<furn, Set<string>>();
    const anchors: SpriteAnchor[] = sprites.map(({ pose, seat, headZ, label }) => {
      const zone = pose.zone as furn;
      const clearance = headClearance(headZ, label !== null && label !== "");
      let text = speaking.has(pose.agentId) ? bubbleFor(pose.agentId) : null;
      if (text) {
        const heard = said.get(zone) ?? new Set<string>();
        if (heard.has(text)) text = null;
        else heard.add(text);
        said.set(zone, heard);
      }
      return {
        agentId: pose.agentId,
        sx: px(seat.x, headZ),
        sy: seat.y,
        clearance,
        labelWidth: Math.max(28, label ? estimateTextWidth(label, NAME_FONT) : 0),
        text,
        // Nothing may climb into the wall: above the skirting a bubble covers
        // the big board, which is the one thing on this floor that has to
        // stay readable.
        maxLift: Math.max(0, seat.y - clearance - 6 - BUBBLE_MAX_H - FLOOR.y0),
      };
    });
    const reserved = zoneTags.map((g) => ({
      left: g.x - 2,
      top: g.y - 2,
      right: g.x + g.w + 2,
      bottom: g.y + TAG_H + 2,
    }));
    reserved.push({
      left: memberTag.x - 2,
      top: memberTag.y - 2,
      right: memberTag.x + memberTag.w + 2,
      bottom: memberTag.y + TAG_H + 2,
    });
    return layoutBubbles(anchors, reserved, { left: 6, right: SCENE_W - 6 });
  }, [sprites, speaking, bubbleFor, zoneTags, memberTag]);

  // The member whose editor is open (null while closed). Resolved from the
  // id so a users-list swap while open still finds the figure.
  const editing = memberSprites.find((m) => m.user.userId === editingUserId) ?? null;
  const editingUser = editing?.user.isSelf === true ? editing : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
      <svg
        viewBox={`0 0 ${SCENE_W} ${SCENE_H}`}
        className="w-full rounded-xl"
        role="img"
        aria-label={t("title")}
      >
        <SceneDefs />
        <clipPath id="office-frame">
          <rect x={0} y={0} width={SCENE_W} height={SCENE_H} rx={10} />
        </clipPath>
        <g clipPath="url(#office-frame)">
          <rect x={0} y={0} width={SCENE_W} height={SCENE_H} fill="#20242b" />
          <FloorSlab />
          {ZONE_ORDER.map((zone) => (
            <Rug
              key={zone}
              x={ZONES[zone].x}
              y={ZONES[zone].y}
              w={ZONES[zone].w}
              d={ZONES[zone].d}
              fill={ZONE_FLOOR[zone] as string}
            />
          ))}
          <Rug {...MEMBERS_ZONE} fill={ZONE_FLOOR.members as string} />
          <FloorEdges />
          <NorthWall slatFrom={540} slatTo={FLOOR.x1} />
          <WallScreen {...BOARD}>
            <TokenBoard
              rows={scene.tokenBoard}
              agentById={agentById}
              t={t}
              running={runningLine}
              w={BOARD.w}
              h={BOARD.h}
            />
          </WallScreen>
          <WallScreen {...MEETING_BOARD}>
            <text x={14} y={-MEETING_BOARD.h + 18} fontSize={9} fontWeight={600} fill="#7f9dc4">
              {t("zones.meeting.name")}
            </text>
            <text x={14} y={-MEETING_BOARD.h + 36} fontSize={12} fontWeight={700} fill="#dce9ff">
              {meetingLine ?? t("zones.meeting.empty")}
            </text>
          </WallScreen>
          <Pendant x={168} y={462} r={62} />
          <Pendant x={432} y={476} r={70} />
          <Pendant x={770} y={470} r={80} />
          <Pendant x={1051} y={250} r={56} />
          <Pendant x={1051} y={500} r={66} />
          {drawn.map((d) => (
            <g key={d.key}>{d.node}</g>
          ))}
          {zoneTags.map((g) => (
            <ZoneTag key={g.zone} {...g} />
          ))}
          <ZoneTag {...memberTag} hint={null} />
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
          {memberSprites.map(({ user, pill }) =>
            pill ? (
              <g
                key={`s-${user.userId}`}
                className={user.isSelf && onUserStatusSave ? "cursor-pointer" : undefined}
                onClick={
                  user.isSelf && onUserStatusSave
                    ? () => setEditingUserId(user.userId)
                    : undefined
                }
              >
                <title>{user.status}</title>
                <rect
                  x={pill.x}
                  y={pill.y}
                  width={pill.w}
                  height={pill.h}
                  rx={pill.h / 2}
                  fill="#ffffff"
                  opacity={pill.set ? 0.75 : 0.95}
                />
                <rect
                  x={pill.x}
                  y={pill.y}
                  width={pill.w}
                  height={pill.h}
                  rx={pill.h / 2}
                  fill="none"
                  stroke={pill.set ? "#9aa5b3" : "#8b96a5"}
                  strokeOpacity={pill.set ? 0.8 : 0.6}
                  strokeWidth={0.9}
                  strokeDasharray={pill.set ? "2.5 2" : undefined}
                />
                <text
                  x={pill.x + pill.w / 2}
                  y={pill.y + 9.2}
                  textAnchor="middle"
                  fontSize={7}
                  fontWeight={600}
                  fill={pill.set ? "#7e8896" : "#3f4854"}
                >
                  {pill.text}
                </text>
              </g>
            ) : null,
          )}
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
      {editingUser && onUserStatusSave ? (
        <OfficeStatusEditor
          anchor={{ x: editingUser.hx, y: editingUser.pill?.y ?? editingUser.hy - HEAD_R - 28 }}
          current={editingUser.user.status}
          t={t}
          onSave={onUserStatusSave}
          onClose={() => setEditingUserId(null)}
        />
      ) : null}
      </div>

      {/* Out of office: nobody to draw on the floor, so they get a strip. */}
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

/**
 * The office's big board, mounted on the north wall above the desk bank: who
 * is burning tokens, and how much of the floor's capacity is running right
 * now. It belongs in the scene rather than in a side panel because a
 * leaderboard is a thing on a wall that the whole room can see.
 */
function TokenBoard({
  rows,
  agentById,
  t,
  running,
  w,
  h,
}: {
  rows: readonly OfficeTokenRow[];
  agentById: ReadonlyMap<string, Agent>;
  t: OfficeTranslate;
  running: string | null;
  w: number;
  h: number;
}) {
  const shown = rows.slice(0, 5);
  const max = shown.length > 0 ? Math.max(...shown.map((r) => r.totalTokens)) : 1;
  const title = t("tokens.title");
  const barX = 168;
  const barW = 112;
  return (
    <g>
      <text x={14} y={-h + 20} fontSize={12} fontWeight={700} fill="#dce9ff">
        {title}
      </text>
      <text x={20 + estimateTextWidth(title, 12)} y={-h + 20} fontSize={8} fill="#6f8db4">
        {t("tokens.window")}
      </text>
      {running ? (
        <text x={w - 14} y={-h + 20} textAnchor="end" fontSize={10} fontWeight={600} fill="#8fd6a8">
          {running}
        </text>
      ) : null}
      <line x1={14} y1={-h + 28} x2={w - 14} y2={-h + 28} stroke="#3d5a86" strokeWidth={1} />
      {shown.length === 0 ? (
        <text x={14} y={-h + 48} fontSize={9.5} fill="#6f8db4">
          {t("tokens.empty")}
        </text>
      ) : (
        shown.map((row, i) => {
          const y = -h + 41 + i * 12;
          const agent = agentById.get(row.agentId);
          const pct = Math.max(0.06, row.totalTokens / max);
          return (
            <g key={row.agentId}>
              <text x={14} y={y} fontSize={8} fill="#6f8db4">
                {i + 1}
              </text>
              <text x={26} y={y} fontSize={9.5} fontWeight={600} fill="#dce9ff">
                {fitText(agent?.name ?? row.agentId.slice(0, 8), barX - 36, 9.5)}
              </text>
              <rect x={barX} y={y - 6.4} width={barW} height={6} rx={3} fill="#26385a" />
              <rect x={barX} y={y - 6.4} width={barW * pct} height={6} rx={3} fill="#5f9bea" />
              <text x={barX + barW + 10} y={y} fontSize={8} fill="#6f8db4">
                {t("tokens.tasks", { count: row.taskCount })}
              </text>
              <text
                x={w - 14}
                y={y}
                textAnchor="end"
                fontSize={9}
                fill="#a9c4e6"
                fontFamily="ui-monospace, monospace"
              >
                {formatTokenCount(row.totalTokens)}
              </text>
            </g>
          );
        })
      )}
    </g>
  );
}

/**
 * A zone's name, printed flat on the boards in the aisle beside it. The floor
 * plane is undistorted in this projection, so floor text is the one place a
 * caption can sit and stay perfectly legible — and lying on the floor it can
 * never cover the people standing on it.
 */
function ZoneTag({
  x,
  y,
  w,
  name,
  nameW,
  countW,
  hint,
  count,
}: {
  x: number;
  y: number;
  w: number;
  name: string;
  nameW: number;
  countW: number;
  hint: string | null;
  count: number;
}) {
  return (
    <g pointerEvents="none">
      <rect x={x} y={y} width={w} height={TAG_H} rx={TAG_H / 2} fill="#ffffff" opacity={0.94} />
      <rect
        x={x}
        y={y}
        width={w}
        height={TAG_H}
        rx={TAG_H / 2}
        fill="none"
        stroke="#98a3b1"
        strokeOpacity={0.55}
        strokeWidth={0.9}
      />
      <text x={x + 11} y={y + 12} fontSize={10} fontWeight={700} fill="#333b46">
        {name}
      </text>
      {count > 0 ? (
        <text x={x + 11 + nameW + 6} y={y + 11.6} fontSize={8.5} fontWeight={600} fill="#6a7482">
          {count}
        </text>
      ) : null}
      {hint ? (
        <text x={x + 11 + nameW + countW + 3} y={y + 11.6} fontSize={8} fill="#7e8896">
          {hint}
        </text>
      ) : null}
    </g>
  );
}
