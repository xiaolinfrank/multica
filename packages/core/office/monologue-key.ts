// MonologueSlot → i18n address. Kept in core (not beside the component)
// because the key/params mapping is pure and unit-tested against the
// locale bundle shape — see monologue-key.test.ts. The views layer only
// supplies the `t` function.
import type { MonologueSlot } from "./types";

export interface MonologueMessage {
  /** Key under the `office` namespace, e.g. `monologue.working.2`. */
  key: string;
  /** Interpolation params for i18next, if any. */
  params?: Record<string, number>;
}

export function monologueMessage(slot: MonologueSlot): MonologueMessage {
  switch (slot.kind) {
    case "working":
      return { key: `monologue.working.${slot.variant}`, params: { count: slot.runningCount } };
    case "queued":
      return { key: `monologue.queued.${slot.variant}`, params: { count: slot.queuedCount } };
    case "waiting":
      return { key: `monologue.waiting.${slot.variant}`, params: { count: slot.queuedCount } };
    case "idle":
      return { key: `monologue.idle.${slot.zone}.${slot.variant}` };
    case "meeting":
      return { key: `monologue.meeting.${slot.variant}` };
    case "pmo":
      return { key: `monologue.pmo.${slot.variant}` };
    case "completed":
      return { key: `monologue.completed.${slot.variant}`, params: { count: slot.count } };
    case "failed":
      return { key: `monologue.failed.${slot.variant}` };
    case "offline":
      return { key: `monologue.offline.${slot.variant}` };
    case "unbound":
      return { key: `monologue.unbound.${slot.variant}` };
    case "human":
      return slot.mood === "idle"
        ? { key: `monologue.human.idle.${slot.zone ?? "lounge"}.${slot.variant}` }
        : { key: `monologue.human.${slot.mood}.${slot.variant}` };
  }
}
