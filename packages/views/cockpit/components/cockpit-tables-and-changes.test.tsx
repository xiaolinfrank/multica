import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import type { CockpitBoard, CockpitNode, CockpitPendingChange } from "@multica/core/types";
import enCockpit from "../../locales/en/cockpit.json";
import { CockpitTable } from "./cockpit-table";
import { CockpitChanges } from "./cockpit-changes";

vi.mock("@multica/core/api", () => ({ api: {
  listCockpitChanges: vi.fn(), applyCockpitChange: vi.fn(),
  createCockpitChange: vi.fn(), rejectCockpitChange: vi.fn(), withdrawCockpitChange: vi.fn(),
} }));
import { api } from "@multica/core/api";

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
  provider(<><input aria-label="Search the board" defaultValue={query} /><CockpitTable board={{ nodes, payments: [], issue_links: [] } as unknown as CockpitBoard} mode="tasks" query={query} rootIds={new Set()} selectedId={null} onSelect={onSelect} onPatchNode={vi.fn()} statusSuggestions={[]} execStatusSuggestions={[]} budgetCategorySuggestions={[]} ownerSuggestions={[]} /></>);
  return onSelect;
}
function change(id: string): CockpitPendingChange {
  return { id, cockpit_id: "cp", node_id: "leaf", node_code: "old-code", node_name: "Execution task", field: "status", old_value: "Not started", new_value: "In progress", source: "agent", reason: "", status: "pending", created_by_type: "agent", created_by_label: "Agent", decided_by_type: "", decided_by_label: "", decided_at: null, created_at: "2026-09-18T00:00:00Z", updated_at: "2026-09-18T00:00:00Z" };
}
beforeEach(() => vi.clearAllMocks());
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
describe("cockpit pending review", () => {
  it("groups root to task and awaits sequential batch decisions", async () => {
    vi.mocked(api.listCockpitChanges).mockResolvedValue([change("a"), change("b")]);
    let resolveFirst!: (result: { node: CockpitNode; change: CockpitPendingChange }) => void;
    vi.mocked(api.applyCockpitChange).mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; })).mockResolvedValue({ node: nodes[2]!, change: { ...change("b"), status: "applied" } });
    provider(<CockpitChanges wsId="ws" nodes={nodes} onOpenTask={vi.fn()} />);
    const batch = await screen.findByRole("button", { name: "Apply all" });
    expect(screen.getAllByText(/03 Programme/).length).toBeGreaterThan(0);
    await waitFor(() => expect(batch).toBeEnabled());
    fireEvent.click(batch);
    expect(api.applyCockpitChange).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply all" }));
    await waitFor(() => expect(api.applyCockpitChange).toHaveBeenCalledExactlyOnceWith("a"));
    expect(batch).toBeDisabled();
    resolveFirst({ node: nodes[2]!, change: { ...change("a"), status: "applied" } });
    await waitFor(() => expect(api.applyCockpitChange).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.applyCockpitChange).mock.calls[1]).toEqual(["b"]);
  });
  it("stops batch acceptance on failure without applying remaining proposals", async () => {
    vi.mocked(api.listCockpitChanges).mockResolvedValue([change("a"), change("b")]);
    vi.mocked(api.applyCockpitChange).mockRejectedValue(new Error("Conflict"));
    provider(<CockpitChanges wsId="ws" nodes={nodes} onOpenTask={vi.fn()} />);
    const batch = await screen.findByRole("button", { name: "Apply all" });
    await waitFor(() => expect(batch).toBeEnabled());
    fireEvent.click(batch);
    expect(api.applyCockpitChange).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply all" }));
    await waitFor(() => expect(api.applyCockpitChange).toHaveBeenCalledExactlyOnceWith("a"));
    await waitFor(() => expect(batch).not.toBeDisabled());
  });
});
