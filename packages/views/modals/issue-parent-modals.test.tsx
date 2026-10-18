import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import type { Issue } from "@multica/core/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import enIssues from "../locales/en/issues.json";
import enModals from "../locales/en/modals.json";
import { issueOperationPageFixture } from "../issues/operation-basis-test-fixture";
import { AddChildIssueModal } from "./add-child-issue";
import { SetParentIssueModal } from "./set-parent-issue";

const mocks = vi.hoisted(() => ({ failed: vi.fn(), toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/api", async (original) => ({ ...await original<typeof import("@multica/core/api")>(), api: { getIssue: vi.fn(), listChildIssues: vi.fn(), getIssueOperationBasis: vi.fn(), updateIssue: vi.fn() } }));
vi.mock("./issue-picker-modal", () => ({ IssuePickerModal: ({ onSelect, disabled }: { onSelect: (issue: Issue, signal: AbortSignal) => Promise<void>; disabled?: boolean }) => <button disabled={disabled} onClick={() => void onSelect(issue("selected-1"), new AbortController().signal).catch(mocks.failed)}>Select issue</button> }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ issueDetail: (id: string) => `/ws/issues/${id}`, cockpit: () => "/ws/cockpit" }) }));
vi.mock("../navigation", () => ({ AppLink: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a> }));
function issue(id: string, moduleId: string | null = null): Issue {
  return { id, revision: 7, workspace_id: "ws-1", identifier: id === "selected-1" ? "MUL-2" : "MUL-1", number: 1, title: "Delivery", description: null, status: "todo", priority: "none", assignee_type: null, assignee_id: null, creator_type: "member", creator_id: "human", project_id: "project-1", module_id: moduleId, parent_issue_id: null, position: 1, stage: null, start_date: null, due_date: null, metadata: {}, properties: {}, created_at: "2026-10-11T00:00:00Z", updated_at: "2026-10-11T00:00:00Z" };
}
function setup(Component: typeof SetParentIssueModal) {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><I18nProvider locale="en" resources={{ en: { issues: enIssues, modals: enModals } }}><Component onClose={vi.fn()} data={{ issueId: "issue-1" }} /></I18nProvider></QueryClientProvider>);
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getIssue).mockImplementation(async (id) => issue(id));
  vi.mocked(api.listChildIssues).mockResolvedValue({ issues: [] });
  vi.mocked(api.getIssueOperationBasis).mockImplementation(async (ws, ids) => issueOperationPageFixture(ws, ids));
  vi.mocked(api.updateIssue).mockImplementation(async (id, body) => ({ ...issue(id), ...body }));
});
describe.each([
  { name: "AddChildIssueModal", Component: AddChildIssueModal, writtenId: "selected-1", parentId: "issue-1" },
  { name: "SetParentIssueModal", Component: SetParentIssueModal, writtenId: "issue-1", parentId: "selected-1" },
])("$name", ({ Component, writtenId, parentId }) => {
  it("reports success only after the selected relationship is acknowledged", async () => {
    setup(Component); await waitFor(() => expect(screen.getByRole("button", { name: "Select issue" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Select issue" }));
    await waitFor(() => expect(api.updateIssue).toHaveBeenCalledWith(writtenId, { parent_issue_id: parentId }));
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledOnce()); expect(mocks.failed).not.toHaveBeenCalled();
  });
  it("keeps a failed relationship available to the picker error handling instead of reporting success", async () => {
    vi.mocked(api.updateIssue).mockRejectedValue(new Error("revision conflict"));
    setup(Component); await waitFor(() => expect(screen.getByRole("button", { name: "Select issue" })).toBeEnabled()); fireEvent.click(screen.getByRole("button", { name: "Select issue" }));
    await waitFor(() => expect(mocks.failed).toHaveBeenCalledWith(expect.objectContaining({ message: "revision conflict" })));
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });
  it("allows a protected source to join a same-scope parent but rejects implicit scope changes", async () => {
    vi.mocked(api.getIssueOperationBasis).mockImplementation(async (ws, ids) => {
      const page = issueOperationPageFixture(ws, ids); for (const row of page.items) row.scope = { state: "blocked", reason_codes: ["retained_artifact_scope"] }; return page;
    });
    vi.mocked(api.getIssue).mockImplementation(async (id) => issue(id, id === "selected-1" ? "other-module" : null));
    setup(Component); await waitFor(() => expect(screen.getByRole("button", { name: "Select issue" })).toBeEnabled()); fireEvent.click(screen.getByRole("button", { name: "Select issue" }));
    await waitFor(() => expect(mocks.failed).toHaveBeenCalled()); expect(api.updateIssue).not.toHaveBeenCalled();
    vi.mocked(api.getIssue).mockImplementation(async (id) => issue(id));
    fireEvent.click(screen.getByRole("button", { name: "Select issue" }));
    await waitFor(() => expect(api.updateIssue).toHaveBeenCalledWith(writtenId, { parent_issue_id: parentId }));
  });
});
