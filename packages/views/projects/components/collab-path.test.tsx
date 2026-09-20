import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithI18n } from "../../test/i18n";
import { CollabPathInput, CollabPathProperty, collabPathTail } from "./collab-path";

const mocks = vi.hoisted(() => ({
  copyText: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@multica/ui/lib/clipboard", () => ({ copyText: mocks.copyText }));

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

const PATH =
  "/Volumes/人机协作空间/AI医药联合创新平台/01高质量数据集/01.01回顾性队列数据集（JIA）";

beforeEach(() => {
  mocks.copyText.mockReset().mockResolvedValue(true);
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
});

describe("CollabPathProperty", () => {
  it("reads as unset rather than as a blank cell", () => {
    renderWithI18n(<CollabPathProperty value={null} onCommit={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Not set" })).toBeInTheDocument();
  });

  // Truncation is visual (CSS), so the full path has to stay in the DOM: it is
  // both the hover reveal and what a screen reader announces.
  it("keeps the whole path available while showing it truncated", () => {
    renderWithI18n(<CollabPathProperty value={PATH} onCommit={vi.fn()} />);

    expect(screen.getByRole("button", { name: PATH })).toHaveAttribute("title", PATH);
  });

  it("commits a trimmed absolute path on Enter", async () => {
    const onCommit = vi.fn();
    const user = userEvent.setup();
    renderWithI18n(<CollabPathProperty value={null} onCommit={onCommit} />);

    await user.click(screen.getByRole("button", { name: "Not set" }));
    await user.type(
      screen.getByRole("textbox", { name: "Collaboration space" }),
      `  ${PATH}  {Enter}`,
    );

    expect(onCommit).toHaveBeenCalledWith(PATH);
  });

  it("clears the field to null when the editor is emptied", async () => {
    const onCommit = vi.fn();
    const user = userEvent.setup();
    renderWithI18n(<CollabPathProperty value={PATH} onCommit={onCommit} />);

    await user.click(screen.getByRole("button", { name: "Edit path" }));
    await user.clear(screen.getByRole("textbox", { name: "Collaboration space" }));
    await user.keyboard("{Enter}");

    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it("abandons the edit on Escape", async () => {
    const onCommit = vi.fn();
    const user = userEvent.setup();
    renderWithI18n(<CollabPathProperty value={PATH} onCommit={onCommit} />);

    await user.click(screen.getByRole("button", { name: "Edit path" }));
    await user.clear(screen.getByRole("textbox", { name: "Collaboration space" }));
    await user.keyboard("/Volumes/elsewhere{Escape}");

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: PATH })).toBeInTheDocument();
  });

  // The value is unchanged, so there is nothing to write: a PUT here would
  // invalidate the project caches and repaint the sidebar for nothing.
  it("does not write when the value is unchanged", async () => {
    const onCommit = vi.fn();
    const user = userEvent.setup();
    renderWithI18n(<CollabPathProperty value={PATH} onCommit={onCommit} />);

    await user.click(screen.getByRole("button", { name: "Edit path" }));
    await user.keyboard("{Enter}");

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: PATH })).toBeInTheDocument();
  });

  // The server answers 400 for a relative path. Catching it here keeps the
  // typed value on screen next to the reason instead of dropping it and
  // surfacing a raw API error after the dialog has closed.
  it("keeps a rejected path in the editor and names the problem", async () => {
    const onCommit = vi.fn();
    const user = userEvent.setup();
    renderWithI18n(<CollabPathProperty value={null} onCommit={onCommit} />);

    await user.click(screen.getByRole("button", { name: "Not set" }));
    await user.type(
      screen.getByRole("textbox", { name: "Collaboration space" }),
      "01高质量数据集{Enter}",
    );

    expect(onCommit).not.toHaveBeenCalled();
    const input = screen.getByRole("textbox", { name: "Collaboration space" });
    expect(input).toHaveValue("01高质量数据集");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(
      screen.getByText("Enter an absolute path, such as /Volumes/share/project."),
    ).toBeInTheDocument();
  });

  // The value opens the directory now, so a click on it must not also drop the
  // row into an editor — that is what the pencil is for. Regression guard for
  // the split: before it, one target meant both.
  it("does not start editing when the path itself is clicked", async () => {
    const user = userEvent.setup();
    renderWithI18n(<CollabPathProperty value={PATH} onCommit={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: PATH }));

    expect(
      screen.queryByRole("textbox", { name: "Collaboration space" }),
    ).not.toBeInTheDocument();
  });

  it("copies the full path, not the truncated one", async () => {
    const user = userEvent.setup();
    renderWithI18n(<CollabPathProperty value={PATH} onCommit={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Copy path" }));

    expect(mocks.copyText).toHaveBeenCalledWith(PATH);
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Path copied");
  });

  // copyText returns false in an insecure context instead of throwing, so a
  // silent failure is the failure mode to guard against.
  it("reports a failed copy instead of claiming success", async () => {
    mocks.copyText.mockResolvedValue(false);
    const user = userEvent.setup();
    renderWithI18n(<CollabPathProperty value={PATH} onCommit={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Copy path" }));

    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith("Couldn't copy the path");
  });
});

describe("CollabPathInput", () => {
  it("explains the field until a value is rejected, then explains the rejection", () => {
    const hint = "Shared directory where people and agents hand this project's deliverables to each other.";
    const { rerender } = renderWithI18n(
      <CollabPathInput value="" onValueChange={vi.fn()} hint={hint} />,
    );

    const input = screen.getByRole("textbox", { name: "Collaboration space" });
    expect(input).toHaveAccessibleDescription(hint);
    expect(input).not.toHaveAttribute("aria-invalid");

    rerender(
      <CollabPathInput
        value="notes"
        onValueChange={vi.fn()}
        hint={hint}
        error="not_absolute"
      />,
    );

    const rejected = screen.getByRole("textbox", { name: "Collaboration space" });
    expect(rejected).toHaveAttribute("aria-invalid", "true");
    expect(rejected).toHaveAccessibleDescription(
      "Enter an absolute path, such as /Volumes/share/project.",
    );
  });
});

describe("collabPathTail", () => {
  it("returns the segment that distinguishes a path from its siblings", () => {
    expect(collabPathTail(PATH)).toBe("01.01回顾性队列数据集（JIA）");
    expect(collabPathTail("\\\\nas\\share\\模块")).toBe("模块");
    expect(collabPathTail("/Volumes/share/project/")).toBe("project");
  });
});
