import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ModuleDetachConfirmModal } from "./module-detach-confirm";

const mockUpdate = vi.fn().mockResolvedValue(undefined);
vi.mock("@multica/core/issues/mutations", () => ({
  useUpdateIssue: () => ({ mutateAsync: mockUpdate }),
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }));

vi.mock("../i18n", () => ({
  useT: () => ({
    t: (sel: (x: Record<string, Record<string, string>>) => string) =>
      sel({
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
    mockUpdate.mockResolvedValue(undefined);
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
    fireEvent.click(screen.getByText("Move and unlink"));
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith({
        id: "issue-1",
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
    fireEvent.click(screen.getByText("Move and unlink"));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("boom"));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Move and unlink")).toBeTruthy();
  });
});
