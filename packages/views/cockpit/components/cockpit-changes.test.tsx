import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import type { CockpitNode, CockpitPendingChange } from "@multica/core/types";
import enCockpit from "../../locales/en/cockpit.json";
import { CockpitChanges } from "./cockpit-changes";

vi.mock("@multica/core/api", () => ({ api: {
  listCockpitChanges: vi.fn(), applyCockpitChange: vi.fn(), rejectCockpitChange: vi.fn(),
  withdrawCockpitChange: vi.fn(), createCockpitChange: vi.fn(),
} }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
import { api } from "@multica/core/api";
import { toast } from "sonner";
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
function show(nodes: CockpitNode[] = [task], onOpenTask = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryDefaults(["cockpit"], { staleTime: Infinity });
  return render(<QueryClientProvider client={client}>
    <I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}>
      <CockpitChanges wsId="ws" nodes={nodes} onOpenTask={onOpenTask} />
    </I18nProvider>
  </QueryClientProvider>);
}

describe("CockpitChanges batch decisions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listCockpitChanges).mockResolvedValue([change("first"), change("second")]);
  });
  it("cancels bulk confirmation without writing", async () => {
    show();
    const bulk = await screen.findByRole("button", { name: "Apply all" });
    await waitFor(() => expect(bulk).toBeEnabled());
    await userEvent.click(bulk);
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(api.applyCockpitChange).not.toHaveBeenCalled();
  });

  it("classifies field values and counts only pending proposals", async () => {
    vi.mocked(api.listCockpitChanges).mockResolvedValue([
      { ...change("add"), old_value: "" },
      change("modify"),
      { ...change("clear"), new_value: "" },
      { ...change("history"), old_value: "", status: "applied" },
    ]);
    show();
    expect(await screen.findByText("Added value 1")).toBeInTheDocument();
    expect(screen.getByText("Modified value 1")).toBeInTheDocument();
    expect(screen.getByText("Cleared value 1")).toBeInTheDocument();
    expect(screen.getByText("Added value")).toBeInTheDocument();
    expect(screen.getByText("Modified value")).toBeInTheDocument();
    expect(screen.getByText("Cleared value")).toBeInTheDocument();
  });

  it("awaits each server decision before applying the next proposal", async () => {
    let finishFirst!: (value: Awaited<ReturnType<typeof api.applyCockpitChange>>) => void;
    vi.mocked(api.applyCockpitChange).mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValue({ node: task, change: { ...change("second"), status: "applied" } });
    show();
    const bulk = await screen.findByRole("button", { name: "Apply all" });
    await waitFor(() => expect(bulk).toBeEnabled());
    await userEvent.click(bulk);
    expect(api.applyCockpitChange).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", { name: "Apply all" });
    fireEvent.click(confirm);
    await waitFor(() => expect(api.applyCockpitChange).toHaveBeenCalledExactlyOnceWith("first"));
    expect(confirm).toBeDisabled();
    expect(screen.getAllByText("Reject").map((label) => label.closest("button")!).every((button) => button.hasAttribute("disabled"))).toBe(true);
    fireEvent.click(screen.getAllByText("Reject").map((label) => label.closest("button")!)[0]!);
    fireEvent.click(confirm);
    expect(api.rejectCockpitChange).not.toHaveBeenCalled();
    expect(api.applyCockpitChange).toHaveBeenCalledTimes(1);
    finishFirst({ node: task, change: { ...change("first"), status: "applied" } });
    await waitFor(() => expect(api.applyCockpitChange).toHaveBeenNthCalledWith(2, "second"));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it.each([false, true])("applies older 20 before newer 60 from newest-first API order (timestamp tie: %s)", async (tie) => {
    const older = { ...change("a"), field: "progress", new_value: "20", created_at: "2026-09-18T07:00:00Z" };
    const newer = { ...change("b"), field: "progress", new_value: "60", created_at: tie ? older.created_at : "2026-09-18T08:00:00Z" };
    vi.mocked(api.listCockpitChanges).mockResolvedValue([newer, older]);
    let progress = 0;
    vi.mocked(api.applyCockpitChange).mockImplementation(async (id) => {
      const proposal = id === older.id ? older : newer;
      progress = Number(proposal.new_value);
      return { node: { ...task, progress }, change: { ...proposal, status: "applied" } };
    });
    show();
    const bulk = await screen.findByRole("button", { name: "Apply all" });
    await waitFor(() => expect(bulk).toBeEnabled());
    await userEvent.click(bulk);
    expect(api.applyCockpitChange).not.toHaveBeenCalled();
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Apply all" }));
    await waitFor(() => expect(api.applyCockpitChange).toHaveBeenCalledTimes(2));
    expect(api.applyCockpitChange).toHaveBeenNthCalledWith(1, "a");
    expect(api.applyCockpitChange).toHaveBeenNthCalledWith(2, "b");
    expect(progress).toBe(60);
  });

  it("groups field integrity by root with item totals, complete counts, owners and supplementary fields", async () => {
    vi.mocked(api.listCockpitChanges).mockResolvedValue([]);
    const root = { ...task, id: "root", code: "L1-01", name: "Programme" };
    const incomplete = { ...task, parent_id: root.id, owner: "", start_date: "" };
    const complete = { ...task, id: "complete", parent_id: root.id, name: "Complete task" };
    const open = vi.fn();
    show([root, incomplete, complete], open);
    expect(screen.getByRole("heading", { name: "Check · Required fields missing: 2 · OK 1/2" })).toBeInTheDocument();
    expect(screen.getByText("01 Programme · Required fields missing: 2 · OK 1/2")).toBeInTheDocument();
    expect(screen.getByText("Owner: —")).toBeInTheDocument();
    expect(screen.getByText("Owner: Li")).toBeInTheDocument();
    expect(screen.getByText("Required fields missing: 2: Owner / Start")).toBeInTheDocument();
    expect(screen.getAllByText(/Suggested additions: 9:/)).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: /Review task/ }));
    expect(open).toHaveBeenCalledExactlyOnceWith("task");
  });

  it("stops on a failed decision and leaves later proposals unapplied", async () => {
    vi.mocked(api.applyCockpitChange).mockRejectedValueOnce(new Error("Decision failed"));
    show();
    const bulk = await screen.findByRole("button", { name: "Apply all" });
    await waitFor(() => expect(bulk).toBeEnabled());
    await userEvent.click(bulk);
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply all" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Decision failed"));
    expect(api.applyCockpitChange).toHaveBeenCalledExactlyOnceWith("first");
    expect(toast.success).not.toHaveBeenCalled();
    expect(dialog).toBeInTheDocument();
  });
});
