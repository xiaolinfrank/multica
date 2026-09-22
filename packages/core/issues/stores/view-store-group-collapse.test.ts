// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createStore } from "zustand/vanilla";
import {
  isIssueTableGroupCollapsed,
  mergeViewStatePersisted,
  viewStoreSlice,
  viewStorePersistOptions,
  type IssueViewState,
} from "./view-store";

function freshStore() {
  return createStore<IssueViewState>()((set) => viewStoreSlice(set));
}

function collapsed(state: IssueViewState, key: string) {
  return isIssueTableGroupCollapsed(
    key,
    new Set(state.tableCollapsedGroups),
    new Set(state.tableExpandedGroups),
  );
}

const MODULE = "module:11111111-1111-4111-8111-111111111111";
const STATUS = "status:todo";

describe("table group collapse", () => {
  it("starts a module group folded and every other group open", () => {
    const state = freshStore().getState();
    expect(collapsed(state, MODULE)).toBe(true);
    expect(collapsed(state, "module:none")).toBe(true);
    expect(collapsed(state, STATUS)).toBe(false);
    expect(collapsed(state, "project:p1")).toBe(false);
  });

  it("toggles each group away from its own default and back", () => {
    const store = freshStore();
    store.getState().toggleTableGroupCollapsed(MODULE);
    expect(collapsed(store.getState(), MODULE)).toBe(false);
    store.getState().toggleTableGroupCollapsed(MODULE);
    expect(collapsed(store.getState(), MODULE)).toBe(true);

    store.getState().toggleTableGroupCollapsed(STATUS);
    expect(collapsed(store.getState(), STATUS)).toBe(true);
    // Opening a module must not read as collapsing a status, and the reverse.
    expect(store.getState().tableCollapsedGroups).toEqual([STATUS]);
    expect(store.getState().tableExpandedGroups).toEqual([]);
  });

  it("remembers both lists across a reload", () => {
    const store = freshStore();
    store.getState().toggleTableGroupCollapsed(MODULE);
    store.getState().toggleTableGroupCollapsed(STATUS);
    const saved = viewStorePersistOptions("test").partialize(store.getState());

    const reloaded = mergeViewStatePersisted(
      JSON.parse(JSON.stringify(saved)),
      freshStore().getState(),
    );
    expect(collapsed(reloaded, MODULE)).toBe(false);
    expect(collapsed(reloaded, STATUS)).toBe(true);
  });

  it("leaves a snapshot saved before the second list on the defaults", () => {
    const reloaded = mergeViewStatePersisted(
      { tableCollapsedGroups: [STATUS] },
      freshStore().getState(),
    );
    expect(collapsed(reloaded, STATUS)).toBe(true);
    expect(collapsed(reloaded, MODULE)).toBe(true);
  });
});
