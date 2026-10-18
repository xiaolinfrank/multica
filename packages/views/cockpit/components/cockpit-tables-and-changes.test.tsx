import { installCockpitTestLayout } from "./test/cockpit-layout-test-fixture";
import { beforeEach as beforeLayout, afterEach as afterLayout } from "vitest";
let restoreLayout = () => {};
beforeLayout(() => { restoreLayout = installCockpitTestLayout(); });
afterLayout(() => restoreLayout());
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("../../navigation", () => ({ useNavigation: () => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams() }) }));
import { buildCockpitDisplayCodesFromIndex } from "@multica/core/cockpit";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import type { CockpitNode } from "@multica/core/types";
import enCockpit from "../../locales/en/cockpit.json";
import { CockpitTable } from "./cockpit-table";


function node(id: string, overrides: Partial<CockpitNode> = {}): CockpitNode {
  return { id, cockpit_id: "cp", parent_id: null, code: id, name: id, position: 0,
    color: "", owner: "Li", collaborators: "", start_date: "2026-01-01", end_date: "2026-12-31",
    status: "In progress", progress: 0, deliverable: "", dependencies: "", note: "",
    current_progress: "", vendor: "", budget_category: "", budget_amount: null, exec_status: "",
    contract: "", source: "", updated_by_type: "", updated_by_id: null, created_at: "", updated_at: "", ...overrides };
}
const nodes = [node("root", { code: "L1-03", name: "Programme" }),
  node("branch", { parent_id: "root", name: "Module" }),
  node("leaf", { parent_id: "branch", name: "Execution task", note: "Hidden-search-marker" })];
function provider(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}>{children}</I18nProvider></QueryClientProvider>);
}
function table(query = "") {
  const onSelect = vi.fn();
  provider(<><input aria-label="Search the board" defaultValue={query} /><CockpitTable board={{ nodes, payments: [] }} displayCodes={buildCockpitDisplayCodesFromIndex(nodes)} contextNodeIds={new Set()} taskCounts={new Map()} mode="tasks" query={query} rootIds={new Set()} selectedId={null} onSelect={onSelect} onPatchNode={vi.fn()} statusSuggestions={[]} execStatusSuggestions={[]} budgetCategorySuggestions={[]} ownerSuggestions={[]} vendorSuggestions={[]} /></>);
  return onSelect;
}
describe("cockpit task table", () => {
  it("shows execution leaves with positional codes and ordered sticky scan columns", () => {
    table();
    const body = document.querySelector("tbody")!;
    expect(within(body).getAllByRole("row")).toHaveLength(1);
    expect(within(body).getByRole("button", { name: "Open 03.01.01" })).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").slice(0, 10).map((cell) => cell.textContent)).toEqual(["Code", "Name", "L1", "L2", "Owner", "Start", "End", "Status", "Progress", "Check"]);
    expect(screen.getByRole("button", { name: "OK" })).toHaveAttribute("title", expect.stringContaining("Deliverable"));
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  });
  it("searches undisplayed fields and Enter locates the first match, ignoring IME", () => {
    const onSelect = table(" hidden-search-marker ");
    expect(document.querySelectorAll("tbody tr")).toHaveLength(1);
    const search = screen.getByRole("textbox", { name: "Search the board" });
    fireEvent.keyDown(search, { key: "Enter", isComposing: true });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("leaf");
  });
});
