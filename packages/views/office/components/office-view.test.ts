// @vitest-environment node
import { describe, expect, it } from "vitest";
import { BADGE_LIFT, HEAD_R, HEAD_Z, headClearance, NAME_LIFT } from "./office-view";
import { NAME_FONT } from "./office-layout";

// Geometry invariants for the ink a sprite draws above its own head. These are
// plain arithmetic on exported constants, so they live here rather than in the
// component suite — nothing needs to mount to know that a badge pill and the
// name label under it overlap.

/** Halo stroke painted under a name label, mirrored from Person/HumanFigure. */
const LABEL_HALO = 2.8;

describe("badge and label stacking", () => {
  it("keeps the badge pill clear of the name label's haloed ascender", () => {
    // Both are measured from the head's centre, upwards.
    const pillBottom = HEAD_R + BADGE_LIFT - 15;
    const labelTop = HEAD_R + 5 + NAME_FONT + LABEL_HALO / 2;
    expect(pillBottom).toBeGreaterThan(labelTop);
  });
});

describe("headClearance", () => {
  it("reserves more room for a badge than a label, and more for a label than neither", () => {
    const badged = headClearance(HEAD_Z, true, true);
    const labelled = headClearance(HEAD_Z, true, false);
    const bare = headClearance(HEAD_Z, false, false);
    expect(badged).toBeGreaterThan(labelled);
    expect(labelled).toBeGreaterThan(bare);
  });

  it("tracks the badge and label lifts it is derived from", () => {
    expect(headClearance(HEAD_Z, true, true) - headClearance(HEAD_Z, true, false)).toBeCloseTo(
      BADGE_LIFT - NAME_LIFT,
    );
  });
});
