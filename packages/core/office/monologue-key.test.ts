// @vitest-environment node
// Pins the slot → key mapping against the shape of the `office` locale
// bundle. If a locale restructures `monologue.*`, this fails before any UI
// renders a missing string.
import { describe, expect, it } from "vitest";
import { monologueMessage } from "./monologue-key";
import type { MonologueSlot } from "./types";

describe("monologueMessage", () => {
  it("addresses every slot kind with params where the copy interpolates", () => {
    const cases: [MonologueSlot, string, Record<string, number> | undefined][] = [
      [{ kind: "working", variant: 3, runningCount: 2 }, "monologue.working.3", { count: 2 }],
      [{ kind: "queued", variant: 1, queuedCount: 4 }, "monologue.queued.1", { count: 4 }],
      [{ kind: "waiting", variant: 0, queuedCount: 1 }, "monologue.waiting.0", { count: 1 }],
      [{ kind: "idle", variant: 2, zone: "tea" }, "monologue.idle.tea.2", undefined],
      [{ kind: "meeting", variant: 1 }, "monologue.meeting.1", undefined],
    [{ kind: "captain", variant: 2 }, "monologue.captain.2", undefined],
      [{ kind: "completed", variant: 0, count: 5 }, "monologue.completed.0", { count: 5 }],
      [{ kind: "failed", variant: 1 }, "monologue.failed.1", undefined],
      [{ kind: "offline", variant: 0 }, "monologue.offline.0", undefined],
      [{ kind: "unbound", variant: 0 }, "monologue.unbound.0", undefined],
    ];
    for (const [slot, key, params] of cases) {
      expect(monologueMessage(slot)).toEqual({ key, ...(params ? { params } : {}) });
    }
  });
});
