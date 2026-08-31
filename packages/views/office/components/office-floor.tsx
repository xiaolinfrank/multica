"use client";

import { memo, useCallback, useMemo, useRef, useState } from "react";
import type { OfficeTranslate } from "./office-i18n";
import type { Agent } from "@multica/core/types";
import {
  assignPoses,
  hashString,
  type AgentPose,
  type OfficeScene,
  type OfficeTokenRow,
  type MemberSeatZone,
  type OfficeZoneId,
} from "@multica/core/office";
import {
  BUBBLE_FONT,
  estimateTextWidth,
  fitText,
  formatTokenCount,
  layoutBubbles,
  NAME_FONT,
  type Rect as BlockedRect,
  type SpriteAnchor,
} from "./office-layout";
import { resolvePublicFileUrl } from "@multica/core/workspace/avatar-url";
import { agentAvatarUrl as avatarOf, humanSpot, type SeatedMember } from "./office-users";
import { OfficeStatusEditor } from "./office-status-editor";
import {
  Armchair,
  Bench,
  CLOTHES,
  CoffeeTable,
  Desk,
  DESK_H,
  DumbbellRack,
  FLOOR,
  FloorEdges,
  FloorSlab,
  GlassWall,
  HAIRS,
  headClearance,
  badgePillW,
  HumanFigure,
  HUMAN_LABEL_DY,
  HEAD_Z,
  LEAN,
  LIFT,
  MEMBER_CLOTHES,
  MeetingTable,
  NorthWall,
  Pendant,
  Person,
  pick,
  Plant,
  px,
  RoundTable,
  Rug,
  SCENE_H,
  SCENE_W,
  SceneDefs,
  SEAT_H,
  SIT_HEAD_Z,
  SKINS,
  Sofa,
  Stool,
  TaskChair,
  KanbanBoard,
  TeaCounter,
  Treadmill,
  Walker,
  WallScreen,
  WoodChair,
  WorkoutBench,
  YogaMat,
  ZONE_FLOOR,
  type PersonMood,
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
  /** Human members seated among the agents by their recent activity. */
  users: readonly SeatedMember[];
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
  desk: { x: 40, y: 172, w: 468, d: 328 },
  meeting: { x: 556, y: 124, w: 384, d: 290 },
  tea: { x: 40, y: 540, w: 258, d: 132 },
  lounge: { x: 326, y: 532, w: 272, d: 228 },
  canteen: { x: 622, y: 458, w: 292, d: 304 },
  gym: { x: 952, y: 463, w: 198, d: 352 },
  waiting: { x: 40, y: 706, w: 258, d: 120 },
  pmo: { x: 952, y: 159, w: 198, d: 270 },
};

const ZONE_ORDER = ["desk", "meeting", "pmo", "tea", "lounge", "canteen", "gym", "waiting"] as const;

/**
 * Zones that get a caption printed on their carpet. The meeting room is left
 * out on purpose: it has its own display on the north wall, and captioning it
 * twice said "Meeting rooms / no squad is meeting" in two places at once.
 */
const TAGGED_ZONES = ZONE_ORDER.filter((z) => z !== "meeting");

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
const DESKS = [248, 380].flatMap((rowY) =>
  Array.from({ length: 4 }, (_, i) => ({ x: 50 + i * 118, y: rowY })),
);

const MEETING_TABLE: Rect = { x: 600, y: 224, w: 300, d: 68 };
const MEETING_SEATS = [202, 314].flatMap((y) => [660, 750, 840].map((x) => ({ x, y })));

const TEA_COUNTER: Rect = { x: 50, y: 580, w: 230, d: 34 };
const TEA_SEATS = [92, 165, 238].map((x) => ({ x, y: 618 }));

const LOUNGE_SOFA: Rect = { x: 348, y: 584, w: 168, d: 58 };
const LOUNGE_ARMCHAIR: Rect = { x: 530, y: 589, w: 56, d: 56 };
const LOUNGE_TABLE: Rect = { x: 390, y: 672, w: 100, d: 48 };
const LOUNGE_SEATS = [390, 432, 474].map((x) => ({ x, y: 618 })).concat({ x: 558, y: 618 });

const CANTEEN_TABLES = [700, 838].map((cx) => ({ cx, cy: 589, r: 46 }));
const CANTEEN_SEATS = CANTEEN_TABLES.flatMap((tb) => [
  { x: tb.cx, y: 527 },
  { x: tb.cx - 48, y: 641 },
  { x: tb.cx + 48, y: 641 },
]);

const WAITING_BENCH: Rect = { x: 56, y: 752, w: 226, d: 30 };
// The project office, set into the top-right bay: a kanban board against the
// north edge and a planning table with two places a side. The whole group
// hangs off the board's floor line. A sitting sprite reaches about 40 units
// up the screen and carries a name plus a leader badge above that, so the
// north row sits 74 south of the board rather than tucked under it; the rest
// follows the meeting room's spacing of 22 units between a row and the table.
const PMO_BOARD = { x: 970, y: 214, w: 142 } as const;
const PMO_TABLE: Rect = { x: 966, y: 310, w: 168, d: 58 };
const PMO_SEATS = [288, 390].flatMap((y) => [1008, 1092].map((x) => ({ x, y })));
const WAITING_SEATS = Array.from({ length: 4 }, (_, i) => ({
  x: WAITING_BENCH.x + (i + 0.5) * (WAITING_BENCH.w / 4),
  y: 768,
}));

// Gym: a rack along the north edge, two treadmills against the east mirror,
// a bench to sit at between sets, and a mat on the rubber.
const GYM_RACK: Rect = { x: 962, y: 496, w: 118, d: 17 };
const GYM_TREADMILLS = [
  { x: 1102, y: 522 },
  { x: 1102, y: 611 },
];
const GYM_BENCH: Rect = { x: 986, y: 589, w: 56, d: 17 };
const GYM_MAT: Rect = { x: 1016, y: 700, w: 46, d: 22 };


/**
 * The squad's name printed beside the room's, unless it only repeats it: a
 * squad literally called "PMO" captioned inside the PMO reads as a rendering
 * bug rather than as a label.
 */
function squadHint(squadName: string | undefined, zoneName: string): string | null {
  const squad = (squadName ?? "").trim();
  if (squad === "") return null;
  const a = squad.toLowerCase();
  const b = zoneName.toLowerCase();
  return a === b || a.includes(b) || b.includes(a) ? null : squad;
}

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
  pmo: PMO_SEATS.map((s) => ({ ...s, slot: 76 })),
};

/**
 * Where overflow stands: in the aisle along the zone's south edge, in front of
 * the furniture rather than inside it. Four lanes is as many as a zone can
 * show; past that the floor is so full that the rail reads better anyway.
 */
function standSpot(zone: furn, n: number): Seat {
  const z = ZONES[zone];
  if (zone === "pmo") {
    // The project office is half the width of the other rooms, so its aisle
    // takes two abreast rather than four.
    return {
      x: z.x + ((n % 2) + 0.5) * (z.w / 2),
      y: z.y + z.d - 2,
      slot: z.w / 2 - 12,
    };
  }
  return {
    x: z.x + ((n % 4) + 0.5) * (z.w / 4),
    y: z.y + z.d - 2,
    slot: z.w / 4 - 12,
  };
}

const WALK_ROUTES: Record<"lounge" | "tea" | "canteen" | "gym", WalkRoute> = {
  tea: { x0: 62, x1: 276, y: 640, speed: 16, offset: 0 },
  lounge: { x0: 340, x1: 584, y: 729, speed: 18, offset: 3 },
  canteen: { x0: 636, x1: 900, y: 740, speed: 20, offset: 6 },
  gym: { x0: 966, x1: 1136, y: 753, speed: 22, offset: 9 },
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
  pmo: 2,
};

/** Tallest bubble the layout can produce, plus its border. */
const BUBBLE_MAX_H = 34;
/** Height of a zone caption pill. */
const TAG_H = 17;
/**
 * Space between a caption's name and the hint that follows it. The name is
 * measured, not laid out, and {@link estimateTextWidth} rounds latin text
 * down as often as up — at a three-unit gap "Gym" and its hint printed as one
 * word. This is wide enough that a bad estimate still reads as two phrases.
 */
const TAG_GAP = 8;
/**
 * Bare floor kept north of every zone, for its caption to be printed in.
 *
 * Every zone is set far enough from its northern neighbour to leave this lane
 * clear. On a plate this deep it costs nothing, and it is the only place in
 * the room where a caption can neither be walked over by the people in the
 * zone nor hidden under the furniture at its north edge — a zone rectangle is
 * sized to contain its occupants' heads, so its own top edge *is* the head
 * band. The project office stops short of the gym for the same reason: the
 * two used to meet with eight units between them.
 */
const AISLE = TAG_H + 5;

/** The office's big board, and the meeting room's own display. */
// The two wall displays. The token board used to run 384 units wide with the
// meeting board tucked beside it, which made a navy slab the heaviest thing on
// a white page — the subject of this view is the people on the floor. Both are
// now sized like signage: readable from across the room, and no louder.
const BOARD = { x: 96, base: 20, w: 344, h: 84 } as const;
const MEETING_BOARD = { x: 690, base: 64, w: 224, h: 52 } as const;

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
  // Which member's status editor is open, and where over the stage it opened.
  // Only the viewer's own figure can open one, so the id is only ever a self
  // id in practice. The point is measured off the clicked node rather than
  // derived from scene units: the scene is fitted inside its box, so scene
  // coordinates and stage pixels are no longer the same grid.
  const [editing, setEditing] = useState<{ userId: string; x: number; y: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const openEditor = useCallback(
    (userId: string) => (e: { currentTarget: Element }) => {
      const stage = stageRef.current;
      if (!stage) return;
      const box = e.currentTarget.getBoundingClientRect();
      const host = stage.getBoundingClientRect();
      setEditing({
        userId,
        x: box.left + box.width / 2 - host.left,
        y: box.top - host.top - 6,
      });
    },
    [],
  );
  const closeEditor = useCallback(() => setEditing(null), []);

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
      pmo: floor.pmo.length,
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
      pmo: 0,
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

  // The badge marks the squad's leader, not everyone in their room. A
  // human-led squad reports an empty id, which no agent can match.
  const pmoLeaderId = floor.pmoSquad?.leaderAgentId ?? "";

  /** Everything the sprite layer needs, resolved once per agent. */
  const sprites = useMemo(() => {
    return placements.seated.map(({ pose, seat, seatIndex }) => {
      const agent = agentById.get(pose.agentId);
      const name = agent?.name ?? "";
      const standing = seatIndex < 0;
      const labelled = standing || seat.plate !== true;
      // What they are doing, not whether they are on duty: office-page.tsx
      // counts the waiting corner under "working" because that answers a
      // different question. See PersonMood.
      const mood: PersonMood =
        pose.zone === "desk" || pose.zone === "meeting" || pose.zone === "pmo"
          ? "working"
          : pose.zone === "waiting"
            ? "idle"
            : "resting";
      return {
        pose,
        seat,
        seatIndex,
        standing,
        mood,
        headZ: standing ? HEAD_Z : SIT_HEAD_Z,
        badge: pose.zone === "pmo" && pose.agentId === pmoLeaderId ? t("captain.label") : null,
        name,
        label: labelled ? fitText(name, seat.slot, NAME_FONT) : null,
        avatarUrl: avatarOf(agent),
        colors: colorsById.get(pose.agentId) as SpriteColors,
      };
    });
  }, [placements.seated, agentById, colorsById, pmoLeaderId, t]);

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
 * Member figures, seated among the agents by their recent activity and
 * resolved to floor spots, sprite colors and the pill that floats above
 * each head. The pill geometry (not just the text) is derived here so the
 * editor can anchor to the same box the renderer paints.
 */
const memberSprites = useMemo(() => {
  const perZone = new Map<MemberSeatZone, number>();
  return users.map((user) => {
    const i = perZone.get(user.zone) ?? 0;
    perZone.set(user.zone, i + 1);
    const spot = humanSpot(user.zone, i);
    const hx = spot.x;
    const hy = spot.y - 6;
    // Above the name label: see HumanFigure for the label baseline.
    const labelTop = hy - HUMAN_LABEL_DY - 8;
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
      label: fitText(user.name, 46, NAME_FONT),
      // Same guard as avatarOf: an office of avatar-less members never
      // asks the API client for a base URL it does not need.
      avatarUrl: user.avatarUrl ? resolvePublicFileUrl(user.avatarUrl) : null,
      colors: {
        clothes: pick(MEMBER_CLOTHES, user.userId),
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

  /** Which places at the planning table are taken, so the rest tuck in. */
  const pmoTaken = useMemo(() => {
    const out = new Set<number>();
    for (const s of sprites) {
      if (s.pose.zone === "pmo" && s.seatIndex >= 0) out.add(s.seatIndex);
    }
    return out;
  }, [sprites]);

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
    return TAGGED_ZONES.map((zone) => {
      const z = ZONES[zone];
      // The name is fitted too, not only the hint. Without this a long zone
      // name with a count and no hint produced an unbounded pill, and a name
      // beside a hint pushed the algebra into `w = z.w - 8` regardless.
      const zoneName = t(`zones.${zone}.name`);
      const name = fitText(zoneName, z.w - 34, 10);
      const count = zoneCounts[zone];
      const nameW = estimateTextWidth(name, 10);
      const countW = count > 0 ? estimateTextWidth(String(count), 8.5) + 12 : 0;
      // The project office belongs to a squad, and the caption is the only
      // place on the floor that can say which one: its board carries no
      // lettering, because a vertical face in this projection squashes text.
      const hintRaw =
        zone === "waiting"
          ? t("zones.waiting.hint")
          : zone === "pmo" && count > 0
            ? squadHint(floor.pmoSquad?.name, zoneName)
            : count === 0
              ? t(`zones.${zone}.empty`)
              : null;
      // A caption may run the width of its own aisle and no further. English
      // zone names and hints run half again as long as the Chinese ones this
      // layout was drawn against, and "Waiting corner · Tasks on the plate,
      // waiting for a runtime" is wider than the corner it names.
      const hint = hintRaw
        ? fitText(hintRaw, Math.max(0, z.w - 30 - TAG_GAP - nameW - countW), 8) || null
        : null;
      const hintW = hint ? estimateTextWidth(hint, 8) + TAG_GAP : 0;
      // Clamped to the zone it captions, not to the room: a pill wider than
      // its own carpet points at the wrong floor.
      const w = Math.min(12 + nameW + countW + hintW + 10, z.w);
      // Centred on the zone, in the lane of bare floor above it, then held
      // inside the room: a caption that runs past the west wall reads as a
      // clipping bug rather than as a label.
      const x = Math.min(Math.max(z.x + (z.w - w) / 2, FLOOR.x0 + 6), FLOOR.x1 - 6 - w);
      return { zone, name, hint, count, nameW, countW, x, y: z.y - AISLE, w };
    });
  }, [t, zoneCounts, floor.pmoSquad]);

  const meetingLine = useMemo(() => {
    const squad = floor.meetings[0];
    return squad ? fitText(squad.squadName, MEETING_BOARD.w - 28, 12) : null;
  }, [floor.meetings]);


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
      // An unclaimed chair is pushed in under its worktop, and sorts behind
      // the desktop rather than in front of it, so an empty bank of desks
      // reads as tidy rather than as eight abandoned seats.
      add(
        `chair-desk-${i}`,
        taken ? seat.y - 1 : seat.y + 7,
        <TaskChair x={seat.x} y={seat.y} tucked={!taken} />,
      );
      add(
        `desk-${i}`,
        desk.y + DESK_D,
        <Desk
          x={desk.x}
          y={desk.y}
          w={DESK_W}
          d={DESK_D}
          busy={taken?.busy === true}
          occupied={taken !== undefined}
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
    // Project office: the board against the north edge, then the table with a
    // chair at each place. An unclaimed chair is tucked in, exactly as in the
    // desk bank, so an empty room reads as tidy rather than as walked out of.
    add("pmo-board", PMO_BOARD.y, <KanbanBoard {...PMO_BOARD} />);
    PMO_SEATS.forEach((seat, i) =>
      add(`chair-pmo-${i}`, pmoTaken.has(i) ? seat.y - 1 : seat.y + 7, <TaskChair x={seat.x} y={seat.y} tucked={!pmoTaken.has(i)} />),
    );
    add("pmo-table", PMO_TABLE.y + PMO_TABLE.d, <MeetingTable {...PMO_TABLE} seats={2} />);
    add("plant-pmo", 252, <Plant x={1140} y={248} scale={0.85} />);
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


    for (const s of sprites) {
      add(
        `p-${s.pose.agentId}`,
        s.seat.y,
        <Person
          agentId={s.pose.agentId}
          name={s.name}
          label={s.label}
          badge={s.badge}
          x={s.seat.x}
          y={s.seat.y}
          posture={s.standing ? "standing" : "sitting"}
          mood={s.mood}
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
    <HumanFigure
      id={m.user.userId}
      name={m.user.name}
      label={m.label}
      x={m.spot.x}
      y={m.spot.y}
      colors={m.colors}
      avatarUrl={m.avatarUrl}
      onClick={
        m.user.isSelf && onUserStatusSave ? openEditor(m.user.userId) : undefined
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
  }, [sprites, walkers, memberSprites, deskNames, onAgentClick, onUserStatusSave, openEditor]);

  // ---- Bubbles ------------------------------------------------------------
  const bubbles = useMemo(() => {
    // Monologue variants are picked by hashing the agent id into a handful of
    // lines, so two neighbours in the same mood land on the same one often
    // enough to notice. One of them stays quiet rather than echoing their
    // colleague word for word.
    const said = new Map<furn, Set<string>>();
    const anchors: SpriteAnchor[] = sprites.map(({ pose, seat, headZ, label, badge }) => {
      const zone = pose.zone as furn;
      // A badge pill is the tallest and often the widest ink a sprite draws,
      // so both budgets have to know about it — otherwise a colleague's bubble
      // parks on the PMO leader's tag.
      const clearance = headClearance(headZ, label !== null && label !== "", badge !== null);
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
        labelWidth: Math.max(
          28,
          label ? estimateTextWidth(label, NAME_FONT) : 0,
          badge ? badgePillW(badge) : 0,
        ),
        text,
        // Nothing may climb into the wall: above the skirting a bubble covers
        // the big board, which is the one thing on this floor that has to
        // stay readable.
        maxLift: Math.max(0, seat.y - clearance - 6 - BUBBLE_MAX_H - FLOOR.y0),
      };
    });
    for (const m of memberSprites) {
  const zone = m.user.zone;
  let text = bubbleFor(m.user.userId);
  if (text) {
    const heard = said.get(zone) ?? new Set<string>();
    if (heard.has(text)) text = null;
    else heard.add(text);
    said.set(zone, heard);
  }
  anchors.push({
    agentId: m.user.userId,
    sx: m.spot.x,
    sy: m.spot.y,
    // Derived from the pill the renderer will actually paint. A constant
    // here drifts the moment the pill's own geometry moves, and a bubble
    // lands on somebody's status.
    clearance: m.pill ? m.spot.y - m.pill.y + 3 : HUMAN_LABEL_DY + 20,
    labelWidth: Math.max(
      28,
      m.label ? estimateTextWidth(m.label, 9.5) : 0,
      m.pill?.w ?? 0,
    ),
    text,
    maxLift: Math.max(0, m.spot.y - HUMAN_LABEL_DY - 32 - BUBBLE_MAX_H - FLOOR.y0),
  });
}
const reserved: BlockedRect[] = zoneTags.map((g) => ({
      left: g.x - 2,
      top: g.y - 2,
      right: g.x + g.w + 2,
      bottom: g.y + TAG_H + 2,
    }));
    // Tall props block as well as captions. A desktop carries the nameplate of
    // whoever owns that desk, which is the only place the room answers "whose
    // seat is that"; the counters and the sofa back are simply tall enough
    // that a bubble parked on one stops reading as floating.
    //
    // Only solids around 30 units or taller, or ones carrying printed text,
    // are reserved. Reserving every prop starves a full room — layoutBubbles
    // drops a bubble it cannot place rather than stacking it — so the meeting
    // and round tables, the coffee table, the treadmills, the dumbbell rack
    // and the mats stay open on purpose.
    const solidBox = (r: Rect, h: number): BlockedRect => ({
      left: r.x - 2,
      top: r.y - h * LIFT - 2,
      right: r.x + r.w + h * LEAN + 2,
      bottom: r.y + r.d,
    });
    for (const d of DESKS) {
      reserved.push(solidBox({ ...d, w: DESK_W, d: DESK_D }, DESK_H));
    }
    reserved.push(solidBox(TEA_COUNTER, 34));
    reserved.push(solidBox(PMO_TABLE, DESK_H));
    reserved.push(solidBox({ ...PMO_BOARD, d: 4 }, 76));
    reserved.push(solidBox(WAITING_BENCH, SEAT_H + 22));
    reserved.push(solidBox(LOUNGE_SOFA, 42));
    // Bubbles are clamped to the room, not to the SVG: the walls are where the
    // scene stops being floor, and a bubble hanging over the west wall — or
    // lifted through the ceiling onto the north wall's boards — reads as a
    // rendering bug rather than as somebody thinking.
    return layoutBubbles(anchors, reserved, {
      left: FLOOR.x0 + 4,
      right: FLOOR.x1 - 4,
      top: FLOOR.y0 + 4,
    });
  }, [sprites, memberSprites, speaking, bubbleFor, zoneTags]);

  // The member whose editor is open (null while closed). Resolved from the
  // id so a users-list swap while open still finds the figure.
  const editingUser = editing
    ? (memberSprites.find((m) => m.user.userId === editing.userId && m.user.isSelf) ?? null)
    : null;

  return (
    // Two height modes, because the page has two layouts. Beside the rail
    // the grid row is clamped to the viewport, so the stage takes the height
    // it is given and the drawing letterboxes by a few pixels at most.
    // Stacked above the rail there is no such row, so the stage carries the
    // scene's own aspect ratio — otherwise it would inherit the rail's
    // height and float in the middle of an empty column.
    <div ref={stageRef} className="relative aspect-[10/7] w-full min-h-0 @5xl:aspect-auto @5xl:size-full">
      <svg
        viewBox={`0 0 ${SCENE_W} ${SCENE_H}`}
        className="size-full rounded-xl"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={t("title")}
      >
        <SceneDefs />
        <clipPath id="office-frame">
          <rect x={0} y={0} width={SCENE_W} height={SCENE_H} rx={10} />
        </clipPath>
        <g clipPath="url(#office-frame)">
          <rect x={0} y={0} width={SCENE_W} height={SCENE_H} fill="var(--office-backdrop)" />
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
            <text x={14} y={-MEETING_BOARD.h + 18} fontSize={9} fontWeight={600} fill="var(--office-screen-mute)">
              {t("zones.meeting.name")}
            </text>
            {zoneCounts.meeting > 0 ? (
              <text
                x={MEETING_BOARD.w - 14}
                y={-MEETING_BOARD.h + 18}
                textAnchor="end"
                fontSize={9}
                fontWeight={700}
                fill="var(--office-screen-good)"
              >
                {zoneCounts.meeting}
              </text>
            ) : null}
            <text x={14} y={-MEETING_BOARD.h + 36} fontSize={12} fontWeight={700} fill="var(--office-screen-ink)">
              {meetingLine ?? t("zones.meeting.empty")}
            </text>
          </WallScreen>
          <Pendant x={168} y={590} r={62} />
          <Pendant x={432} y={604} r={70} />
          <Pendant x={770} y={598} r={80} />
          <Pendant x={1051} y={640} r={66} />
          {drawn.map((d) => (
            <g key={d.key}>{d.node}</g>
          ))}
          {/* Captions sit in the empty lane north of their zone, so nothing
              stands where they are printed and they can be drawn over the
              paint without ever landing on a head. */}
          {zoneTags.map((g) => (
            <ZoneTag key={g.zone} {...g} />
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
          {memberSprites.map(({ user, pill }) =>
            pill ? (
              <g
                key={`s-${user.userId}`}
                className={user.isSelf && onUserStatusSave ? "cursor-pointer" : undefined}
                onClick={
                  user.isSelf && onUserStatusSave ? openEditor(user.userId) : undefined
                }
              >
                <title>{user.status}</title>
                <rect
                  x={pill.x}
                  y={pill.y}
                  width={pill.w}
                  height={pill.h}
                  rx={pill.h / 2}
                  fill="var(--office-plate)"
                  opacity={pill.set ? 0.75 : 0.95}
                />
                <rect
                  x={pill.x}
                  y={pill.y}
                  width={pill.w}
                  height={pill.h}
                  rx={pill.h / 2}
                  fill="none"
                  stroke="var(--office-plate-line)"
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
                  fill={pill.set ? "var(--office-ink-faint)" : "var(--office-ink)"}
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
      {editing && editingUser && onUserStatusSave ? (
        <OfficeStatusEditor
          anchor={{ x: editing.x, y: editing.y }}
          current={editingUser.user.status}
          t={t}
          onSave={onUserStatusSave}
          onClose={closeEditor}
        />
      ) : null}
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
  const shown = rows.slice(0, 4);
  const max = shown.length > 0 ? Math.max(...shown.map((r) => r.totalTokens)) : 1;
  const title = t("tokens.title");
  const barX = 132;
  const barW = 88;
  return (
    <g>
      <text x={14} y={-h + 20} fontSize={12} fontWeight={700} fill="var(--office-screen-ink)">
        {title}
      </text>
      <text x={20 + estimateTextWidth(title, 12)} y={-h + 20} fontSize={8} fill="var(--office-screen-mute)">
        {t("tokens.window")}
      </text>
      {running ? (
        <text x={w - 14} y={-h + 20} textAnchor="end" fontSize={10} fontWeight={600} fill="var(--office-screen-good)">
          {running}
        </text>
      ) : null}
      <line x1={14} y1={-h + 27} x2={w - 14} y2={-h + 27} stroke="var(--office-screen-line)" strokeWidth={1} />
      {shown.length === 0 ? (
        <text x={14} y={-h + 48} fontSize={9.5} fill="var(--office-screen-mute)">
          {t("tokens.empty")}
        </text>
      ) : (
        shown.map((row, i) => {
          const y = -h + 39 + i * 11.4;
          const agent = agentById.get(row.agentId);
          const pct = Math.max(0.06, row.totalTokens / max);
          return (
            <g key={row.agentId}>
              <text x={14} y={y} fontSize={8} fill="var(--office-screen-mute)">
                {i + 1}
              </text>
              <text x={26} y={y} fontSize={9.5} fontWeight={600} fill="var(--office-screen-ink)">
                {fitText(agent?.name ?? row.agentId.slice(0, 8), barX - 36, 9.5)}
              </text>
              <rect x={barX} y={y - 6.4} width={barW} height={6} rx={3} fill="var(--office-screen-bar)" />
              <rect x={barX} y={y - 6.4} width={barW * pct} height={6} rx={3} fill="var(--office-screen-fill)" />
              <text x={barX + barW + 10} y={y} fontSize={8} fill="var(--office-screen-mute)">
                {t("tokens.tasks", { count: row.taskCount })}
              </text>
              <text
                x={w - 14}
                y={y}
                textAnchor="end"
                fontSize={9}
                fill="var(--office-screen-num)"
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
      <rect x={x} y={y} width={w} height={TAG_H} rx={TAG_H / 2} fill="var(--office-plate)" opacity={0.94} />
      <rect
        x={x}
        y={y}
        width={w}
        height={TAG_H}
        rx={TAG_H / 2}
        fill="none"
        stroke="var(--office-plate-line)"
        strokeOpacity={0.55}
        strokeWidth={0.9}
      />
      <text x={x + 11} y={y + 12} fontSize={10} fontWeight={700} fill="var(--office-ink)">
        {name}
      </text>
      {count > 0 ? (
        <text x={x + 11 + nameW + 7} y={y + 11.6} fontSize={8.5} fontWeight={600} fill="var(--office-ink-mute)">
          {count}
        </text>
      ) : null}
      {hint ? (
        <text x={x + 11 + nameW + countW + TAG_GAP} y={y + 11.6} fontSize={8} fill="var(--office-ink-faint)">
          {hint}
        </text>
      ) : null}
    </g>
  );
}
