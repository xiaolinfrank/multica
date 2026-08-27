// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  BUBBLE_MAX_W,
  estimateTextWidth,
  layoutBubbles,
  measureBubble,
  type BubbleBox,
  type SpriteAnchor,
} from "./office-layout";

function anchor(over: Partial<SpriteAnchor> & { agentId: string }): SpriteAnchor {
  return {
    sx: 0,
    sy: 0,
    clearance: 41,
    labelWidth: 30,
    text: null,
    ...over,
  };
}

function overlaps(a: BubbleBox, b: BubbleBox): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/** The head-and-label column the layout is supposed to keep bubbles off. */
function labelBox(a: SpriteAnchor) {
  return {
    left: a.sx - a.labelWidth / 2 - 2,
    top: a.sy - a.clearance - 1,
    right: a.sx + a.labelWidth / 2 + 2,
    bottom: a.sy,
  };
}

/** The single box a one-speaker layout must have produced. */
function only(boxes: BubbleBox[]): BubbleBox {
  expect(boxes).toHaveLength(1);
  const [box] = boxes;
  if (!box) throw new Error("no box");
  return box;
}

function byId(boxes: BubbleBox[], agentId: string): BubbleBox {
  const box = boxes.find((b) => b.agentId === agentId);
  if (!box) throw new Error(`no box for ${agentId}`);
  return box;
}

/** Every unordered pair, so overlap checks need no index access. */
function pairs(boxes: BubbleBox[]): Array<[BubbleBox, BubbleBox]> {
  return boxes.flatMap((a, i) => boxes.slice(i + 1).map((b): [BubbleBox, BubbleBox] => [a, b]));
}

function sitsOnALabel(box: BubbleBox, anchors: SpriteAnchor[]): boolean {
  return anchors.some((a) => {
    const l = labelBox(a);
    return box.x < l.right && box.x + box.width > l.left && box.y < l.bottom && box.y + box.height > l.top;
  });
}

describe("measureBubble", () => {
  it("keeps a short line on one line and a long one on two", () => {
    expect(measureBubble("干饭要紧").lines).toBe(1);
    expect(measureBubble("这条任务有点意思，快理清思路了，再给我一点时间").lines).toBe(2);
  });

  it("never exceeds the box width the component renders", () => {
    const long = measureBubble("排队中".repeat(40));
    expect(long.width).toBe(BUBBLE_MAX_W);
    expect(long.lines).toBe(2);
  });

  it("counts CJK as full width and latin as roughly half", () => {
    expect(estimateTextWidth("中文", 10)).toBe(20);
    expect(estimateTextWidth("ab", 10)).toBeCloseTo(11.6, 5);
  });
});

describe("layoutBubbles", () => {
  it("leaves a lone speaker at its preferred height", () => {
    const a = anchor({ agentId: "a", sy: 100, text: "干饭要紧" });
    const box = only(layoutBubbles([a]));
    expect(box.y + box.height).toBe(100 - 41 - 6);
  });

  it("gives no box to a sprite with no monologue", () => {
    expect(layoutBubbles([anchor({ agentId: "a", text: null })])).toEqual([]);
  });

  it("stacks two speakers on the same spot instead of overlapping them", () => {
    const boxes = layoutBubbles([
      anchor({ agentId: "a", sx: 0, sy: 100, text: "第一条" }),
      anchor({ agentId: "b", sx: 4, sy: 96, text: "第二条" }),
    ]);
    expect(boxes).toHaveLength(2);
    expect(pairs(boxes).every(([a, b]) => !overlaps(a, b))).toBe(true);
  });

  it("keeps the front-most speaker at its preferred height and lifts the one behind", () => {
    const front = anchor({ agentId: "front", sx: 0, sy: 100, text: "前排" });
    const back = anchor({ agentId: "back", sx: 4, sy: 96, text: "后排" });
    const boxes = layoutBubbles([back, front]);
    const f = byId(boxes, "front");
    expect(f.y + f.height).toBe(100 - 41 - 6);
    expect(byId(boxes, "back").y).toBeLessThan(f.y);
  });

  it("never lands on a neighbour's name label, speaking or not", () => {
    const anchors = [
      anchor({ agentId: "quiet", sx: 10, sy: 60, labelWidth: 40 }),
      anchor({ agentId: "loud", sx: 14, sy: 100, text: "这条任务有点意思" }),
    ];
    expect(sitsOnALabel(only(layoutBubbles(anchors)), anchors)).toBe(false);
  });

  it("produces a collision-free layout for a crowded room", () => {
    const anchors = Array.from({ length: 8 }, (_, i) =>
      anchor({
        agentId: `a${i}`,
        sx: (i % 4) * 18,
        sy: 40 + Math.floor(i / 4) * 26,
        text: `第 ${i} 条内心独白，字数不算少`,
      }),
    );
    const boxes = layoutBubbles(anchors);
    expect(boxes.every((b) => !sitsOnALabel(b, anchors))).toBe(true);
    expect(pairs(boxes).every(([a, b]) => !overlaps(a, b))).toBe(true);
  });

  it("drops what it cannot lift clear rather than stacking into the header", () => {
    // Twenty speakers on one spot cannot all fit in the air above it.
    const anchors = Array.from({ length: 20 }, (_, i) =>
      anchor({ agentId: `a${i}`, sx: 0, sy: 100 - i * 0.1, text: "同一个位置" }),
    );
    const boxes = layoutBubbles(anchors);
    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes.length).toBeLessThan(anchors.length);
    expect(pairs(boxes).every(([a, b]) => !overlaps(a, b))).toBe(true);
  });

  it("is deterministic for the same input", () => {
    const anchors = Array.from({ length: 6 }, (_, i) =>
      anchor({ agentId: `a${i}`, sx: i * 12, sy: 50 + (i % 3) * 8, text: `独白 ${i}` }),
    );
    expect(layoutBubbles(anchors)).toEqual(layoutBubbles(anchors));
  });

  it("does not depend on the order anchors arrive in", () => {
    const anchors = Array.from({ length: 6 }, (_, i) =>
      anchor({ agentId: `a${i}`, sx: i * 12, sy: 50 + (i % 3) * 8, text: `独白 ${i}` }),
    );
    const forward = layoutBubbles(anchors);
    const reversed = layoutBubbles([...anchors].reverse());
    const key = (b: BubbleBox) => `${b.agentId}:${b.x}:${b.y}`;
    expect(forward.map(key).sort()).toEqual(reversed.map(key).sort());
  });
});
