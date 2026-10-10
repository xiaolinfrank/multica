import { installCockpitTestLayout } from "./test/cockpit-layout-test-fixture";
import { beforeEach as beforeLayout, afterEach as afterLayout } from "vitest";
let restoreLayout = () => {};
beforeLayout(() => { restoreLayout = installCockpitTestLayout(); });
afterLayout(() => restoreLayout());
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import { CockpitBoardSchema } from "@multica/core/api/schemas";
import { useCockpitScopeViewStore, useCockpitChangeDraftStore } from "@multica/core/cockpit";
import type { CockpitNode, CockpitPendingChange, CockpitChangePreview } from "@multica/core/types";
import enCockpit from "../../locales/en/cockpit.json";
import { cockpitPlanFixture } from "./cockpit-read-test-fixture";
import { CockpitChanges } from "./cockpit-changes";
vi.mock("@multica/core/api", () => ({ api: { listCockpitChangePage: vi.fn(), getCockpitChangePreview: vi.fn(), applyReviewedCockpitChange: vi.fn(), rejectCockpitChange: vi.fn(), withdrawCockpitChange: vi.fn(), createCockpitChange: vi.fn(), getCockpitNodeIndex: vi.fn(), getCockpitPlan: vi.fn() } }));
vi.mock("../../navigation", () => ({ useNavigation: () => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams() }), AppLink: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a> }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ cockpit: () => "/ws/cockpit" }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
const task: CockpitNode = {
  id: "task", cockpit_id: "cp", code: "historic-18", parent_id: null, name: "Review task",
  position: 0, color: "", owner: "Li", collaborators: "", start_date: "2026-09-01", end_date: "2026-09-30",
  status: "In progress", progress: 0, deliverable: "", dependencies: "", note: "", current_progress: "",
  vendor: "", budget_category: "", budget_amount: null, exec_status: "", contract: "", source: "",
  updated_by_type: "", updated_by_id: null, created_at: "", updated_at: "",
};
function change(id: string): CockpitPendingChange {
  return { id, cockpit_id: "cp", node_id: task.id, node_code: task.code, node_name: task.name,
    field: "owner", old_value: "Li", new_value: "Wu", source: "manual", reason: "",
    status: "pending", created_by_type: "user", created_by_label: "Reviewer", decided_by_type: "",
    decided_by_label: "", decided_at: null, created_at: "2026-09-18T08:00:00Z", updated_at: "2026-09-18T08:00:00Z" };
}

let changes: CockpitPendingChange[];
const context = { project_id: null, module_id: null, project_title: "", module_title: "" };
function observation(row: CockpitPendingChange): CockpitChangePreview { return { workspace_id: "ws", context, change: row, current_value: row.old_value, conflict: false, review_token: `token-${row.id}` }; }
function applied(preview: CockpitChangePreview) { return { node: task, change: { ...preview.change, old_value: preview.current_value, status: "applied" } }; }
function show(nodes: CockpitNode[] = [task], onOpenTask = vi.fn()) {
  vi.mocked(api.getCockpitNodeIndex).mockResolvedValue({ workspace_id: "ws", items: nodes, total: nodes.length });
  vi.mocked(api.getCockpitPlan).mockResolvedValue({ ...cockpitPlanFixture(CockpitBoardSchema.parse({ cockpit: { id: "cp" }, nodes })), workspace_id: "ws" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitChanges wsId="ws" scope={{ projectId: null, moduleId: null }} onOpenTask={onOpenTask} /></I18nProvider></QueryClientProvider>);
}
async function reviewPage() { const user = userEvent.setup(); const bulk = await screen.findByRole("button", { name: enCockpit.governance.review_page }); await waitFor(() => expect(bulk).toBeEnabled()); await user.click(bulk); const dialog = await screen.findByRole("dialog"); await waitFor(() => expect(within(dialog).getByRole("button", { name: enCockpit.governance.confirm_reviewed })).toBeEnabled()); return { user, dialog, confirm: within(dialog).getByRole("button", { name: enCockpit.governance.confirm_reviewed }) }; }
beforeEach(() => {
  vi.clearAllMocks(); useCockpitScopeViewStore.getState().reset(); useCockpitChangeDraftStore.getState().clearDraft(); changes = [change("first"), change("second")];
  vi.mocked(api.listCockpitChangePage).mockImplementation(async (_ws, _scope, query = {}) => { const items = changes.filter((row) => query.status === "all" || (query.status === "decided" ? row.status !== "pending" : row.status === "pending")); return { workspace_id: "ws", scope: context, q: query.q ?? "", status: query.status ?? "all", items, total: items.length, next_cursor: null, counts: { pending: changes.filter((row) => row.status === "pending").length, decided: changes.filter((row) => row.status !== "pending").length } }; });
  vi.mocked(api.getCockpitChangePreview).mockImplementation(async (_ws, id) => observation(changes.find((row) => row.id === id)!));
  vi.mocked(api.applyReviewedCockpitChange).mockImplementation(async (_ws, preview) => applied(preview));
});
describe("bounded governance queue decisions", () => {
  it("cancels a reviewed-page confirmation without writing or eagerly fetching the plan", async () => {
    show(); const { user, dialog } = await reviewPage(); await user.click(within(dialog).getByRole("button", { name: "Cancel" })); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.applyReviewedCockpitChange).not.toHaveBeenCalled(); expect(api.getCockpitPlan).not.toHaveBeenCalled(); expect(vi.mocked(api.listCockpitChangePage).mock.calls[0]?.[2]).toMatchObject({ status: "pending", page_size: 25 });
  });
  it("classifies values on the displayed page and counts only pending proposals", async () => {
    changes = [{ ...change("add"), old_value: "" }, change("modify"), { ...change("clear"), new_value: "" }, { ...change("history"), old_value: "", status: "applied" }]; show();
    expect(await screen.findByText("Added value 1")).toBeVisible(); expect(screen.getByText("Modified value 1")).toBeVisible(); expect(screen.getByText("Cleared value 1")).toBeVisible();
    expect(screen.getByText("Added value")).toBeVisible(); expect(screen.getByText("Modified value")).toBeVisible(); expect(screen.getByText("Cleared value")).toBeVisible();
  });
  it("awaits each confirmed server write and blocks other decisions while applying a page", async () => {
    let finish!: (value: ReturnType<typeof applied>) => void; vi.mocked(api.applyReviewedCockpitChange).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })); show();
    const { user, confirm } = await reviewPage(); expect(api.applyReviewedCockpitChange).not.toHaveBeenCalled(); await user.click(confirm);
    await waitFor(() => expect(api.applyReviewedCockpitChange).toHaveBeenCalledExactlyOnceWith("ws", observation(change("first")))); expect(confirm).toBeDisabled();
    const rejects = screen.getAllByText("Reject").map((item) => item.closest("button")!); expect(rejects.every((button) => button.disabled)).toBe(true); fireEvent.click(rejects[0]!); fireEvent.click(confirm);
    expect(api.rejectCockpitChange).not.toHaveBeenCalled(); expect(api.applyReviewedCockpitChange).toHaveBeenCalledTimes(1);
    await act(async () => finish(applied(observation(change("first"))))); await waitFor(() => expect(api.applyReviewedCockpitChange).toHaveBeenNthCalledWith(2, "ws", observation(change("second"))));
  });
  it.each([false, true])("reviews older 20 before newer 60 and stops when the first changes the second's observed field (timestamp tie: %s)", async (tie) => {
    const older = { ...change("a"), field: "progress", old_value: "0", new_value: "20", created_at: "2026-09-18T07:00:00Z" };
    const newer = { ...change("b"), field: "progress", old_value: "0", new_value: "60", created_at: tie ? older.created_at : "2026-09-18T08:00:00Z" }; changes = [newer, older]; let progress = "0";
    vi.mocked(api.applyReviewedCockpitChange).mockImplementation(async (_ws, preview) => { if (preview.current_value !== progress) throw Object.assign(new Error("Review the changed value"), { status: 409 }); progress = preview.change.new_value; return applied(preview); });
    show(); const { user, confirm } = await reviewPage(); expect(vi.mocked(api.getCockpitChangePreview).mock.calls.map((call) => call[1])).toEqual(["a", "b"]); await user.click(confirm);
    expect(await screen.findByText("Review the changed value")).toBeVisible(); expect(progress).toBe("20"); expect(api.applyReviewedCockpitChange).toHaveBeenCalledTimes(2); expect(confirm).toBeDisabled();
  });
  it("loads field integrity only on request and retains root totals, owner and supplementary fields", async () => {
    changes = []; const root = { ...task, id: "root", code: "L1-01", name: "Programme" }; const incomplete = { ...task, parent_id: root.id, owner: "", start_date: "" }; const complete = { ...task, id: "complete", parent_id: root.id, name: "Complete task" }; const open = vi.fn(); show([root, incomplete, complete], open);
    expect(api.getCockpitPlan).not.toHaveBeenCalled(); await userEvent.click(screen.getByRole("button", { name: enCockpit.governance.quality }));
    expect(await screen.findByRole("heading", { name: "Check · Required fields missing: 2 · OK 1/2" })).toBeVisible(); expect(screen.getByText("01 Programme · Required fields missing: 2 · OK 1/2")).toBeVisible();
    expect(screen.getByText("Owner: —")).toBeVisible(); expect(screen.getByText("Owner: Li")).toBeVisible(); expect(screen.getByText("Required fields missing: 2: Owner / Start")).toBeVisible(); expect(screen.getAllByText(/Suggested additions: 9:/)).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: /Review task/ })); expect(open).toHaveBeenCalledExactlyOnceWith("task");
  });
  it("stops on failed application and keeps later proposals unsubmitted", async () => {
    vi.mocked(api.applyReviewedCockpitChange).mockRejectedValueOnce(new Error("Decision failed")); show(); const { user, dialog, confirm } = await reviewPage(); await user.click(confirm);
    expect(await screen.findByText("Decision failed")).toBeVisible(); expect(api.applyReviewedCockpitChange).toHaveBeenCalledExactlyOnceWith("ws", observation(change("first"))); expect(dialog).toBeVisible();
  });
});
