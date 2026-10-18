// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { resetAllRegisteredDrafts } from "../drafts/cleanup-registry";
import { cockpitHistoryViewKey, useCockpitHistoryViewStore } from "./workflow-history-view-store";

beforeEach(() => useCockpitHistoryViewStore.getState().reset());
describe("meeting history navigation", () => {
  it("isolates workspace and meeting cursors and resets only the filtered export page", () => {
    const a = cockpitHistoryViewKey("ws-a", "meeting-a"), b = cockpitHistoryViewKey("ws-b", "meeting-a");
    const store = useCockpitHistoryViewStore.getState();
    store.setPage(a, "versions", ["", "older-versions"]); store.setPage(a, "exports", ["", "older-exports"]);
    store.setPage(b, "versions", ["", "different-workspace"]);
    store.update(a, { exportStatus: "active", section: "exports" });
    expect(useCockpitHistoryViewStore.getState().views[a]).toMatchObject({ cursors: { versions: ["", "older-versions"], exports: [""] } });
    expect(useCockpitHistoryViewStore.getState().views[b]?.cursors.versions).toEqual(["", "different-workspace"]);
    store.setPage(a, "exports", ["", "active-exports"]); store.update(a, { exportStatus: "" }); store.update(a, { exportStatus: "active" });
    expect(useCockpitHistoryViewStore.getState().views[a]?.cursors.exports).toEqual([""]);
  });
  it("clears actor-bound cursors on logout without retaining server history", () => {
    const key = cockpitHistoryViewKey("ws-a", "meeting-a");
    useCockpitHistoryViewStore.getState().setPage(key, "handoffs", ["", "old-session"]);
    resetAllRegisteredDrafts();
    expect(useCockpitHistoryViewStore.getState().views).toEqual({});
  });
});
