import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api, ApiError } from "@multica/core/api";
import type { Issue, IssueBatchReceipt, UpdateIssueRequest } from "@multica/core/types";
import enIssues from "../../locales/en/issues.json";
import { IssueSurfaceSelectionProvider, type IssueSurfaceSelection } from "../surface/selection-context";
import { issueOperationPageFixture } from "../operation-basis-test-fixture";
import { BatchActionToolbar } from "./batch-action-toolbar";

const session = vi.hoisted(() => ({ wsId: "ws-1" }));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => session.wsId }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ issueDetail: (id: string) => `/${session.wsId}/issues/${id}`, cockpit: () => `/${session.wsId}/cockpit` }) }));
vi.mock("../../navigation", () => ({ AppLink: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a> }));
vi.mock("@multica/core/api", async (original) => ({ ...await original<typeof import("@multica/core/api")>(), api: { getIssueOperationBasis: vi.fn(), listIssueStatuses: vi.fn(), batchUpdateIssues: vi.fn(), batchDeleteIssues: vi.fn() } }));
vi.mock("./pickers", () => ({
  StatusPicker: ({ onUpdate }: { onUpdate: (body: Partial<UpdateIssueRequest>) => void }) => <button onClick={() => onUpdate({ status: "done" })}>Choose Done</button>,
  PriorityPicker: () => null, AssigneePicker: () => null,
}));
function issue(id: string): Issue {
  return { id, workspace_id: session.wsId, identifier: `DEL-${id}`, number: 1, title: `Delivery ${id}`, description: null, status: "todo", priority: "none", assignee_type: null, assignee_id: null, creator_type: "member", creator_id: "human", project_id: null, parent_issue_id: null, position: 1, stage: null, start_date: null, due_date: null, metadata: {}, properties: {}, created_at: "2026-10-11T00:00:00Z", updated_at: "2026-10-11T00:00:00Z" };
}
function selection(ids: string[]): IssueSurfaceSelection { return { selectedIds: new Set(ids), select: vi.fn(), deselect: vi.fn(), toggle: vi.fn(), clear: vi.fn() }; }
function wrapper(rows: Issue[], selected: IssueSurfaceSelection, client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })) {
  return <QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { issues: enIssues } }}><IssueSurfaceSelectionProvider selection={selected}><BatchActionToolbar issues={rows} /></IssueSurfaceSelectionProvider></I18nProvider></QueryClientProvider>;
}
function receipt(ids: string[]): IssueBatchReceipt { return { workspace_id: "ws-1", requested_ids: ids, transaction_mode: "per_item", transaction_outcome: "committed", results: ids.map((id) => ({ issue_id: id, outcome: "applied", revision: 2, changed: true })), unconfirmed_ids: [], updated: ids.length }; }
beforeEach(() => {
  vi.clearAllMocks(); session.wsId = "ws-1";
  vi.mocked(api.listIssueStatuses).mockResolvedValue({ statuses: [], categories: ["unstarted", "started", "done", "closed"], total: 0 });
  vi.mocked(api.getIssueOperationBasis).mockImplementation(async (wsId, ids) => issueOperationPageFixture(wsId, ids));
  vi.mocked(api.batchUpdateIssues).mockImplementation(async (_ws, ids) => receipt(ids));
});
describe("batch operation acknowledgement", () => {
  it("uses the selected visible universe and requires explicit consent before excluding a protected issue", async () => {
    vi.mocked(api.getIssueOperationBasis).mockImplementation(async (wsId, ids) => {
      const page = issueOperationPageFixture(wsId, ids);
      const protectedRow = page.items.find((item) => item.issue_id === "b");
      if (protectedRow) protectedRow.status = { state: "allowed", allowed_categories: ["unstarted", "started"], reason_codes: ["formal_review_status"] };
      return page;
    });
    const selected = selection(["a", "b", "outside-window"]);
    render(wrapper([issue("a"), issue("b")], selected));
    await waitFor(() => expect(api.getIssueOperationBasis).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: "Choose Done" }));
    expect(await screen.findByText("2 selected · 1 available · 1 blocked or unchecked")).toBeVisible();
    expect(screen.getByRole("button", { name: "Apply (1)" })).toBeDisabled();
    expect(api.batchUpdateIssues).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("checkbox", { name: "Only apply to available issues (1)" }));
    await userEvent.click(screen.getByRole("button", { name: "Apply (1)" }));
    await waitFor(() => expect(api.batchUpdateIssues).toHaveBeenCalledWith("ws-1", ["a"], { status: "done" }, { expected_revisions: { a: 1 } }));
    expect(vi.mocked(api.getIssueOperationBasis).mock.calls.every((call) => !call[1].includes("outside-window"))).toBe(true);
  });
  it("keeps partial results visible and removes only acknowledged successes from selection", async () => {
    const result: IssueBatchReceipt = { ...receipt(["a", "b", "c"]), transaction_outcome: "partial", updated: 1, results: [{ issue_id: "a", outcome: "applied", revision: 2, changed: true }, { issue_id: "b", outcome: "rejected", code: "revision_conflict" }, { issue_id: "c", outcome: "not_attempted", code: "batch_stopped" }] };
    vi.mocked(api.batchUpdateIssues).mockRejectedValue(new ApiError("Review changed", 409, "Conflict", result));
    const selected = selection(["a", "b", "c"]); render(wrapper([issue("a"), issue("b"), issue("c")], selected));
    await waitFor(() => expect(api.getIssueOperationBasis).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: "Choose Done" }));
    expect(await screen.findByRole("region", { name: "Operation results" })).toHaveTextContent("1 applied · 2 not applied · 0 unconfirmed");
    expect(screen.getByText("Rejected")).toBeVisible(); expect(screen.getByText("Not attempted")).toBeVisible();
    expect(screen.getByText(enIssues.revision.conflict)).toBeVisible();
    expect(selected.deselect).toHaveBeenCalledExactlyOnceWith(["a"]); expect(selected.clear).not.toHaveBeenCalled();
    expect(screen.getByText("Status · Done")).toBeVisible(); expect(api.batchUpdateIssues).toHaveBeenCalledTimes(1);
  });
  it("does not replay an unconfirmed request when checking its current action requirements", async () => {
    vi.mocked(api.batchUpdateIssues).mockRejectedValue(new Error("Connection lost"));
    const selected = selection(["a"]); render(wrapper([issue("a")], selected));
    await waitFor(() => expect(api.getIssueOperationBasis).toHaveBeenCalled()); await userEvent.click(screen.getByRole("button", { name: "Choose Done" }));
    expect(await screen.findByRole("region", { name: "Operation results" })).toHaveTextContent("0 applied · 0 not applied · 1 unconfirmed");
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(api.batchUpdateIssues).toHaveBeenCalledTimes(1); expect(selected.deselect).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Apply \(/ })).not.toBeInTheDocument();
  });
  it("does not show a late result or clear new selection in another workspace", async () => {
    let finish!: (result: IssueBatchReceipt) => void;
    vi.mocked(api.batchUpdateIssues).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const selected = selection(["a"]), client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const view = render(wrapper([issue("a")], selected, client));
    await waitFor(() => expect(api.getIssueOperationBasis).toHaveBeenCalled()); await userEvent.click(screen.getByRole("button", { name: "Choose Done" }));
    await waitFor(() => expect(api.batchUpdateIssues).toHaveBeenCalledTimes(1));
    session.wsId = "ws-2"; const newSelection = selection(["new"]); view.rerender(wrapper([issue("new")], newSelection, client));
    await act(async () => finish(receipt(["a"])));
    expect(screen.queryByRole("region", { name: "Operation results" })).not.toBeInTheDocument();
    expect(newSelection.deselect).not.toHaveBeenCalled(); expect(api.batchUpdateIssues).toHaveBeenCalledTimes(1);
  });
});
