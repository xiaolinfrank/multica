// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createStore } from "zustand/vanilla";
import {
  DEFAULT_TABLE_COLUMNS,
  mergeViewStatePersisted,
  migrateLegacyTableColumnsDefault,
  viewStoreSlice,
  type IssueViewState,
  type TableColumnConfig,
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

  it("shows the work item column by default, right after the title", () => {
    expect(freshState().tableColumns.map((column) => column.key)).toEqual([
      "title",
      "work_item",
      "status",
      "priority",
      "assignee",
      "due_date",
      "labels",
    ]);
    expect(freshState().tableColumns[1]).toEqual({ key: "work_item", width: 220 });
    expect(DEFAULT_TABLE_COLUMNS[1]).toEqual({ key: "work_item", width: 220 });
  });
});

describe("migrateLegacyTableColumnsDefault", () => {
  const legacyDefault = (): TableColumnConfig[] => [
    { key: "title", width: 420 },
    { key: "status", width: 150 },
    { key: "priority", width: 130 },
    { key: "assignee", width: 180 },
    { key: "due_date", width: 140 },
    { key: "labels", width: 220 },
  ];

  it("inserts work_item after the title in an untouched legacy layout", () => {
    const legacy = legacyDefault();
    const migrated = migrateLegacyTableColumnsDefault(legacy);

    expect(migrated?.map((column) => column.key)).toEqual([
      "title",
      "work_item",
      "status",
      "priority",
      "assignee",
      "due_date",
      "labels",
    ]);
    expect(migrated?.[1]).toEqual({ key: "work_item", width: 220 });
    // The user's resized title width survives.
    expect(migrated?.[0]).toEqual({ key: "title", width: 420 });
  });

  it("leaves a customized layout untouched", () => {
    const hidden = legacyDefault().filter((column) => column.key !== "labels");
    const reordered = [...legacyDefault()].reverse();

    expect(migrateLegacyTableColumnsDefault(hidden)).toBe(hidden);
    expect(migrateLegacyTableColumnsDefault(reordered)).toBe(reordered);
  });

  it("does nothing to a layout that already names work_item", () => {
    const already = freshState().tableColumns;
    expect(migrateLegacyTableColumnsDefault(already)).toBe(already);
  });

  it("passes an absent snapshot through", () => {
    expect(migrateLegacyTableColumnsDefault(undefined)).toBeUndefined();
  });
});
