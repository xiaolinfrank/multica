import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { EditableSuggest } from "./cockpit-fields";

// The status column's clear option: "未排期" is the board's name for an empty
// status, so offering it in the dropdown must write the canonical empty
// string — never the display words as a literal value.
function openEditor(overrides: Partial<Parameters<typeof EditableSuggest>[0]> = {}) {
  const onCommit = vi.fn();
  render(
    <EditableSuggest
      value="进行中"
      onCommit={onCommit}
      suggestions={["未开始", "进行中", "已完成"]}
      label="Status"
      placeholder="—"
      clearLabel="未排期"
      {...overrides}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Status" }));
  return { onCommit };
}

const options = () => screen.getAllByRole("option").map((o) => o.textContent);

describe("EditableSuggest clearLabel", () => {
  it("pins the unscheduled option first and commits an empty string when picked", () => {
    const { onCommit } = openEditor();
    expect(options()).toEqual(["未排期", "未开始", "进行中", "已完成"]);
    fireEvent.click(screen.getByRole("option", { name: "未排期" }));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("");
  });

  it("offers the unscheduled option even when the board has no values yet", () => {
    const { onCommit } = openEditor({ suggestions: [] });
    expect(options()).toEqual(["未排期"]);
    fireEvent.click(screen.getByRole("option", { name: "未排期" }));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("");
  });

  it("maps the label typed out by hand to the same canonical empty", () => {
    const { onCommit } = openEditor();
    const input = screen.getByRole("textbox", { name: "Status" });
    fireEvent.change(input, { target: { value: "未排期" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("");
  });

  it("keeps any other typed vocabulary verbatim", () => {
    const { onCommit } = openEditor();
    const input = screen.getByRole("textbox", { name: "Status" });
    fireEvent.change(input, { target: { value: "联调中" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("联调中");
  });

  it("does not patch when the field is already unscheduled", () => {
    const { onCommit } = openEditor({ value: "" });
    fireEvent.click(screen.getByRole("option", { name: "未排期" }));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("marks the unscheduled option as the current value when empty", () => {
    openEditor({ value: "" });
    expect(screen.getByRole("option", { name: "未排期" })).toHaveClass("font-medium");
  });

  it("lists the option once when a node already stores the literal words", () => {
    openEditor({ suggestions: ["未排期", "进行中"], value: "未排期" });
    expect(options()).toEqual(["未排期", "进行中"]);
  });

  it("filters the unscheduled option by the typed needle like any other", () => {
    openEditor();
    const input = screen.getByRole("textbox", { name: "Status" });
    fireEvent.change(input, { target: { value: "未" } });
    expect(options()).toEqual(["未排期", "未开始"]);
    fireEvent.change(input, { target: { value: "进行" } });
    expect(options()).toEqual(["进行中"]);
  });
});
