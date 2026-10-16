// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cockpitGanttLayout, cockpitTableLayout } from "./cockpit-layout";

describe("cockpit viewport geometry", () => {
  it.each([320, 480, 768, 960])("leaves a usable date window at %ipx, including finance", (width) => {
    for (const finance of [false, true]) {
      const layout = cockpitGanttLayout(width, finance);
      expect(layout.compact).toBe(true);
      expect(layout.treeWidth).toBeLessThanOrEqual(320);
      expect(width - layout.treeWidth).toBeGreaterThanOrEqual(Math.min(width / 2, 320));
    }
  });

  it("uses the full metadata width only when 320px of dates also fit", () => {
    expect(cockpitGanttLayout(999, false).compact).toBe(true);
    expect(cockpitGanttLayout(1000, false)).toEqual({ compact: false, treeWidth: 680 });
    expect(cockpitGanttLayout(1119, true).compact).toBe(true);
    expect(cockpitGanttLayout(1120, true)).toEqual({ compact: false, treeWidth: 800 });
    expect(cockpitGanttLayout(1440, false).treeWidth).toBe(680);
    expect(cockpitGanttLayout(1440, true).treeWidth).toBe(800);
  });

  it("exports full metadata without changing the narrow screen geometry afterwards", () => {
    expect(cockpitGanttLayout(320, true)).toEqual({ compact: true, treeWidth: 160 });
    expect(cockpitGanttLayout(320, true, true)).toEqual({ compact: false, treeWidth: 800 });
    expect(cockpitGanttLayout(320, false, true)).toEqual({ compact: false, treeWidth: 680 });
    expect(cockpitGanttLayout(320, true, false)).toEqual({ compact: true, treeWidth: 160 });
  });

  it("does not start with an oversized sticky tree before measurement", () => {
    expect(cockpitGanttLayout(0, true)).toEqual({ compact: true, treeWidth: 160 });
  });

  it("only freezes the name when business columns have room beside the identity", () => {
    const narrow = cockpitTableLayout(320);
    expect(narrow).toEqual({ codeWidth: 100, nameWidth: 260, pinName: false });
    expect(320 - narrow.codeWidth).toBe(220);
    expect(cockpitTableLayout(679).pinName).toBe(false);
    expect(cockpitTableLayout(680).pinName).toBe(true);
    expect(cockpitTableLayout(1440).pinName).toBe(true);
  });
});
