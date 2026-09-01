// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  assignMemberSeat,
  memberActivityFromIssues,
  type OfficeMemberActivity,
  type SubscriptionActivity,
  STATUS_PRESET_ZONES,
  subscriptionActivity,
  WORK_LINGER_MS,
} from "./index";

const NOW = Date.parse("2026-09-01T12:00:00Z");

function act(userId: string, partial: Partial<OfficeMemberActivity> = {}) {
  return { userId, open: 0, recentlyDone: 0, ...partial };
}

function sub(partial: Partial<SubscriptionActivity> = {}) {
  return { inProgress: 0, lingering: 0, ...partial };
}

describe("subscriptionActivity", () => {
  it("counts in_progress rows as working", () => {
    const a = subscriptionActivity(
      [
        { status_category: "in_progress", status: "in_progress", updated_at: new Date(NOW - 1000).toISOString() },
        { status_category: "in_progress", status: "in_progress", updated_at: new Date(NOW - 60_000).toISOString() },
      ],
      NOW,
    );
    expect(a).toEqual({ inProgress: 2, lingering: 0 });
  });

  it("lingers when a running-category row was updated inside the window", () => {
    for (const category of ["in_review", "done", "cancelled", "blocked"]) {
      const a = subscriptionActivity(
        [{ status_category: category, status: category, updated_at: new Date(NOW - WORK_LINGER_MS + 1000).toISOString() }],
        NOW,
      );
      expect(a.lingering).toBe(1);
    }
  });

  it("stops lingering once the window has passed", () => {
    const a = subscriptionActivity(
      [{ status_category: "done", status: "done", updated_at: new Date(NOW - WORK_LINGER_MS - 1000).toISOString() }],
      NOW,
    );
    expect(a).toEqual({ inProgress: 0, lingering: 0 });
  });

  it("never counts not-yet-started rows as lingering", () => {
    for (const category of ["todo", "backlog"]) {
      const a = subscriptionActivity(
        [{ status_category: category, status: category, updated_at: new Date(NOW - 1000).toISOString() }],
        NOW,
      );
      expect(a).toEqual({ inProgress: 0, lingering: 0 });
    }
  });

  it("falls back to the raw status when the category is missing", () => {
    const a = subscriptionActivity(
      [
        { status: "in_progress", updated_at: new Date(NOW - 1000).toISOString() },
        { status: "custom_done_status", updated_at: new Date(NOW - 1000).toISOString() },
      ],
      NOW,
    );
    // A custom status key without a category is unknown — only the raw
    // in_progress key is recognizable.
    expect(a).toEqual({ inProgress: 1, lingering: 0 });
  });

  it("ignores rows with unparsable updated_at", () => {
    const a = subscriptionActivity(
      [{ status_category: "done", status: "done", updated_at: "not a date" }],
      NOW,
    );
    expect(a).toEqual({ inProgress: 0, lingering: 0 });
  });
});

describe("assignMemberSeat", () => {
  it("seats a member with an in-progress subscription at a desk", () => {
    const seat = assignMemberSeat(act("u1"), 0, { subscriptions: sub({ inProgress: 2 }) });
    expect(seat.zone).toBe("desk");
    expect(seat.monologue).toMatchObject({ kind: "human", mood: "working" });
  });

  it("keeps a lingering member at the desk", () => {
    const seat = assignMemberSeat(act("u1", { open: 3 }), 0, { subscriptions: sub({ lingering: 1 }) });
    expect(seat.zone).toBe("desk");
  });

  it("seats open backlog in the waiting corner", () => {
    const seat = assignMemberSeat(act("u1", { open: 2 }), 0);
    expect(seat.zone).toBe("waiting");
    expect(seat.monologue).toMatchObject({ kind: "human", mood: "waiting" });
  });

  it("rotates idle members through the relax zones with the phase", () => {
    const zones = new Set(
      Array.from({ length: 40 }, (_, p) => assignMemberSeat(act("u1"), p).zone),
    );
    expect([...zones].every((z) => (["lounge", "tea", "canteen", "gym"] as const).includes(z as never))).toBe(true);
    expect(zones.size).toBeGreaterThan(1);
  });

  it("holds the desk mood stable across phases while working", () => {
    const seat = assignMemberSeat(act("u1"), 7, { subscriptions: sub({ inProgress: 1 }) });
    expect(seat.monologue).toMatchObject({ kind: "human", mood: "working" });
  });

  describe("manual status presets", () => {
    it("routes each preset key to its zone and outranks subscriptions", () => {
      const entries = Object.entries(STATUS_PRESET_ZONES);
      expect(entries).toEqual(
        expect.arrayContaining([
          ["focus", "desk"],
          ["meeting", "meeting"],
          ["gym", "gym"],
          ["coffee", "canteen"],
          ["vacation", "absent"],
        ]),
      );
      for (const [key, zone] of entries) {
        const seat = assignMemberSeat(act("u1", { open: 5 }), 3, {
          subscriptions: sub({ inProgress: 4 }),
          statusKey: key,
        });
        expect(seat.zone).toBe(zone);
      }
    });

    it("drops the figure and the monologue entirely when absent", () => {
      const seat = assignMemberSeat(act("u1"), 0, { statusKey: "vacation" });
      expect(seat.zone).toBe("absent");
      expect(seat.monologue).toBeNull();
    });

    it("gives a manual meeting a meeting monologue", () => {
      const seat = assignMemberSeat(act("u1"), 0, { statusKey: "meeting" });
      expect(seat.monologue).toMatchObject({ kind: "human", mood: "meeting" });
      expect(seat.monologue?.variant).toBeLessThan(2);
    });

    it("ignores unknown keys (free-text statuses fall back to default seating)", () => {
      const seat = assignMemberSeat(act("u1"), 0, { statusKey: "" });
      expect(["lounge", "tea", "canteen", "gym"]).toContain(seat.zone);
    });
  });
});

describe("memberActivityFromIssues", () => {
  it("buckets assigned issues by status category", () => {
    const m = memberActivityFromIssues(["u1", "u2"], [
      { assignee_type: "member", assignee_id: "u1", status_category: "todo", status: "todo" },
      { assignee_type: "member", assignee_id: "u1", status_category: "done", status: "done" },
      { assignee_type: "agent", assignee_id: "a1", status_category: "in_progress", status: "in_progress" },
      { assignee_type: "member", assignee_id: "u2", status_category: "in_progress", status: "in_progress" },
    ]);
    // in-progress rows are subscription territory now; the assigned bucket
    // only owes the not-yet-started backlog and the terminal window.
    expect(m.get("u1")).toEqual({ userId: "u1", open: 1, recentlyDone: 1 });
    expect(m.get("u2")).toEqual({ userId: "u2", open: 0, recentlyDone: 0 });
  });

  it("ignores rows with no recognized assignee", () => {
    const m = memberActivityFromIssues(["u1"], [
      { assignee_type: "member", assignee_id: "ghost", status_category: "todo", status: "todo" },
    ]);
    expect(m.get("u1")).toEqual({ userId: "u1", open: 0, recentlyDone: 0 });
  });
});
