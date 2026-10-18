// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { collectCockpitActionItems, cockpitActionItemsCsv } from "./action-items-export";
import { actionFixture } from "./action-test-fixtures";

describe("confirmed minutes action export", () => {
  it("reads every page of the selected published version", async () => {
    const first = actionFixture({ id: "a1" }); const second = actionFixture({ id: "a2" });
    const load = vi.fn().mockResolvedValueOnce({ meeting_id: first.meeting_id, items: [first], filtered_total: 2, next_cursor: "next" })
      .mockResolvedValueOnce({ meeting_id: first.meeting_id, items: [second], filtered_total: 2, next_cursor: null });
    expect(await collectCockpitActionItems(first.meeting_id, first.version_id, load)).toEqual([first, second]);
    expect(load.mock.calls).toEqual([[undefined], ["next"]]);
  });
  it("refuses a changed list or a version from another confirmation", async () => {
    const item = actionFixture();
    await expect(collectCockpitActionItems(item.meeting_id, "other", async () => ({ meeting_id: item.meeting_id, items: [item], total: 1, filtered_total: 1, next_cursor: null, can_add: false }))).rejects.toThrow();
    await expect(collectCockpitActionItems(item.meeting_id, item.version_id, async () => ({ meeting_id: item.meeting_id, items: [item], total: 2, filtered_total: 2, next_cursor: null, can_add: false }))).rejects.toThrow();
  });
  it("exports source provenance and escapes formulas, quotes and newlines", () => {
    const text = cockpitActionItemsCsv([actionFixture({ title: "=SUM(A1:A2)", description: 'a "quote"\nnext', source_quote: "Original minutes" })], ["Title"]);
    expect(text).toContain('"\'=SUM(A1:A2)"'); expect(text).toContain('"a ""quote""\nnext"'); expect(text).toContain('"Original minutes"');
  });
});
