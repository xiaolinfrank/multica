// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { clearCockpitActionCommand, rememberCockpitActionCommand, useCockpitActionCommandStore } from "./action-command-store";
import { cockpitTaskViewKey, useCockpitTaskViewStore } from "./task-view-store";
import { CREATION_KEY, DECISION_KEY } from "./action-test-fixtures";

beforeEach(() => { useCockpitActionCommandStore.getState().clearDraft(); useCockpitTaskViewStore.getState().reset(); });

describe("confirmed action intent and navigation context", () => {
  it("keeps an uncertain confirmation's exact key and body across attempts without storing issue snapshots", () => {
    const first = { kind: "decision" as const, meeting_id: "meeting-1", action_id: "action-1", version_id: "v1", source_content_hash: "fixed",
      body: { expected_revision: 3, decision_key: DECISION_KEY, outcome: "reuse" as const, issue_id: "issue-1", node_id: "node-1" } };
    rememberCockpitActionCommand("action:action-1", first);
    rememberCockpitActionCommand("action:action-1", { ...first, body: { ...first.body, decision_key: CREATION_KEY, expected_revision: 99 } });
    expect(useCockpitActionCommandStore.getState().draft.commands["action:action-1"]).toEqual(first);
    clearCockpitActionCommand("action:action-1");
    expect(useCockpitActionCommandStore.getState().draft.commands).toEqual({});
  });

  it("keeps filters and cursor stacks isolated by workspace and object for returning from an issue", () => {
    const key = cockpitTaskViewKey("ws-1", "node", "node-1");
    useCockpitTaskViewStore.getState().update(key, { text: "needle", category: "done" });
    useCockpitTaskViewStore.getState().update(key, { cursorKey: "matching-filter", cursors: ["", "page-2"] });
    expect(useCockpitTaskViewStore.getState().views[key]).toMatchObject({ text: "needle", category: "done", cursors: ["", "page-2"] });
    expect(useCockpitTaskViewStore.getState().views[cockpitTaskViewKey("ws-2", "node", "node-1")]).toBeUndefined();
    expect(useCockpitTaskViewStore.getState().views[cockpitTaskViewKey("ws-1", "meeting", "node-1")]).toBeUndefined();
  });

  it.each(["text", "status", "category", "relation", "versionId"] as const)("resets the cursor on a %s filter change, including a return to the original filter", (field) => {
    const key = cockpitTaskViewKey("ws-1", "node", "node-1");
    const store = useCockpitTaskViewStore.getState();
    store.update(key, { cursorKey: "original-filter", cursors: ["", "page-2"] });
    const original = useCockpitTaskViewStore.getState().views[key]![field];
    store.update(key, { [field]: field === "relation" ? "reference" : "changed" });
    expect(useCockpitTaskViewStore.getState().views[key]).toMatchObject({ cursorKey: "", cursors: [""] });
    store.update(key, { [field]: original });
    expect(useCockpitTaskViewStore.getState().views[key]).toMatchObject({ cursorKey: "", cursors: [""] });
    store.update(key, { cursorKey: "original-filter", cursors: ["", "page-2"] });
    store.update(key, { [field]: original });
    expect(useCockpitTaskViewStore.getState().views[key]?.cursors).toEqual(["", "page-2"]);
  });
});
