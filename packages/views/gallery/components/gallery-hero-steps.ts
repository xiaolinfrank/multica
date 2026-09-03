/**
 * Index arithmetic for the hero carousel's pager.
 *
 * Its own module rather than an export off the component: the component is a
 * `"use client"` file that pulls in `motion/react` and the dialog primitives,
 * and the canonical test for this matrix needs no DOM. Keeping the rule here
 * lets that test declare `// @vitest-environment node` honestly.
 */

/** Keys the carousel claims. Anything else falls through to the page. */
const NAV_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

/**
 * Whether the carousel owns this key.
 *
 * Separate from resolving it because a blocked move — right arrow on the last
 * plate — is still the carousel's key: it has to be swallowed, or the page
 * scrolls sideways under a reader who thought they were paging.
 */
export function isDiagramNavKey(key: string): boolean {
  return NAV_KEYS.has(key);
}

/**
 * The index `delta` steps from `current`, or null when that would leave the set.
 *
 * Boundaries stop rather than wrap, matching the image sequence in the editor:
 * the picker chips already say how many plates there are and which one is up,
 * so wrapping would only cost a reader the signal that they have seen them all.
 */
export function stepDiagramIndex(
  current: number,
  delta: number,
  total: number,
): number | null {
  if (total <= 0) return null;
  const next = current + delta;
  return next >= 0 && next < total ? next : null;
}

/** The index a navigation key selects, or null when it cannot move. */
export function resolveDiagramKey(
  key: string,
  current: number,
  total: number,
): number | null {
  if (total <= 0) return null;
  switch (key) {
    case "ArrowLeft":
      return stepDiagramIndex(current, -1, total);
    case "ArrowRight":
      return stepDiagramIndex(current, 1, total);
    case "Home":
      return current === 0 ? null : 0;
    case "End":
      return current === total - 1 ? null : total - 1;
    default:
      return null;
  }
}
