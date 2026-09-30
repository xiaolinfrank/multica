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
  { party: "复星医药", name: "刘欢欢", position: "项目经理", source: "seed" },
  { party: "深圳联通", name: "冯延虎", position: "数据要素运营经理", source: "seed" },
  { party: "深圳联通", name: "李明玉", position: "", source: "seed" },
  { party: "", name: "黄晓韵", position: "PI", source: "seed" },
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
  it("scopes the browse to the meeting's parties, widening on the toggle", () => {
    openField({ parties: ["深圳联通"] });
    const listbox = screen.getByRole("listbox");
    // 联通 chosen → 联通's people are what the list shows; everyone else is
    // behind the toggle, not below the fold.
    // textContent carries the muted 职位 too, so match by the leading name.
    const unicron = within(listbox)
      .getAllByRole("option")
      .filter((o) => ["李明玉", "冯延虎"].some((n) => (o.textContent ?? "").startsWith(n)));
    expect(unicron).toHaveLength(2);
    expect(within(listbox).queryByText(/刘欢欢/)).not.toBeInTheDocument();
    expect(screen.queryByText("Other people")).not.toBeInTheDocument();
    // The 职位 rides the row, muted, next to the name.
    expect(within(listbox).getByText("数据要素运营经理")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show everyone" }));
    const widened = screen.getByRole("listbox").textContent ?? "";
    expect(widened.indexOf("深圳联通")).toBeLessThan(widened.indexOf("复星医药"));
    expect(screen.getByText("Other people")).toBeInTheDocument();

    // And narrows back.
    fireEvent.click(screen.getByRole("button", { name: "Only the meeting's units" }));
    expect(within(screen.getByRole("listbox")).queryByText(/刘欢欢/)).not.toBeInTheDocument();
  });

  it("falls back to the full book when the chosen unit has nobody in it", () => {
    openField({ parties: ["数鑫科技"] });
    expect(within(screen.getByRole("listbox")).getByText(/刘欢欢/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show everyone" })).not.toBeInTheDocument();
  });

  it("searches the whole book even while scoped to the meeting's unit", () => {
    openField({ parties: ["深圳联通"] });
    fireEvent.change(screen.getByRole("textbox", { name: "Attendees" }), {
      target: { value: "刘欢欢" },
    });
    expect(screen.getByRole("option", { name: /刘欢欢/ })).toBeInTheDocument();
    // The scope toggle is a browse affordance; a query needs no widening.
    expect(screen.queryByRole("button", { name: "Show everyone" })).not.toBeInTheDocument();
  });

  it("buckets party-less contacts under the others header once units lead", () => {
    openField({ parties: ["深圳联通"], suggestions: ["王新"] });
    fireEvent.click(screen.getByRole("button", { name: "Show everyone" }));
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
        source: "user",
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
      { party: "深圳联通", name: "王新", position: "", source: "user" },
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
        source: "user",
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

describe("CockpitAttendeeField deletion", () => {
  const bookWithUser: CockpitDirectoryEntry[] = [
    ...book,
    { party: "深圳联通", name: "王新", position: "", source: "user" },
  ];

  it("offers delete only on rows the form filed, never on the roster", () => {
    openField({ parties: ["深圳联通"], directory: bookWithUser, onDeleteEntry: vi.fn() });
    expect(screen.getByRole("button", { name: "Delete 王新" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete 李明玉" })).not.toBeInTheDocument();
    // The pencil stays on roster rows — a title there is corrected, not deleted.
    expect(screen.getByRole("button", { name: "Edit the position for 李明玉" })).toBeInTheDocument();
  });

  it("deletes after the inline confirm, and only after it", async () => {
    const props = openField({
      parties: ["深圳联通"],
      directory: bookWithUser,
      onDeleteEntry: vi.fn().mockResolvedValue(true),
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete 王新" }));
    expect(screen.getByText(/Remove 王新 from the contact book/)).toBeInTheDocument();
    // The unit repeats under the name: the group header and the confirm bar.
    expect(screen.getAllByText("深圳联通").length).toBeGreaterThanOrEqual(2);

    // Step back: cancel closes the bar and nothing leaves the book.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onDeleteEntry).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete 王新" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(props.onDeleteEntry).toHaveBeenCalledExactlyOnceWith({
        party: "深圳联通",
        name: "王新",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByText(/Remove 王新 from the contact book/)).not.toBeInTheDocument(),
    );
  });

  it("does not re-file a name this form just deleted when the draft commits", async () => {
    const props: Parameters<typeof CockpitAttendeeField>[0] = {
      value: "",
      onCommit: vi.fn(),
      parties: ["深圳联通"],
      directory: bookWithUser,
      suggestions: [],
      label: "Attendees",
      placeholder: "Add attendee",
      onSaveEntry: vi.fn().mockResolvedValue(true),
      onDeleteEntry: vi.fn().mockResolvedValue(true),
      onAutoSave: vi.fn(),
    };
    const view = renderWithI18n(<CockpitAttendeeField {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Attendees" }));
    fireEvent.click(screen.getByRole("option", { name: /王新/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete 王新" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(props.onDeleteEntry).toHaveBeenCalled());
    // The mutation settles the cache with the server's book — the row is
    // gone from the prop. The ticked token still commits, but the auto-file
    // must not resurrect what this form just removed.
    view.rerender(<CockpitAttendeeField {...props} directory={book} />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Attendees" }), { key: "Enter" });
    expect(props.onCommit).toHaveBeenCalledExactlyOnceWith("王新");
    expect(props.onAutoSave).not.toHaveBeenCalled();
  });

  it("drops the confirm bar when another client removes the row first", async () => {
    const props: Parameters<typeof CockpitAttendeeField>[0] = {
      value: "",
      onCommit: vi.fn(),
      parties: ["深圳联通"],
      directory: bookWithUser,
      suggestions: [],
      label: "Attendees",
      placeholder: "Add attendee",
      onSaveEntry: vi.fn().mockResolvedValue(true),
      onDeleteEntry: vi.fn().mockResolvedValue(true),
    };
    const view = renderWithI18n(<CockpitAttendeeField {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Attendees" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete 王新" }));
    expect(screen.getByText(/Remove 王新 from the contact book/)).toBeInTheDocument();
    // The book refreshes under the open picker: the row is gone, the bar
    // goes with it, and no delete ever fires.
    view.rerender(<CockpitAttendeeField {...props} directory={book} />);
    await waitFor(() =>
      expect(screen.queryByText(/Remove 王新 from the contact book/)).not.toBeInTheDocument(),
    );
    expect(props.onDeleteEntry).not.toHaveBeenCalled();
    // Escape falls through to the picker's own close, not eaten by the
    // invisible bar.
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Attendees" }), { key: "Escape" });
    expect(props.onCommit).not.toHaveBeenCalled();
  });

  it("keeps the confirm open when the delete fails, and Escape dismisses it", async () => {
    const props = openField({
      parties: ["深圳联通"],
      directory: bookWithUser,
      onDeleteEntry: vi.fn().mockResolvedValue(false),
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete 王新" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(props.onDeleteEntry).toHaveBeenCalled());
    expect(screen.getByText(/Remove 王新 from the contact book/)).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Attendees" }), { key: "Escape" });
    expect(screen.queryByText(/Remove 王新/)).not.toBeInTheDocument();
    // Escape closed the bar, not the picker: the tokens never reverted.
    expect(props.onCommit).not.toHaveBeenCalled();
  });
});
