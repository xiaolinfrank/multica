// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  isDiagramNavKey,
  resolveDiagramKey,
  stepDiagramIndex,
} from "./gallery-hero-steps";

// Canonical file for the pager's index rule. The component suite mounts the
// carousel and asserts the wiring; the matrix of "which key lands where" lives
// here, where it needs no DOM.

describe("stepDiagramIndex", () => {
  it("walks the set one plate at a time", () => {
    expect(stepDiagramIndex(0, 1, 3)).toBe(1);
    expect(stepDiagramIndex(1, 1, 3)).toBe(2);
    expect(stepDiagramIndex(2, -1, 3)).toBe(1);
    expect(stepDiagramIndex(1, -1, 3)).toBe(0);
  });

  it("stops at the boundaries instead of wrapping, so the arrows can disable", () => {
    expect(stepDiagramIndex(0, -1, 3)).toBeNull();
    expect(stepDiagramIndex(2, 1, 3)).toBeNull();
  });

  it("has nowhere to go in an empty or single-plate set", () => {
    expect(stepDiagramIndex(0, 1, 0)).toBeNull();
    expect(stepDiagramIndex(0, -1, 0)).toBeNull();
    expect(stepDiagramIndex(0, 1, 1)).toBeNull();
  });
});

describe("isDiagramNavKey", () => {
  it("claims the four keys the carousel pages with", () => {
    for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
      expect(isDiagramNavKey(key)).toBe(true);
    }
  });

  it("leaves everything else to the page", () => {
    for (const key of ["ArrowUp", "ArrowDown", "Tab", "Enter", " ", "PageDown", "a"]) {
      expect(isDiagramNavKey(key)).toBe(false);
    }
  });

  // The carousel swallows its own keys even when the move is blocked; without
  // that, a right arrow on the last plate would scroll the page under a reader
  // who thought they were paging. So "is ours" and "can move" are two
  // questions, and a blocked key must still answer true here.
  it("still claims a key whose move is blocked", () => {
    expect(isDiagramNavKey("ArrowRight")).toBe(true);
    expect(resolveDiagramKey("ArrowRight", 2, 3)).toBeNull();
  });
});

describe("resolveDiagramKey", () => {
  it("maps the arrows onto a step", () => {
    expect(resolveDiagramKey("ArrowRight", 0, 3)).toBe(1);
    expect(resolveDiagramKey("ArrowLeft", 1, 3)).toBe(0);
  });

  it("jumps to the ends with Home and End", () => {
    expect(resolveDiagramKey("Home", 2, 3)).toBe(0);
    expect(resolveDiagramKey("End", 0, 3)).toBe(2);
  });

  it("returns null when the reader is already there", () => {
    expect(resolveDiagramKey("Home", 0, 3)).toBeNull();
    expect(resolveDiagramKey("End", 2, 3)).toBeNull();
  });

  it("returns null for a key it does not own and for an empty set", () => {
    expect(resolveDiagramKey("ArrowUp", 0, 3)).toBeNull();
    expect(resolveDiagramKey("ArrowRight", 0, 0)).toBeNull();
  });
});
