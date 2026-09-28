// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CockpitDirectoryEntry } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { CockpitAttendeeField } from "./cockpit-attendees";

// The attendee picker: the contact book grouped by the meeting's units, a
// multi-tick list, and the inline editor that files a new contact (or fixes a
// 职位) into the book on the spot.

const book: CockpitDirectoryEntry[] = [
  { party: "复星医药", name: "刘欢欢", position: "项目经理" },
  { party: "深圳联通", name: "冯延虎", position: "数据要素运营经理" },
  { party: "深圳联通", name: "李明玉", position: "" },
  { party: "", name: "黄晓韵", position: "PI" },
];

function openField(overrides: Partial<Parameters<typeof CockpitAttendeeField>[0]> = {}) {
  const props: Parameters<typeof CockpitAttendeeField>[0] = {
    value: "",
    onCommit: vi.fn(),
    parties: [],
    directory: book,
    suggestions: [],
    label: "Attendees",
    placeholder: "Add attendee",
    onSaveEntry: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
  renderWithI18n(<CockpitAttendeeField {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Attendees" }));
  return props;
}

const options = () => screen.getAllByRole("option");

afterEach(cleanup);

describe("CockpitAttendeeField groups", () => {
  it("leads with the meeting's own party so its people are one tick away", () => {
    openField({ parties: ["深圳联通"] });
    const listbox = screen.getByRole("listbox");
    const text = listbox.textContent ?? "";
    expect(text.indexOf("深圳联通")).toBeLessThan(text.indexOf("复星医药"));
    // textContent carries the muted 职位 too, so match by the leading name.
    const unicron = within(listbox)
      .getAllByRole("option")
      .filter((o) => ["李明玉", "冯延虎"].some((n) => (o.textContent ?? "").startsWith(n)));
    expect(unicron).toHaveLength(2);
    // The 职位 rides the row, muted, next to the name.
    expect(within(listbox).getByText("数据要素运营经理")).toBeInTheDocument();
  });

  it("buckets party-less contacts under the others header once units lead", () => {
    openField({ parties: ["深圳联通"], suggestions: ["王新"] });
    expect(screen.getByText("Other people")).toBeInTheDocument();
    const names = options().map((o) => o.textContent ?? "");
    expect(names.some((n) => n.startsWith("黄晓韵"))).toBe(true);
    expect(names).toContain("王新");
  });

  it("ticks any number of people and commits them joined on close", () => {
    const props = openField({ parties: ["深圳联通"] });
    fireEvent.click(screen.getByRole("option", { name: /李明玉/ }));
    fireEvent.click(screen.getByRole("option", { name: /冯延虎/ }));
    expect(screen.getByRole("option", { name: /李明玉/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Attendees" }), { key: "Enter" });
    expect(props.onCommit).toHaveBeenCalledExactlyOnceWith("李明玉、冯延虎");
  });
});

describe("CockpitAttendeeField new contact", () => {
  it("files a typed name with its 职位 under the meeting's unit", async () => {
    const props = openField({ parties: ["深圳联通"] });
    const input = screen.getByRole("textbox", { name: "Attendees" });
    fireEvent.change(input, { target: { value: "王新" } });
    fireEvent.click(screen.getByRole("button", { name: /Add “王新”/ }));
    // The unit is a chip row of the meeting's parties; 职位 is free text.
    fireEvent.click(screen.getByRole("button", { name: "深圳联通" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Position" }), {
      target: { value: "平台总架构师" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(props.onSaveEntry).toHaveBeenCalledExactlyOnceWith({
        party: "深圳联通",
        name: "王新",
        position: "平台总架构师",
      }),
    );
  });

  it("keeps a failed save's editor open", async () => {
    const props = openField({
      parties: ["深圳联通"],
      onSaveEntry: vi.fn().mockResolvedValue(false),
    });
    const input = screen.getByRole("textbox", { name: "Attendees" });
    fireEvent.change(input, { target: { value: "王新" } });
    fireEvent.click(screen.getByRole("button", { name: /Add “王新”/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(props.onSaveEntry).toHaveBeenCalled());
    expect(screen.getByRole("textbox", { name: "Position" })).toBeInTheDocument();
  });

  it("still auto-saves the bare name on commit when the editor was cancelled", () => {
    const props = openField({ parties: ["深圳联通"], onAutoSave: vi.fn() });
    const input = screen.getByRole("textbox", { name: "Attendees" });
    fireEvent.change(input, { target: { value: "王新" } });
    fireEvent.click(screen.getByRole("button", { name: /Add “王新”/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onSaveEntry).not.toHaveBeenCalled();
    // Enter on the now-empty box closes the field and commits.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onCommit).toHaveBeenCalledExactlyOnceWith("王新");
    expect(props.onAutoSave).toHaveBeenCalledExactlyOnceWith([
      { party: "深圳联通", name: "王新", position: "" },
    ]);
  });

  it("auto-saves nothing when two units sat at the table", () => {
    const props = openField({ parties: ["深圳联通", "复星医药"], onAutoSave: vi.fn() });
    const input = screen.getByRole("textbox", { name: "Attendees" });
    fireEvent.change(input, { target: { value: "王新" } });
    fireEvent.click(screen.getByRole("button", { name: /Add “王新”/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onCommit).toHaveBeenCalledExactlyOnceWith("王新");
    expect(props.onAutoSave).not.toHaveBeenCalled();
  });
});

describe("CockpitAttendeeField book upkeep", () => {
  it("edits a contact's 职位 in place from its row", async () => {
    const props = openField({ parties: ["深圳联通"] });
    fireEvent.click(screen.getByRole("button", { name: "Edit the position for 李明玉" }));
    // The unit is locked for an existing contact — only the 职位 moves.
    expect(screen.queryByRole("button", { name: "复星医药" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Position" }), {
      target: { value: "平台总架构师" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(props.onSaveEntry).toHaveBeenCalledExactlyOnceWith({
        party: "深圳联通",
        name: "李明玉",
        position: "平台总架构师",
      }),
    );
  });

  it("reverts the draft when Escape closes the picker", () => {
    const props = openField({ parties: ["深圳联通"] });
    fireEvent.click(screen.getByRole("option", { name: /李明玉/ }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Attendees" }), { key: "Escape" });
    expect(props.onCommit).not.toHaveBeenCalled();
  });
});
