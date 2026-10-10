// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cockpitAreaPath, cockpitDestination, cockpitObjectPath } from "./navigation";

describe("cockpit destinations", () => {
  it.each(["", "tab=overview", "tab=unknown", "view=unknown", "node=", "action=orphan"])("opens the bounded work overview for %s", (query) => {
    expect(cockpitDestination(new URLSearchParams(query)).area).toBe("work");
  });
  it("preserves explicit business overview and board sections", () => {
    expect(cockpitDestination(new URLSearchParams("view=operations"))).toMatchObject({ area: "operations", boardTab: "overview" });
    for (const area of ["gantt", "meetings", "changes", "finance"] as const) {
      expect(cockpitDestination(new URLSearchParams(`tab=${area}`))).toMatchObject({ area, boardTab: area });
      expect(cockpitAreaPath("/acme/cockpit", area)).toBe(`/acme/cockpit?tab=${area}`);
    }
    expect(cockpitAreaPath("/acme/cockpit", "operations")).toBe("/acme/cockpit?view=operations");
    expect(cockpitAreaPath("/acme/cockpit", "work")).toBe("/acme/cockpit");
  });
  it("keeps object deep links authoritative and meeting/action targets together", () => {
    expect(cockpitDestination(new URLSearchParams("tab=finance&node=n1"))).toMatchObject({ area: "gantt", nodeId: "n1", meetingId: null });
    expect(cockpitDestination(new URLSearchParams("view=operations&node=n1&meeting=m1&action=a1")))
      .toMatchObject({ area: "meetings", meetingId: "m1", actionId: "a1", nodeId: null });
  });
  it("does not recreate the meeting workspace when only its action target changes", () => {
    const first = cockpitDestination(new URLSearchParams("meeting=m1&action=a1"));
    const second = cockpitDestination(new URLSearchParams("meeting=m1&action=a2"));
    expect(first.key).toBe(second.key);
    expect(first.key).not.toBe(cockpitDestination(new URLSearchParams("meeting=m2")).key);
  });
  it("builds structured object destinations without interpreting data as a URL", () => {
    expect(cockpitObjectPath("/acme/cockpit", { kind: "node", id: "n1" })).toBe("/acme/cockpit?node=n1");
    expect(cockpitObjectPath("/acme/cockpit", { kind: "meeting", id: "m1", actionId: "a1" })).toBe("/acme/cockpit?meeting=m1&action=a1");
    expect(cockpitObjectPath("/acme/cockpit", { kind: "node", id: "n1&meeting=m1" })).toBe("/acme/cockpit?node=n1%26meeting%3Dm1");
  });
  it("opens repair sections without replacing the object's draft or accepting another object's section", () => {
    const nodePath = cockpitObjectPath("/acme/cockpit", { kind: "node", id: "n1", view: "details" });
    expect(nodePath).toBe("/acme/cockpit?node=n1&node_view=details");
    const details = cockpitDestination(new URLSearchParams(nodePath.split("?")[1]));
    expect(details).toMatchObject({ nodeView: "details", meetingView: null });
    expect(details.key).toBe(cockpitDestination(new URLSearchParams("node=n1")).key);
    const materialsPath = cockpitObjectPath("/acme/cockpit", { kind: "meeting", id: "m1", view: "resources" });
    expect(materialsPath).toBe("/acme/cockpit?meeting=m1&meeting_view=resources");
    const materials = cockpitDestination(new URLSearchParams(materialsPath.split("?")[1]));
    expect(materials).toMatchObject({ meetingView: "resources", nodeView: null });
    expect(materials.key).toBe(cockpitDestination(new URLSearchParams("meeting=m1")).key);
    expect(cockpitDestination(new URLSearchParams("meeting=m1&node=n1&node_view=details&meeting_view=unknown")))
      .toMatchObject({ nodeView: null, meetingView: null });
    expect(cockpitDestination(new URLSearchParams("meeting_view=resources&node_view=details")))
      .toMatchObject({ area: "work", nodeView: null, meetingView: null });
  });
});
