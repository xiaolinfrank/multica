import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "@multica/core/api";
import { renderWithI18n } from "../../test/i18n";
import { RunningTasksDialog } from "../../plan-tree/running-tasks-dialog";
import { useIssueSurfaceActions } from "./use-issue-surface-actions";

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError },
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multica/core/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      updateIssue: vi.fn(),
      moveIssue: vi.fn(),
    },
  };
});

const runningTasks409 = () => ({
  status: 409,
  body: {
    code: "running_agent_tasks",
    error: "agent tasks are running in this issue's folder; sync now or defer",
    running_tasks: [
      {
        task_id: "task-1",
        issue_id: "issue-1",
        issue_identifier: "BIO-42",
        status: "running",
      },
    ],
  },
});

const updatedIssue = {
  id: "issue-1",
  workspace_id: "ws-1",
  number: 42,
  identifier: "BIO-42",
  title: "Review dossier",
  description: null,
  status: "in_progress",
  priority: "medium",
  assignee_type: null,
  assignee_id: null,
  creator_type: "member",
  creator_id: "user-1",
  parent_issue_id: null,
  project_id: "project-1",
  module_id: "module-2",
  work_item_id: "wi-2",
  position: 1,
  stage: null,
  start_date: null,
  due_date: null,
  labels: [],
  metadata: {},
  properties: {},
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function SurfaceHarness({
  handlesDirectoryConflict = false,
  onError,
}: {
  handlesDirectoryConflict?: boolean;
  onError?: (err: unknown) => void;
}) {
  const { actions, moveIssue, directoryConflict, dismissDirectoryConflict } =
    useIssueSurfaceActions({ createDefaults: {} });

  return (
    <>
      <button
        type="button"
        onClick={() =>
          actions.updateIssue(
            "issue-1",
            { module_id: "module-2", work_item_id: "wi-2" },
            { handlesDirectoryConflict, onError },
          )
        }
      >
        change-scope
      </button>
      <button
        type="button"
        onClick={() =>
          moveIssue("issue-1", {
            project_id: "project-2",
            before_id: null,
            after_id: null,
          })
        }
      >
        drag-project
      </button>
      <RunningTasksDialog
        conflict={directoryConflict}
        onDismiss={dismissDirectoryConflict}
      />
    </>
  );
}

function renderHarness(props: React.ComponentProps<typeof SurfaceHarness> = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return renderWithI18n(
    <QueryClientProvider client={qc}>
      <SurfaceHarness {...props} />
    </QueryClientProvider>,
  );
}

describe("useIssueSurfaceActions running-agent directory conflict dialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.updateIssue).mockResolvedValue(updatedIssue as never);
    vi.mocked(api.moveIssue).mockResolvedValue(updatedIssue as never);
  });

  it("opens RunningTasksDialog on 409 running_agent_tasks and retries with defer/force", async () => {
    vi.mocked(api.updateIssue)
      .mockRejectedValueOnce(runningTasks409())
      .mockResolvedValueOnce(updatedIssue as never);
    const user = userEvent.setup();
    renderHarness();

    await user.click(screen.getByRole("button", { name: "change-scope" }));

    expect(await screen.findByText("BIO-42")).toBeInTheDocument();
    expect(mocks.toastError).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Sync later" }));

    await waitFor(() =>
      expect(api.updateIssue).toHaveBeenLastCalledWith("issue-1", {
        module_id: "module-2",
        work_item_id: "wi-2",
        directory_sync: "defer",
      }),
    );
    await waitFor(() => expect(screen.queryByText("BIO-42")).toBeNull());
  });

  it("retries with force when Sync now is chosen", async () => {
    vi.mocked(api.updateIssue)
      .mockRejectedValueOnce(runningTasks409())
      .mockResolvedValueOnce(updatedIssue as never);
    const user = userEvent.setup();
    renderHarness();

    await user.click(screen.getByRole("button", { name: "change-scope" }));
    expect(await screen.findByText("BIO-42")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Sync now" }));

    await waitFor(() =>
      expect(api.updateIssue).toHaveBeenLastCalledWith("issue-1", {
        module_id: "module-2",
        work_item_id: "wi-2",
        directory_sync: "force",
      }),
    );
  });

  it("does not open the surface dialog when the caller owns RunningTasksDialog", async () => {
    vi.mocked(api.updateIssue).mockRejectedValueOnce(runningTasks409());
    const onError = vi.fn();
    const user = userEvent.setup();
    renderHarness({ handlesDirectoryConflict: true, onError });

    await user.click(screen.getByRole("button", { name: "change-scope" }));

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("BIO-42")).toBeNull();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("opens RunningTasksDialog when a drag-and-drop move hits running_agent_tasks", async () => {
    vi.mocked(api.moveIssue)
      .mockRejectedValueOnce(runningTasks409())
      .mockResolvedValueOnce(updatedIssue as never);
    const user = userEvent.setup();
    renderHarness();

    await user.click(screen.getByRole("button", { name: "drag-project" }));

    expect(await screen.findByText("BIO-42")).toBeInTheDocument();
    expect(mocks.toastError).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Sync later" }));

    await waitFor(() =>
      expect(api.moveIssue).toHaveBeenLastCalledWith("issue-1", {
        project_id: "project-2",
        directory_sync: "defer",
        before_id: null,
        after_id: null,
      }),
    );
  });
});
