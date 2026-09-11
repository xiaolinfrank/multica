// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createStore } from "zustand/vanilla";
import {
  mergeViewStatePersisted,
  viewStoreSlice,
  type IssueViewState,
} from "./view-store";

function freshState(): IssueViewState {
  const store = createStore<IssueViewState>()((set) => viewStoreSlice(set));
  return store.getState();
}

describe("issue view store defaults", () => {
  it("opens every issue surface on the table view", () => {
    expect(freshState().viewMode).toBe("table");
  });

  it("keeps a persisted mode over the default", () => {
    const merged = mergeViewStatePersisted({ viewMode: "board" }, freshState());
    expect(merged.viewMode).toBe("board");
  });

  it("falls back to the default when a snapshot carries no mode", () => {
    const merged = mergeViewStatePersisted({ priorityFilters: ["high"] }, freshState());
    expect(merged.viewMode).toBe("table");
    expect(merged.priorityFilters).toEqual(["high"]);
  });
});
