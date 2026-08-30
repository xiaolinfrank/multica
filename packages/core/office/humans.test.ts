// @vitest-environment node
// Canonical matrix for human seating in the Agent Office: which zone a
// member lands in from their issue activity, and which monologue slot they
// draw. The component suite only keeps the happy path.
import { describe, expect, it } from "vitest";
import { assignMemberSeat, memberActivityFromIssues, RELAX_ZONES } from "./index";

const act = (
  userId: string,
  over: Partial<{ inProgress: number; open: number; recentlyDone: number }> = {},
) => ({ userId, inProgress: 0, open: 0, recentlyDone: 0, ...over });

describe("assignMemberSeat", () => {
  it("seats a member with work in progress at the desks", () => {
    const seat = assignMemberSeat(act("u1", { inProgress: 2, open: 3 }), 0);
    expect(seat.zone).toBe("desk");
    expect(seat.monologue.kind).toBe("human");
    if (seat.monologue.kind === "human") {
      expect(seat.monologue.mood).toBe("working");
    }
  });

  it("seats a member with only open work in the waiting area", () => {
    const seat = assignMemberSeat(act("u1", { open: 2 }), 0);
    expect(seat.zone).toBe("waiting");
    if (seat.monologue.kind === "human") {
      expect(seat.monologue.mood).toBe("waiting");
    }
  });

  it("rotates an idle member through every leisure zone across phases", () => {
    for (const zone of RELAX_ZONES) {
      const hit = Array.from({ length: RELAX_ZONES.length * 6 }, (_, p) =>
        assignMemberSeat(act("u1"), p).zone,
      ).includes(zone);
      expect(hit, zone).toBe(true);
    }
  });

  it("keeps the monologue variant inside the mood's bounds", () => {
    for (let p = 0; p < 12; p++) {
      const seat = assignMemberSeat(act("u1", { inProgress: 1 }), p);
      if (seat.monologue.kind === "human") {
        expect(seat.monologue.variant).toBeLessThan(3);
      }
      const idle = assignMemberSeat(act("u1"), p);
      if (idle.monologue.kind === "human") {
        expect(idle.monologue.variant).toBeLessThan(2);
      }
    }
  });
});

describe("memberActivityFromIssues", () => {
  const issue = (assignee: string, category: string | null) => ({
    assignee_type: "member",
    assignee_id: assignee,
    status: category ?? "todo",
    ...(category === null ? {} : { status_category: category }),
  });

  it("counts in-progress, open and finished work per member", () => {
    const m = memberActivityFromIssues(["u1", "u2"], [
      issue("u1", "in_progress"),
      issue("u1", "todo"),
      issue("u1", "done"),
      issue("u1", "cancelled"),
      issue("u2", "blocked"),
      issue("ghost", "in_progress"),
    ]);
    expect(m.get("u1")).toEqual({ userId: "u1", inProgress: 1, open: 1, recentlyDone: 2 });
    expect(m.get("u2")).toEqual({ userId: "u2", inProgress: 0, open: 1, recentlyDone: 0 });
    expect(m.has("ghost")).toBe(false);
  });

  it("falls back to status when status_category is missing", () => {
    const m = memberActivityFromIssues(["u1"], [
      { assignee_type: "member", assignee_id: "u1", status: "done" },
    ]);
    expect(m.get("u1")).toEqual({ userId: "u1", inProgress: 0, open: 0, recentlyDone: 1 });
  });

  it("ignores issues assigned to agents or to nobody", () => {
    const m = memberActivityFromIssues(["u1"], [
      { assignee_type: "agent", assignee_id: "a1", status: "in_progress" },
      { assignee_type: "member", assignee_id: null, status: "in_progress" },
    ]);
    expect(m.get("u1")).toEqual({ userId: "u1", inProgress: 0, open: 0, recentlyDone: 0 });
  });
});
