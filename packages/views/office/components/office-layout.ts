// Pure geometry for the thought-bubble layer.
//
// Bubbles are the only part of the scene that is not depth-sorted: they float
// above the room, so nothing else can push them out of the way. Left to
// themselves they land on each other and on neighbouring name labels, which is
// exactly the "the monologue covers the agent" complaint. Every bubble is
// therefore placed against the boxes already placed, and against the head-and-
// label column of every sprite in the room — including sprites that are not
// speaking.
//
// The arithmetic lives here rather than in the component so the boundary cases
// (dense rooms, long monologues, a bubble that cannot be lifted clear) can be
// tested without mounting an SVG. Units are SVG user units of the floor scene.

/** Font size of a sprite's name label, mirrored from office-view.tsx. */
export const NAME_FONT = 8.5;

/** 1234 → "1.2K", 5600000 → "5.6M" — compact enough for a bar label. */
export function formatTokenCount(n: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact" }).format(n);
}

/** Font size, line box and outer width of a bubble, mirrored from the JSX. */
export const BUBBLE_FONT = 9;
const BUBBLE_LINE_H = BUBBLE_FONT * 1.25;
export const BUBBLE_MAX_W = 140;
/** px-1.5 / py-1 plus the 1px border, in CSS pixels = SVG units here. */
const PAD_X = 6;
const PAD_Y = 4;
const BORDER = 1;
const CONTENT_MAX_W = BUBBLE_MAX_W - (PAD_X + BORDER) * 2;

/** Breathing room kept above a label and between stacked bubbles. */
const GAP = 6;
/** A bubble that would have to climb further than this is dropped instead. */
const MAX_LIFT = 132;

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Rough advance width of a string. CJK and full-width punctuation are square;
 * latin runs about 0.58em on average. Deliberately generous: over-estimating
 * costs a few units of empty space, under-estimating lets a bubble grow a line
 * it was not measured for and clip.
 */
export function estimateTextWidth(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text) {
    // CJK radicals through unified ideographs, Hangul, and fullwidth forms.
    w += /[⺀-鿿가-힯＀-￠]/.test(ch) ? fontSize : fontSize * 0.58;
  }
  return w;
}

/**
 * Longest prefix of `text` that fits `maxWidth`, with an ellipsis when it had
 * to cut. Seats in a crowded room are closer together than a full agent name
 * is wide, so a name label is trimmed to its own slot rather than allowed to
 * run into its neighbour's.
 */
export function fitText(text: string, maxWidth: number, fontSize: number): string {
  if (estimateTextWidth(text, fontSize) <= maxWidth) return text;
  const chars = [...text];
  const ellipsis = estimateTextWidth("…", fontSize);
  let width = 0;
  let cut = 0;
  while (cut < chars.length) {
    const next = width + estimateTextWidth(chars[cut] as string, fontSize);
    if (next + ellipsis > maxWidth) break;
    width = next;
    cut += 1;
  }
  // Below one character plus the ellipsis there is nothing worth showing.
  return cut === 0 ? "" : `${chars.slice(0, cut).join("")}…`;
}

/**
 * Outer size of the rendered bubble. The component keeps a one-line bubble on
 * a single line and clamps a longer one to two, so these numbers are what the
 * browser actually paints rather than an approximation of it.
 */
export function measureBubble(text: string): { width: number; height: number; lines: 1 | 2 } {
  const ink = estimateTextWidth(text, BUBBLE_FONT);
  const lines: 1 | 2 = ink > CONTENT_MAX_W ? 2 : 1;
  const width =
    lines === 2 ? BUBBLE_MAX_W : Math.min(BUBBLE_MAX_W, ink + (PAD_X + BORDER) * 2);
  const height = lines * BUBBLE_LINE_H + (PAD_Y + BORDER) * 2;
  return { width, height, lines };
}

/** One seated or standing sprite, and the monologue it wants to float. */
export interface SpriteAnchor {
  agentId: string;
  /** Floor point of the sprite, in scene units. */
  sx: number;
  sy: number;
  /** Height above sy of the tallest ink the sprite draws (its name label). */
  clearance: number;
  /** Rendered width of that name label. */
  labelWidth: number;
  /** Monologue to float above this sprite, or null for none. */
  text: string | null;
  /**
   * How far this bubble may climb before it is dropped instead. Each room is a
   * closed box, so a bubble that would rise through its own ceiling into the
   * room above is worse than no bubble; the caller passes the headroom its
   * room actually has. Defaults to {@link MAX_LIFT}.
   */
  maxLift?: number;
}

export interface BubbleBox {
  agentId: string;
  text: string;
  /** Left edge and top edge of the box, in scene units. */
  x: number;
  y: number;
  width: number;
  height: number;
  lines: 1 | 2;
}

function hits(box: Rect, others: readonly Rect[]): Rect | null {
  for (const o of others) {
    if (box.left < o.right && box.right > o.left && box.top < o.bottom && box.bottom > o.top) {
      return o;
    }
  }
  return null;
}

/**
 * Places a bubble above each speaking sprite, lifting it until it clears every
 * sprite's label and every bubble already placed.
 *
 * Front-most sprites are served first (largest sy), so the bubbles that lift
 * are the ones further back, where the empty air above the room is. A bubble
 * that cannot be placed within MAX_LIFT is dropped: showing five readable
 * monologues beats stacking eight into an unreadable column.
 *
 * `reserved` holds anything else in the scene a bubble must not cover, such as
 * the running-capacity badge. `bounds` is the box a bubble has to stay inside:
 * without its sides the leftmost and rightmost sprites push their bubbles off
 * the edge of the scene, where the frame clips them mid-sentence, and without
 * `top` a sprite in the back row lifts its bubble straight through the north
 * wall — `maxLift` caps how far a bubble climbs, not where it ends up.
 */
export function layoutBubbles(
  anchors: readonly SpriteAnchor[],
  reserved: readonly Rect[] = [],
  bounds?: { left: number; right: number; top?: number },
): BubbleBox[] {
  // A bubble is centred on its sprite, and the sprites at the far ends of the
  // scene sit closer to the edge than half a bubble is wide. Slide it back
  // inside before anything is tested against it, so what collision avoidance
  // sees is where the box will actually be painted.
  const clampX = (left: number, width: number): number => {
    if (!bounds) return left;
    return Math.max(bounds.left, Math.min(left, bounds.right - width));
  };

  // Every sprite blocks, whether or not it is speaking — the whole point is to
  // keep a bubble off a *neighbour's* head.
  const blockers: Rect[] = anchors.map((a) => ({
    left: a.sx - a.labelWidth / 2 - 2,
    top: a.sy - a.clearance - 1,
    right: a.sx + a.labelWidth / 2 + 2,
    bottom: a.sy,
  }));
  blockers.push(...reserved);

  const speakers = anchors
    .filter((a): a is SpriteAnchor & { text: string } => Boolean(a.text))
    .sort((a, b) => b.sy - a.sy || a.sx - b.sx || (a.agentId < b.agentId ? -1 : 1));

  const placed: Rect[] = [];
  const out: BubbleBox[] = [];

  for (const a of speakers) {
    const m = measureBubble(a.text);
    const left = clampX(a.sx - m.width / 2, m.width);
    const preferred = a.sy - a.clearance - GAP;
    const lift = a.maxLift ?? MAX_LIFT;
    let bottom = preferred;
    let settled = false;

    // Park directly above whatever is in the way and re-test. Each step moves
    // strictly upwards past one blocker, so this terminates; the guard only
    // covers pathological input.
    for (let guard = 0; guard <= blockers.length + placed.length + 1; guard++) {
      const top = bottom - m.height;
      // The ceiling is tested before the blockers: a box that has already left
      // the room cannot be rescued by moving it further up, and leaving
      // `settled` false is what drops it.
      if (top < (bounds?.top ?? -Infinity)) break;
      const box: Rect = { left, top, right: left + m.width, bottom };
      const hit = hits(box, blockers) ?? hits(box, placed);
      if (!hit) {
        settled = true;
        break;
      }
      bottom = hit.top - GAP;
      if (preferred - bottom > lift) break;
    }

    if (!settled || preferred - bottom > lift) continue;

    placed.push({ left, top: bottom - m.height, right: left + m.width, bottom });
    out.push({
      agentId: a.agentId,
      text: a.text,
      x: left,
      y: bottom - m.height,
      width: m.width,
      height: m.height,
      lines: m.lines,
    });
  }

  return out;
}
