import { describe, it, expect, vi, beforeEach } from "vitest";
import { render as renderDOM, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "@multica/core/api";
import { issueOperationPageFixture, operationIssueFixture } from "../issues/operation-basis-test-fixture";
import enIssues from "../locales/en/issues.json";
import enCockpit from "../locales/en/cockpit.json";
import { ModuleDetachConfirmModal } from "./module-detach-confirm";

vi.mock("../navigation", () => ({ useNavigation: () => ({ pathname: "/ws/issues", searchParams: new URLSearchParams() }) }));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/api", async (original) => ({ ...await original<typeof import("@multica/core/api")>(), api: { getIssueOperationBasis: vi.fn(), updateIssue: vi.fn() } }));
const mockUpdate = vi.mocked(api.updateIssue);
function render(ui: React.ReactNode) { return renderDOM(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{ui}</QueryClientProvider>); }

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }));

vi.mock("../i18n", () => ({
  useT: () => ({
    t: (sel: (x: Record<string, Record<string, string>>) => string) =>
      sel({
        operation_basis: enIssues.operation_basis,
        directories: enCockpit.directories,
        module_detach: {
          title: "Move out of the parent's module?",
          description: "Moving it removes it from that parent.",
          cancel: "Cancel",
          confirm: "Move and unlink",
          submitting: "Moving...",
          toast_failed: "Failed to move the issue",
        },
        revision: { conflict: "Someone else changed this issue" },
      }),
  }),
}));

describe("ModuleDetachConfirmModal", () => {
  beforeEach(() => {
    mockUpdate.mockClear();
    mockUpdate.mockImplementation(async (id, body) => ({ ...operationIssueFixture(id), ...body }));
    vi.mocked(api.getIssueOperationBasis).mockImplementation(async (ws, ids) => issueOperationPageFixture(ws, ids));
    toastError.mockClear();
  });

  // The two halves travel together: a detach that landed without the move
  // would leave a loose issue still filed in its old parent's module.
  it("applies the move and the detach in one write", async () => {
    const onClose = vi.fn();
    render(
      <ModuleDetachConfirmModal
        onClose={onClose}
        data={{
          issueId: "issue-1",
          issueTitle: "Collect samples",
          updates: { project_id: "project-2", module_id: "module-2" },
        }}
      />,
    );
    await waitFor(() => expect(screen.getByText("Move and unlink")).toBeEnabled());
    fireEvent.click(screen.getByText("Move and unlink"));
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith("issue-1", {
        project_id: "project-2",
        module_id: "module-2",
        parent_issue_id: null,
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("writes nothing when the move is declined", () => {
    const onClose = vi.fn();
    render(
      <ModuleDetachConfirmModal
        onClose={onClose}
        data={{ issueId: "issue-1", issueTitle: "Collect samples", updates: { module_id: null } }}
      />,
    );
    fireEvent.click(screen.getByText("Cancel"));
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("stays open on failure so the move can be retried", async () => {
    mockUpdate.mockRejectedValueOnce(new Error("boom"));
    const onClose = vi.fn();
    render(
      <ModuleDetachConfirmModal
        onClose={onClose}
        data={{ issueId: "issue-1", issueTitle: "Collect samples", updates: { module_id: null } }}
      />,
    );
    await waitFor(() => expect(screen.getByText("Move and unlink")).toBeEnabled());
    fireEvent.click(screen.getByText("Move and unlink"));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("boom"));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Move and unlink")).toBeTruthy();
  });

  it("opens RunningTasksDialog on 409 running_agent_tasks and retries with directory_sync", async () => {
    mockUpdate.mockRejectedValueOnce({
      status: 409,
      body: {
        code: "running_agent_tasks",
        error: "agent tasks are running in this issue's folder; sync now or defer",
        running_tasks: [
          {
            task_id: "task-1",
            issue_id: "issue-1",
            issue_identifier: "BIO-9",
            status: "running",
          },
        ],
      },
    });
    const onClose = vi.fn();
    render(
      <ModuleDetachConfirmModal
        onClose={onClose}
        data={{
          issueId: "issue-1",
          issueTitle: "Collect samples",
          updates: { module_id: "module-2" },
        }}
      />,
    );
    await waitFor(() => expect(screen.getByText("Move and unlink")).toBeEnabled());
    fireEvent.click(screen.getByText("Move and unlink"));

    expect(await screen.findByText("BIO-9")).toBeTruthy();
    expect(toastError).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText(enCockpit.directories.sync_later));
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenLastCalledWith("issue-1", {
        module_id: "module-2",
        parent_issue_id: null,
        directory_sync: "defer",
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
