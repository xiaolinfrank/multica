// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@multica/core/api";
import type { AgentTask } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";

// Canonical coverage for stopping one run. Two surfaces render this button —
// the execution log row and the live process fold in the main column — and
// neither repeats this matrix; they assert only that the button is there.

vi.mock("@multica/core/api", () => ({
  api: { cancelTask: vi.fn() },
}));

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError } }));

import { CancelTaskButton } from "./cancel-task-button";

const cancelTask = vi.mocked(api.cancelTask);

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task-1",
    agent_id: "agent-1",
    runtime_id: "runtime-1",
    issue_id: "issue-1",
    status: "running",
    priority: 0,
    dispatched_at: null,
    started_at: "2026-09-10T08:00:00Z",
    completed_at: null,
    result: null,
    error: null,
    created_at: "2026-09-10T08:00:00Z",
    ...overrides,
  };
}

function render(task: AgentTask = makeTask()) {
  return renderWithI18n(<CancelTaskButton task={task} issueId="issue-1" />);
}

const clickStop = () =>
  fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));

describe("CancelTaskButton", () => {
  beforeEach(() => {
    cleanup();
    cancelTask.mockReset();
    cancelTask.mockResolvedValue(makeTask({ status: "cancelled" }));
    toastError.mockReset();
  });

  it("confirms before cancelling — a misclick must not kill a long run", () => {
    render();
    clickStop();

    expect(screen.getByText("Stop this run?")).toBeInTheDocument();
    expect(cancelTask).not.toHaveBeenCalled();
  });

  it("cancels the task the user pointed at once they confirm", async () => {
    render();
    clickStop();
    fireEvent.click(screen.getByRole("button", { name: "Stop run" }));

    await waitFor(() => {
      expect(cancelTask).toHaveBeenCalledWith("issue-1", "task-1");
    });
  });

  it("does nothing when the confirm step is dismissed", () => {
    render();
    clickStop();
    fireEvent.click(screen.getByRole("button", { name: "Keep running" }));

    expect(cancelTask).not.toHaveBeenCalled();
  });

  it("warns that dispatched work takes a moment to halt, but not queued work", () => {
    render(makeTask({ status: "running" }));
    clickStop();
    expect(
      screen.getByText(/take a few seconds to fully halt/),
    ).toBeInTheDocument();

    cleanup();
    render(makeTask({ status: "queued" }));
    clickStop();
    expect(
      screen.queryByText(/take a few seconds to fully halt/),
    ).not.toBeInTheDocument();
  });

  it("reports a failed cancel and stays clickable so the user can retry", async () => {
    cancelTask.mockRejectedValue(new Error("task is no longer running"));
    render();
    clickStop();
    fireEvent.click(screen.getByRole("button", { name: "Stop run" }));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("task is no longer running");
    });
    expect(screen.getByRole("button", { name: "Cancel run" })).toBeEnabled();
  });

  it("blocks a second click while the first cancel is in flight", async () => {
    let release: (() => void) | undefined;
    cancelTask.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(makeTask({ status: "cancelled" }));
        }),
    );
    render();
    clickStop();
    fireEvent.click(screen.getByRole("button", { name: "Stop run" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Cancel run" })).toBeDisabled();
    });
    release?.();
  });
});
