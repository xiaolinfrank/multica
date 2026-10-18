// @vitest-environment jsdom

import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildIssueStatusCatalog } from "@multica/core/issue-statuses";
import type { Issue } from "@multica/core/types";
import { renderWithI18n } from "../test/i18n";

const searchIssues = vi.fn();

vi.mock("@multica/core/api", () => ({
  api: { searchIssues: (params: unknown) => searchIssues(params) },
}));
vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "workspace-1",
}));
vi.mock("@multica/core/issue-statuses/hooks", () => ({
  useIssueStatuses: () => buildIssueStatusCatalog(undefined),
}));

import { IssuePickerModal } from "./issue-picker-modal";

function issue(overrides: Partial<Issue>): Issue {
  return { id: "issue", identifier: "MUL-1", title: "An issue", status: "todo", ...overrides } as Issue;
}

const ORIGINAL = issue({ id: "original", identifier: "MUL-1", title: "Tap targets too small" });
const DUPLICATE = issue({
  id: "duplicate",
  identifier: "MUL-2",
  title: "Tap targets too small on iPhone",
  status: "cancelled",
  duplicate_of: { id: "original", identifier: "MUL-1", title: "Tap targets too small", status: "todo" },
});

afterEach(() => {
  cleanup();
  searchIssues.mockReset();
});

// The mark-as-duplicate picker must not offer an issue that is itself a
// duplicate; the server would reject it after the dialog has already closed.
describe("IssuePickerModal isSelectable", () => {
  it("waits for selection acknowledgement and keeps the search after a failed write", async () => {
    let reject!: (cause: Error) => void;
    const selected = vi.fn().mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; })).mockResolvedValueOnce(undefined);
    const changed = vi.fn(); searchIssues.mockResolvedValue({ issues: [ORIGINAL] });
    await renderWithI18n(<IssuePickerModal open onOpenChange={changed} contextKey="first" title="Set parent" description="Choose parent" excludeIds={[]} onSelect={selected} />);
    const input = screen.getByPlaceholderText("Search issues..."); fireEvent.change(input, { target: { value: "tap" } });
    fireEvent.click(await screen.findByText(ORIGINAL.title));
    expect(changed).not.toHaveBeenCalled(); expect(input).toBeDisabled();
    await act(async () => reject(new Error("Revision conflict")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Revision conflict"); expect(input).toHaveValue("tap"); expect(input).toBeEnabled();
    fireEvent.click(screen.getByText(ORIGINAL.title));
    await waitFor(() => expect(changed).toHaveBeenCalledExactlyOnceWith(false));
  });
  it("cancels an old selection across A to B to A and never closes the reopened object", async () => {
    let finish!: () => void; let signal: AbortSignal | undefined;
    const changed = vi.fn(); const chosen = vi.fn((_issue: Issue, observedSignal: AbortSignal) => { signal = observedSignal; return new Promise<void>((resolve) => { finish = resolve; }); });
    const props = { open: true, onOpenChange: changed, title: "Set parent", description: "Choose parent", excludeIds: [], suggestions: [{ key: "recent", heading: "Recent", issues: [ORIGINAL] }], onSelect: chosen };
    const view = await renderWithI18n(<IssuePickerModal {...props} contextKey="issue-a" />);
    fireEvent.click(screen.getByText(ORIGINAL.title));
    view.rerender(<IssuePickerModal {...props} contextKey="issue-b" />);
    expect(signal?.aborted).toBe(true);
    view.rerender(<IssuePickerModal {...props} contextKey="issue-a" />);
    await act(async () => finish());
    expect(changed).not.toHaveBeenCalled(); expect(screen.getByText(ORIGINAL.title)).toBeVisible();
  });
  it("distinguishes a failed search from no results and retries the retained query", async () => {
    searchIssues.mockRejectedValueOnce(new Error("Search unavailable")).mockResolvedValueOnce({ issues: [ORIGINAL] });
    await renderWithI18n(<IssuePickerModal open onOpenChange={vi.fn()} title="Set parent" description="Choose parent" excludeIds={[]} onSelect={vi.fn()} />);
    const input = screen.getByPlaceholderText("Search issues..."); fireEvent.change(input, { target: { value: "tap" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Issue search failed"); expect(input).toHaveValue("tap");
    fireEvent.click(screen.getByRole("button", { name: "Check again" })); expect(await screen.findByText(ORIGINAL.title)).toBeVisible();
    expect(searchIssues).toHaveBeenCalledTimes(2);
  });
  it("drops unselectable issues from search results", async () => {
    searchIssues.mockResolvedValue({ issues: [ORIGINAL, DUPLICATE] });
    renderWithI18n(
      <IssuePickerModal
        open
        onOpenChange={() => {}}
        title="Mark as duplicate"
        description="Pick the original"
        excludeIds={[]}
        isSelectable={(candidate) => !candidate.duplicate_of}
        onSelect={() => {}}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("Search issues..."), { target: { value: "tap" } });
    await waitFor(() => expect(searchIssues).toHaveBeenCalled());
    await screen.findByText("Tap targets too small");
    expect(screen.queryByText("Tap targets too small on iPhone")).toBeNull();
  });

  it("drops unselectable issues from suggestions too", () => {
    renderWithI18n(
      <IssuePickerModal
        open
        onOpenChange={() => {}}
        title="Mark as duplicate"
        description="Pick the original"
        excludeIds={[]}
        suggestions={[{ key: "recent", heading: "Recently viewed", issues: [DUPLICATE, ORIGINAL] }]}
        isSelectable={(candidate) => !candidate.duplicate_of}
        onSelect={() => {}}
      />,
    );

    expect(screen.getByText("Recently viewed")).toBeTruthy();
    expect(screen.getByText("Tap targets too small")).toBeTruthy();
    expect(screen.queryByText("Tap targets too small on iPhone")).toBeNull();
  });
});
