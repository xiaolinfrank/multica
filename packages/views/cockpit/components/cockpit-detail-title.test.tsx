import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import enCockpit from "../../locales/en/cockpit.json";
import { CockpitDetailTitle } from "./cockpit-detail-title";

function stageHeight(scroll: number, visible: number) {
  vi.spyOn(HTMLHeadingElement.prototype, "scrollHeight", "get").mockReturnValue(scroll);
  vi.spyOn(HTMLHeadingElement.prototype, "clientHeight", "get").mockReturnValue(visible);
}
function setup(title: string) {
  render(<I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitDetailTitle>{title}</CockpitDetailTitle></I18nProvider>);
}
afterEach(() => vi.restoreAllMocks());

describe("cockpit detail titles", () => {
  it("keeps the full heading accessible and expands a measured overflow without changing its title", async () => {
    stageHeight(360, 84);
    const title = "A fixed artifact title that exceeds the visible heading";
    setup(title);
    const heading = screen.getByRole("heading", { level: 1, name: title });
    const expand = screen.getByRole("button", { name: "Show full title" });
    expect(expand).toHaveAttribute("aria-controls", heading.id);
    expect(expand).toHaveAttribute("aria-expanded", "false");
    expect(heading).toHaveClass("line-clamp-3");
    await userEvent.click(expand);
    expect(heading).not.toHaveClass("line-clamp-3");
    expect(screen.getByRole("button", { name: "Collapse title" })).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(screen.getByRole("button", { name: "Collapse title" }));
    expect(heading).toHaveTextContent(title);
    expect(heading).toHaveClass("line-clamp-3");
  });
  it("offers no redundant expansion action when the complete title fits", () => {
    stageHeight(28, 28);
    setup("Verified interface report");
    expect(screen.getByRole("heading", { name: "Verified interface report" })).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
