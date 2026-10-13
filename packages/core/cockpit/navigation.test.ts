// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cockpitMeetingDirectoryPath, cockpitArtifactPath, cockpitArtifactReturn, cockpitMeetingContextPath, cockpitMeetingAgendaPath, cockpitMeetingPreparationPath, cockpitAreaPath, cockpitDestination, cockpitObjectPath, cockpitScope, cockpitScopedPath, cockpitShellDestination, cockpitSurfacePath } from "./navigation";

describe("cockpit destinations", () => {
  it("keeps directory plans distinct from preparation instances and prevents cross-meeting carryover", () => {
    const source = new URLSearchParams("meeting=m1&agenda=a1&preparation=p1&project=pr1&meeting_archive=all&from=2026-10-01");
    const opened = new URL(cockpitMeetingDirectoryPath("/acme/cockpit", "m1", "d1", source), "https://example.test");
    expect(cockpitDestination(opened.searchParams)).toMatchObject({ meetingId: "m1", meetingView: "resources", directoryOperationId: "d1", preparationId: "p1", agendaId: "a1" });
    expect(cockpitDestination(opened.searchParams).key).toBe(cockpitDestination(source).key);
    const agenda = new URL(cockpitMeetingContextPath("/acme/cockpit", "m1", cockpitScope(source), opened.searchParams, "agenda"), "https://example.test");
    expect(agenda.searchParams.get("directory_operation")).toBe("d1");
    const closed = new URL(cockpitMeetingDirectoryPath("/acme/cockpit", "m1", null, opened.searchParams), "https://example.test");
    expect(closed.searchParams.has("directory_operation")).toBe(false);
    expect(closed.searchParams.get("preparation")).toBe("p1");
    expect(closed.searchParams.get("meeting_archive")).toBe("all");
    expect(closed.searchParams.get("from")).toBe("2026-10-01");
    const other = new URL(cockpitMeetingDirectoryPath("/acme/cockpit", "m2", "d2", opened.searchParams), "https://example.test");
    expect(other.searchParams.has("agenda")).toBe(false); expect(other.searchParams.has("preparation")).toBe(false);
    for (const path of [cockpitMeetingAgendaPath("/acme/cockpit", "m2", "a2", opened.searchParams), cockpitMeetingPreparationPath("/acme/cockpit", "m2", "p2", opened.searchParams)]) {
      expect(new URL(path, "https://example.test").searchParams.has("directory_operation")).toBe(false);
    }
    expect(cockpitDestination(new URLSearchParams("directory_operation=orphan")).directoryOperationId).toBeNull();
    expect(cockpitObjectPath("/acme/cockpit", { kind: "meeting", id: "m1", directoryOperationId: "d1" })).toBe("/acme/cockpit?meeting=m1&directory_operation=d1&meeting_view=resources");
  });
  it("returns from a preparation instance to its topic without transferring it to another meeting", () => {
    const source = new URLSearchParams("meeting=m1&agenda=topic-1&action=a1&project=p1&from=2026-10-01&custom_filter=kept");
    const opened = new URL(cockpitMeetingPreparationPath("/acme/cockpit", "m1", "operation-1", source), "https://example.test");
    const destination = cockpitDestination(opened.searchParams);
    expect(destination).toMatchObject({ meetingId: "m1", agendaId: "topic-1", preparationId: "operation-1", meetingView: "preparation" });
    expect(destination.key).toBe(cockpitDestination(source).key);
    const materials = new URL(cockpitMeetingContextPath("/acme/cockpit", "m1", cockpitScope(source), opened.searchParams, "resources"), "https://example.test");
    expect(materials.searchParams.get("preparation")).toBe("operation-1");
    const closed = new URL(cockpitMeetingPreparationPath("/acme/cockpit", "m1", null, opened.searchParams), "https://example.test");
    expect(closed.searchParams.has("preparation")).toBe(false);
    expect(closed.searchParams.get("agenda")).toBe("topic-1");
    expect(closed.searchParams.get("custom_filter")).toBe("kept");
    const topic = new URL(cockpitMeetingAgendaPath("/acme/cockpit", "m1", "topic-2", opened.searchParams), "https://example.test");
    expect(topic.searchParams.has("preparation")).toBe(false);
    const other = new URL(cockpitMeetingPreparationPath("/acme/cockpit", "m2", "operation-2", opened.searchParams), "https://example.test");
    expect(other.searchParams.has("agenda")).toBe(false); expect(other.searchParams.has("action")).toBe(false);
    expect(cockpitDestination(new URLSearchParams("preparation=orphan")).preparationId).toBeNull();
  });
  it("opens and closes an agenda topic without losing filters or recreating the meeting workspace", () => {
    const source = new URLSearchParams("meeting=m1&action=a1&project=p1&meeting_nodes=n1,n2&from=2026-10-01&custom_filter=kept&artifact=old&node=old");
    const opened = new URL(cockpitMeetingAgendaPath("/acme/cockpit", "m1", "agenda-1", source), "https://example.test");
    const destination = cockpitDestination(opened.searchParams);
    expect(destination).toMatchObject({ meetingId: "m1", agendaId: "agenda-1", meetingView: "preparation", actionId: "a1", nodeId: null });
    expect(destination.key).toBe(cockpitDestination(new URLSearchParams("meeting=m1")).key);
    expect(opened.searchParams.get("custom_filter")).toBe("kept");
    expect(opened.searchParams.has("artifact")).toBe(false);
    const closed = new URL(cockpitMeetingAgendaPath("/acme/cockpit", "m1", null, opened.searchParams), "https://example.test");
    expect(closed.searchParams.has("agenda")).toBe(false);
    expect(closed.searchParams.get("meeting")).toBe("m1");
    expect(closed.searchParams.get("from")).toBe("2026-10-01");
    const other = new URL(cockpitMeetingAgendaPath("/acme/cockpit", "m2", "agenda-2", opened.searchParams), "https://example.test");
    expect(other.searchParams.has("action")).toBe(false);
    expect(cockpitObjectPath("/acme/cockpit", { kind: "meeting", id: "m1", agendaId: "agenda-1" })).toBe("/acme/cockpit?meeting=m1&agenda=agenda-1&meeting_view=preparation");
  });
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
