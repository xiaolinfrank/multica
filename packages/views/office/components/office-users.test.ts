// @vitest-environment node
// Canonical matrix for the member-side of the office floor: who gets a
// figure and where it stands. Kept beside the helper so the component suite
// only carries the happy path.
import { describe, expect, it } from "vitest";
import type { MemberWithUser } from "@multica/core/types";
import { humanSpot, HUMAN_SPOTS, OFFICE_MEMBER_EMAIL_SUFFIX, toOfficeMembers } from "./office-users";

const member = (userId: string, email: string, over: Partial<MemberWithUser> = {}): MemberWithUser =>
  ({
    id: `mem-${userId}`,
    workspace_id: "ws-1",
    user_id: userId,
    role: "member",
    created_at: "2026-01-01T00:00:00Z",
    name: userId,
    email,
    avatar_url: null,
    custom_status: "",
    ...over,
  }) as MemberWithUser;

describe("toOfficeMembers", () => {
  it("keeps only accounts on the office email domain, case-insensitively", () => {
    const out = toOfficeMembers(
      [
        member("u1", "lin@fosunpharma.com"),
        member("u2", "UPPER@FOSUNPHARMA.COM"),
        member("u3", "bot@example.com"),
        member("u4", "lookalike@fosunpharma.com.evil.test"),
      ],
      "u1",
    );
    expect(out.map((u) => u.userId)).toEqual(["u1", "u2"]);
  });

  it("marks the signed-in viewer and carries name, avatar and status", () => {
    const out = toOfficeMembers(
      [
        member("u1", "a@fosunpharma.com", { name: "Ada", custom_status: "☕", avatar_url: "/f/1" }),
        member("u2", "b@fosunpharma.com"),
      ],
      "u2",
    );
    expect(out[0]).toMatchObject({ userId: "u1", name: "Ada", status: "☕", avatarUrl: "/f/1", isSelf: false });
    expect(out[1]).toMatchObject({ userId: "u2", status: "", isSelf: true });
  });

  it("is not fooled by a suffix that merely contains the domain", () => {
    expect(OFFICE_MEMBER_EMAIL_SUFFIX).toBe("@fosunpharma.com");
    const out = toOfficeMembers([member("u1", "x@notfosunpharma.com")], "u1");
    expect(out).toHaveLength(0);
  });
});
describe("humanSpot", () => {
  it("returns the zone's i-th standing spot, wrapping once it is full", () => {
    expect(humanSpot("desk", 0)).toEqual(HUMAN_SPOTS.desk?.[0]);
    expect(humanSpot("desk", HUMAN_SPOTS.desk?.length ?? 0)).toEqual(HUMAN_SPOTS.desk?.[0]);
    expect(humanSpot("gym", 1)).toEqual(HUMAN_SPOTS.gym?.[1]);
  });

  it("falls back to the desk spots for a zone humans never land in", () => {
    expect(humanSpot("nonsense", 1)).toEqual(HUMAN_SPOTS.desk?.[1]);
  });
});
