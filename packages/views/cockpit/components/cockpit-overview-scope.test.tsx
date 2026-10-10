import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CockpitSchema, CockpitNodeSchema } from "@multica/core/api/schemas";
import { I18nProvider } from "@multica/core/i18n/react";
import enCockpit from "../../locales/en/cockpit.json";
import { CockpitOverview } from "./cockpit-overview";

describe("business overview scope", () => {
  it("keeps context hierarchy while excluding ancestor budgets and renders the bounded meeting slot", () => {
    const board = { cockpit: CockpitSchema.parse({ id: "board", title: "Programme" }), nodes: [
      CockpitNodeSchema.parse({ id: "project", code: "L1-01", name: "Project context", budget_amount: 900 }),
      CockpitNodeSchema.parse({ id: "module", code: "01.01", name: "Selected module", parent_id: "project", budget_amount: 25 }),
    ], payments: [], milestones: [] };
    render(<I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitOverview board={board} contextNodeIds={new Set(["project"])}
      displayCodes={new Map([["project", "01"], ["module", "01.01"]])} today="2026-10-10" meetingsSlot={<div>Bounded meetings slot</div>}
      onPatchBoard={vi.fn()} onPatchNode={vi.fn()} onPatchMilestone={vi.fn()} onCreateMilestone={vi.fn()} onDeleteMilestone={vi.fn()}
      onOpenBranch={vi.fn()} ownerSuggestions={[]} /></I18nProvider>);
    expect(screen.getByText("Bounded meetings slot")).toBeVisible();
    const budget = screen.getByText(enCockpit.overview.fin_budget).closest("div");
    expect(budget).not.toBeNull();
    expect(within(budget!).getByText("25万")).toBeVisible();
    expect(screen.queryByRole("button", { name: enCockpit.node.name })).toBeNull();
    expect(screen.getByRole("button", { name: enCockpit.overview.annual_goal })).toBeEnabled();
    expect(board.nodes[0]?.budget_amount).toBe(900);
  });
});
