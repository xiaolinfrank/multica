// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createStore } from "zustand/vanilla";
import {
  mergeViewStatePersisted,
  viewStoreSlice,
  type IssueViewState,
} from "./view-store";

function freshStore() {
  return createStore<IssueViewState>()((set) => viewStoreSlice(set));
}

describe("table grouping — surface default vs explicit choice", () => {
  it("applies a surface default while the grouping is untouched", () => {
    const store = freshStore();
    store.getState().applyTableGroupingDefault("module");
    expect(store.getState().tableGrouping).toBe("module");
    // Applying a default is not a user choice — a later default still wins.
    expect(store.getState().tableGroupingTouched).toBe(false);
  });

  it("does not override an explicitly chosen grouping", () => {
    const store = freshStore();
    store.getState().chooseTableGrouping("none");
    store.getState().applyTableGroupingDefault("module");
    expect(store.getState().tableGrouping).toBe("none");
    expect(store.getState().tableGroupingTouched).toBe(true);
  });

  it("keeps a later explicit pick once a default already applied", () => {
    const store = freshStore();
    store.getState().applyTableGroupingDefault("module");
    store.getState().chooseTableGrouping("status");
    store.getState().applyTableGroupingDefault("module");
    expect(store.getState().tableGrouping).toBe("status");
  });

  it("programmatic corrections do not mark the grouping as touched", () => {
    const store = freshStore();
    store.getState().setTableGrouping("none");
    expect(store.getState().tableGrouping).toBe("none");
    expect(store.getState().tableGroupingTouched).toBe(false);
  });

  it("rehydrates the touched flag and defaults legacy snapshots to untouched", () => {
    expect(
      mergeViewStatePersisted(
        { tableGrouping: "none", tableGroupingTouched: true },
        freshStore().getState(),
      ).tableGroupingTouched,
    ).toBe(true);
    expect(
      mergeViewStatePersisted(
        { tableGrouping: "module" },
        freshStore().getState(),
      ),
    ).toMatchObject({ tableGrouping: "module", tableGroupingTouched: false });
  });
});
