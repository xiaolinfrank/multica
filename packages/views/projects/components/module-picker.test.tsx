import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multica/core/i18n/react";
import enProjects from "../../locales/en/projects.json";
import enIssues from "../../locales/en/issues.json";
import { ModulePicker } from "./module-picker";
import { PillButton } from "../../common/pill-button";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: [
      { id: "module-1", title: "Parser rewrite", project_id: "project-1" },
      { id: "module-2", title: "Sync engine", project_id: "project-1" },
    ],
  }),
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "workspace-1",
}));

vi.mock("@multica/core/modules/queries", () => ({
  moduleListOptions: () => ({ queryKey: ["modules"] }),
}));

function withI18n(children: React.ReactNode) {
  return (
    <I18nProvider locale="en" resources={{ en: { projects: enProjects, issues: enIssues } }}>
      {children}
    </I18nProvider>
  );
}

// Real PropertyPicker (Popover), like the project picker tests: clearing
// lives inside the popover, so the tests have to open it.
function renderPicker(props: Partial<React.ComponentProps<typeof ModulePicker>> = {}) {
  return render(
    withI18n(
      <ModulePicker
        moduleId="module-1"
        projectId="project-1"
        onUpdate={props.onUpdate ?? vi.fn()}
        triggerRender={<PillButton />}
        {...props}
      />,
    ),
  );
}

const SEARCH_PLACEHOLDER = "Search modules...";

describe("ModulePicker", () => {
  it("selects another module from the list", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();

    renderPicker({ onUpdate });

    await user.click(screen.getByRole("button", { name: /parser rewrite/i }));
    await user.click(await screen.findByRole("button", { name: /sync engine/i }));

    expect(onUpdate).toHaveBeenCalledWith({ module_id: "module-2" });
  });

  it("clears the module from the No module row", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();

    renderPicker({ onUpdate });

    await user.click(screen.getByRole("button", { name: /parser rewrite/i }));
    await user.click(await screen.findByRole("button", { name: /no module/i }));

    expect(onUpdate).toHaveBeenCalledWith({ module_id: null });
  });

  it("keeps the clear row first while searching", async () => {
    // The empty value is the fixed first row of every picker in the app; a
    // typed query must not move or hide it (same contract as the project
    // picker).
    const user = userEvent.setup();
    const onUpdate = vi.fn();

    renderPicker({ onUpdate });

    await user.click(screen.getByRole("button", { name: /parser rewrite/i }));
    await user.type(await screen.findByPlaceholderText(SEARCH_PLACEHOLDER), "zzzznomatch");

    await user.click(screen.getByRole("button", { name: /no module/i }));
    expect(onUpdate).toHaveBeenCalledWith({ module_id: null });
  });

  it("locks without a project instead of offering an empty menu", async () => {
    // A module belongs to exactly one project: with no project selected
    // there is nothing to pick, so the trigger shows the hint and never
    // opens — mirroring how a disabled picker may not be latched open.
    const user = userEvent.setup();
    const onUpdate = vi.fn();

    render(withI18n(<ModulePicker moduleId={null} projectId={null} onUpdate={onUpdate} />));

    const trigger = screen.getByRole("button", { name: /select a project first/i });
    expect(trigger).toBeDisabled();

    await user.click(trigger);
    expect(screen.queryByPlaceholderText(SEARCH_PLACEHOLDER)).not.toBeInTheDocument();
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
