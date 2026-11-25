import { describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multica/core/i18n/react";
import enProjects from "../../locales/en/projects.json";
import enIssues from "../../locales/en/issues.json";
import { ProjectPicker } from "./project-picker";
import { PillButton } from "../../common/pill-button";

const mockProjects = vi.hoisted(() => ({
  current: [
    { id: "project-1", title: "Launch Command Center", icon: null } as { id: string; code?: string | null; title: string; icon: string | null },
    { id: "project-2", title: "Mobile Web", icon: null },
  ],
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: mockProjects.current,
  }),
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "workspace-1",
}));

vi.mock("@multica/core/projects/queries", () => ({
  projectListOptions: () => ({ queryKey: ["projects"] }),
}));

vi.mock("./project-icon", () => ({
  ProjectIcon: () => <span data-testid="project-icon" />,
}));

function withI18n(children: React.ReactNode) {
  return (
    <I18nProvider locale="en" resources={{ en: { projects: enProjects, issues: enIssues } }}>
      {children}
    </I18nProvider>
  );
}

// Real PropertyPicker (Popover) — do not mock it: clearing now lives inside
// the popover, so the tests have to actually open it.
function renderPicker(props: Partial<React.ComponentProps<typeof ProjectPicker>> = {}) {
  return render(
    withI18n(
      <ProjectPicker
        projectId="project-1"
        onUpdate={props.onUpdate ?? vi.fn()}
        triggerRender={<PillButton />}
        {...props}
      />,
    ),
  );
}

const SEARCH_PLACEHOLDER = "Search projects...";

describe("ProjectPicker", () => {
  it("renders the trigger alone — the pill carries no inline clear control", () => {
    // Regression: the clear × used to be an absolutely-positioned sibling
    // overlaying the trigger, and only the picker's own default trigger
    // reserved right padding for it. Every caller passing `triggerRender`
    // (create dialog pill, table cell, autopilot card) had the × painted on
    // top of the project name. Clearing belongs in the popover instead, which
    // is also where the other property pickers put it.
    renderPicker();

    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /launch command center/i })).toBeInTheDocument();
  });

  it("clears the selection from the No project row", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();

    renderPicker({ onUpdate });

    await user.click(screen.getByRole("button", { name: /launch command center/i }));
    await user.click(await screen.findByRole("button", { name: /no project/i }));

    expect(onUpdate).toHaveBeenCalledWith({ project_id: null });
  });

  it("keeps the empty row first while searching", async () => {
    // The empty value is the fixed first row of every picker in the app — a
    // typed query must not move or hide it, or "clear this field" lands
    // somewhere different depending on what the user typed.
    const user = userEvent.setup();
    const onUpdate = vi.fn();

    renderPicker({ onUpdate });

    await user.click(screen.getByRole("button", { name: /launch command center/i }));
    await user.type(await screen.findByPlaceholderText(SEARCH_PLACEHOLDER), "zzzznomatch");

    await user.click(screen.getByRole("button", { name: /no project/i }));
    expect(onUpdate).toHaveBeenCalledWith({ project_id: null });
  });

  it("keeps the empty row ahead of the filtered matches", async () => {
    const user = userEvent.setup();

    renderPicker({ projectId: null });

    // Unset, the trigger adopts the "No project" label too, so both it and
    // the row match — before and after typing.
    await user.click(screen.getByRole("button", { name: /no project/i }));
    expect(screen.getAllByRole("button", { name: /no project/i })).toHaveLength(2);

    await user.type(await screen.findByPlaceholderText(SEARCH_PLACEHOLDER), "mobile");
    expect(screen.getAllByRole("button", { name: /no project/i })).toHaveLength(2);
    expect(screen.getByRole("button", { name: /mobile web/i })).toBeInTheDocument();
  });

  it("shows a truncated project name on keyboard focus, not a fitting one", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByRole("button", { name: /launch command center/i }));
    await screen.findByPlaceholderText(SEARCH_PLACEHOLDER);
    const rows = Array.from(document.querySelectorAll<HTMLButtonElement>("button[data-picker-item]"));
    const longRow = rows.find((row) => row.textContent === "Launch Command Center")!;
    const shortRow = rows.find((row) => row.textContent === "Mobile Web")!;

    // jsdom has no layout: clip the long row's label the way `truncate` would.
    const label = within(longRow).getByText("Launch Command Center");
    label.style.overflowX = "hidden";
    Object.defineProperties(label, {
      scrollWidth: { configurable: true, value: 240 },
      clientWidth: { configurable: true, value: 120 },
    });

    await act(async () => {
      shortRow.focus();
    });
    expect(document.querySelector("[data-slot='tooltip-content']")).toBeNull();

    await act(async () => {
      longRow.focus();
    });
    expect(document.querySelector("[data-slot='tooltip-content']")).toHaveTextContent(
      "Launch Command Center",
    );
  });

  it("locks every mutation path when disabled", async () => {
    // Regression (MUL-5150): a keyboard user could Tab to the inline clear
    // button and detach the project while a chat send was in flight,
    // retargeting the lazily-created session. With clearing moved into the
    // popover, `disabled` has a single path to close — the popover.
    const user = userEvent.setup();
    const onUpdate = vi.fn();

    const { unmount } = render(
      withI18n(<ProjectPicker projectId="project-1" onUpdate={onUpdate} disabled />),
    );

    const trigger = screen.getByRole("button", { name: /launch command center/i });
    expect(trigger).toBeDisabled();

    await user.click(trigger);
    expect(screen.queryByPlaceholderText(SEARCH_PLACEHOLDER)).not.toBeInTheDocument();
    expect(onUpdate).not.toHaveBeenCalled();

    // The lock also wins over a controlled `open` — a caller that freezes the
    // picker mid-send cannot leave it hanging open with a live clear row.
    unmount();
    render(withI18n(<ProjectPicker projectId="project-1" onUpdate={onUpdate} disabled open />));
    expect(screen.queryByPlaceholderText(SEARCH_PLACEHOLDER)).not.toBeInTheDocument();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("displays plan codes, sorts coded projects by code, and filters by code", async () => {
    const user = userEvent.setup();
    const prev = mockProjects.current;
    mockProjects.current = [
      { id: "project-2", code: "02", title: "算法平台", icon: null },
      { id: "project-1", code: "01", title: "高质量数据集", icon: null },
    ];
    try {
      renderPicker({ projectId: "project-1" });
      const trigger = screen.getByRole("button", { name: "01 高质量数据集" });
      await user.click(trigger);

      const searchInput = await screen.findByPlaceholderText(SEARCH_PLACEHOLDER);
      const popup = searchInput.closest("[data-slot='popover-content']") as HTMLElement;
      const p1 = within(popup).getByRole("button", { name: "01 高质量数据集" });
      const p2 = within(popup).getByRole("button", { name: "02 算法平台" });
      expect(p1.compareDocumentPosition(p2) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      await user.type(searchInput, "02");
      expect(within(popup).getByRole("button", { name: "02 算法平台" })).toBeVisible();
      expect(within(popup).queryByRole("button", { name: "01 高质量数据集" })).toBeNull();
    } finally {
      mockProjects.current = prev;
    }
  });
});
