import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Module } from "@multica/core/types";
import { renderWithI18n } from "../test/i18n";

const mocks = vi.hoisted(() => ({
  modules: { current: [] as Module[], isLoading: false },
  updateModule: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: mocks.modules.current,
    isLoading: mocks.modules.isLoading,
  }),
}));

vi.mock("@multica/core/modules/queries", () => ({
  moduleListOptions: () => ({ queryKey: ["modules"] }),
}));

vi.mock("@multica/core/modules/mutations", () => ({
  useUpdateModule: () => ({ mutateAsync: mocks.updateModule }),
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "workspace-1",
}));

vi.mock("@multica/ui/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

import { EditModuleModal } from "./edit-module";

const MODULE: Module = {
  id: "module-1",
  workspace_id: "workspace-1",
  project_id: "project-1",
  title: "Datasets",
  description: "Retrospective cohorts",
  position: 0,
  created_at: "2026-06-01T00:00:00Z",
  updated_at: "2026-06-01T00:00:00Z",
  issue_count: 2,
  done_count: 0,
};

function renderModal(onClose = vi.fn(), moduleId: string | undefined = MODULE.id) {
  renderWithI18n(<EditModuleModal onClose={onClose} data={{ moduleId }} />);
  return onClose;
}

beforeEach(() => {
  mocks.modules.current = [MODULE];
  mocks.modules.isLoading = false;
  mocks.updateModule.mockReset().mockResolvedValue(MODULE);
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
});

describe("EditModuleModal", () => {
  it("seeds every field from the module it was opened for", () => {
    renderModal();

    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Datasets");
    expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
      "Retrospective cohorts",
    );
  });

  // A module's deliverables land in a folder named after it inside the
  // project's collaboration space, so the module has no path to edit here.
  it("offers no collaboration space field", () => {
    renderModal();

    expect(
      screen.queryByRole("textbox", { name: "Collaboration space" }),
    ).not.toBeInTheDocument();
  });

  it("saves the two fields it owns and closes once the server confirms", async () => {
    const user = userEvent.setup();
    const onClose = renderModal();

    const name = screen.getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "Governance");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mocks.updateModule).toHaveBeenCalledWith({
      id: MODULE.id,
      title: "Governance",
      description: "Retrospective cohorts",
    });
    expect(onClose).toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Module updated");
  });

  // The update contract reads an absent key as "keep the current value", so a
  // description the user emptied has to travel as an explicit null — dropping
  // the key would silently keep the old text in the agent's brief.
  it("sends an emptied description as null rather than dropping the key", async () => {
    const user = userEvent.setup();
    renderModal();

    await user.clear(screen.getByRole("textbox", { name: "Description" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mocks.updateModule).toHaveBeenCalledWith({
      id: MODULE.id,
      title: "Datasets",
      description: null,
    });
  });

  // Dialog contract: a rejected save keeps the typed values on screen.
  it("keeps the dialog open with its input when the save fails", async () => {
    mocks.updateModule.mockRejectedValue(new Error("title is required"));
    const user = userEvent.setup();
    const onClose = renderModal();

    await user.clear(screen.getByRole("textbox", { name: "Name" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Renamed");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Renamed");
    expect(mocks.toastError).toHaveBeenCalledWith("title is required");
  });

  it("refuses to save an empty name", async () => {
    const user = userEvent.setup();
    renderModal();

    await user.clear(screen.getByRole("textbox", { name: "Name" }));

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  // The module can be deleted from another client while this dialog is queued.
  it("says so when the module is no longer in the workspace", () => {
    mocks.modules.current = [];

    renderModal();

    expect(screen.getByText("This module no longer exists.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
  });
});
