// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cockpitArtifactPath, cockpitArtifactReturn, cockpitMeetingContextPath, cockpitAreaPath, cockpitDestination, cockpitObjectPath, cockpitScope, cockpitScopedPath, cockpitShellDestination, cockpitSurfacePath } from "./navigation";

describe("cockpit destinations", () => {
  it("returns to the original acceptance scope after opening an externally owned artifact", () => {
    const origin = { projectId: "target-project", moduleId: "target-module" };
    const first = cockpitArtifactPath("/acme/cockpit", "artifact-1", origin, "version-1", { nodeId: "target-node", view: "acceptance", requestId: "request-1" });
    const back = cockpitArtifactReturn(new URLSearchParams(first.split("?")[1]));
    expect(back?.scope).toEqual(origin);
    const ownerPath = cockpitArtifactPath("/acme/cockpit", "artifact-1", { projectId: "owner-project", moduleId: "owner-module" }, "version-1", back);
    const restored = cockpitArtifactReturn(new URLSearchParams(ownerPath.split("?")[1]));
    expect(restored).toEqual(back);
    expect(cockpitObjectPath("/acme/cockpit", { kind: "node", id: restored!.nodeId, view: restored!.view, requestId: restored!.requestId }, restored!.scope)).toBe("/acme/cockpit?node=target-node&node_view=acceptance&acceptance=request-1&project=target-project&module=target-module");
  });
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

describe("unified cockpit destinations", () => {
  it("carries project/module scope across primary tabs while removing stale object selections", () => {
    const scope = { projectId: "project-a", moduleId: "module-b" };
    expect(cockpitSurfacePath("/acme/cockpit", "meetings", scope)).toBe("/acme/cockpit?tab=meetings&project=project-a&module=module-b");
    expect(cockpitSurfacePath("/acme/cockpit", "plan", scope, "finance")).toBe("/acme/cockpit?tab=plan&plan_view=finance&project=project-a&module=module-b");
    expect(cockpitScopedPath("/acme/cockpit", new URLSearchParams("meeting=m1&meeting_view=resources&project=old"), scope))
      .toBe("/acme/cockpit?meeting=m1&meeting_view=resources&project=project-a&module=module-b");
    expect(cockpitObjectPath("/acme/cockpit", { kind: "node", id: "n1", view: "details", planView: "responsibility" }, scope))
      .toBe("/acme/cockpit?node=n1&node_view=details&plan_view=responsibility&project=project-a&module=module-b");
  });

  it("does not silently turn an invalid module-only or unknown resource scope into all projects", () => {
    expect(cockpitScope(new URLSearchParams("module=unknown"))).toEqual({ projectId: null, moduleId: "unknown" });
    expect(cockpitShellDestination(new URLSearchParams("tab=plan&project=deleted&module=foreign")))
      .toMatchObject({ surface: "plan", scope: { projectId: "deleted", moduleId: "foreign" } });
  });

  it("maps existing public links to the same five surfaces without losing object precedence", () => {
    expect(cockpitShellDestination(new URLSearchParams("view=operations"))).toMatchObject({ surface: "plan", planView: "operations" });
    expect(cockpitShellDestination(new URLSearchParams("tab=finance"))).toMatchObject({ surface: "plan", planView: "finance" });
    expect(cockpitShellDestination(new URLSearchParams("tab=changes"))).toMatchObject({ surface: "governance", governanceView: "changes" });
    expect(cockpitShellDestination(new URLSearchParams("tab=artifacts&node=n1&meeting=m1"))).toMatchObject({ surface: "meetings" });
    expect(cockpitShellDestination(new URLSearchParams("tab=plan&plan_view=unknown"))).toMatchObject({ surface: "plan", planView: "gantt" });
  });
});

  it("keeps a filtered register and the selected action across same-meeting workbench tabs, then closes to that register", () => {
    const scope = { projectId: "project", moduleId: "module" };
    const source = new URLSearchParams("meeting=m1&action=a1&meeting_nodes=n1,n2&from=2026-10-01&to=2026-10-02&artifact=unrelated");
    const resources = new URL(cockpitMeetingContextPath("/acme/cockpit", "m1", scope, source, "resources"), "https://example.test");
    expect(resources.searchParams.get("action")).toBe("a1"); expect(resources.searchParams.get("meeting_view")).toBe("resources"); expect(resources.searchParams.get("meeting_nodes")).toBe("n1,n2"); expect(resources.searchParams.has("artifact")).toBe(false);
    const closed = new URL(cockpitMeetingContextPath("/acme/cockpit", null, scope, resources.searchParams), "https://example.test");
    expect(closed.searchParams.get("tab")).toBe("meetings"); expect(closed.searchParams.get("from")).toBe("2026-10-01"); expect(closed.searchParams.get("module")).toBe("module"); expect(closed.searchParams.has("meeting")).toBe(false); expect(closed.searchParams.has("action")).toBe(false);
  });
