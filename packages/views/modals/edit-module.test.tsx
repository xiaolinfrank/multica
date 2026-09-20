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

const PATH = "/Volumes/人机协作空间/AI医药联合创新平台/01高质量数据集";

const MODULE: Module = {
  id: "module-1",
  workspace_id: "workspace-1",
  project_id: "project-1",
  title: "Datasets",
  description: "Retrospective cohorts",
  position: 0,
  collab_path: PATH,
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
    expect(screen.getByRole("textbox", { name: "Collaboration space" })).toHaveValue(PATH);
  });

  it("saves the three fields it owns and closes once the server confirms", async () => {
    const user = userEvent.setup();
    const onClose = renderModal();

    const path = screen.getByRole("textbox", { name: "Collaboration space" });
    await user.clear(path);
    await user.type(path, "/Volumes/人机协作空间/平台/02数据治理");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mocks.updateModule).toHaveBeenCalledWith({
      id: MODULE.id,
      title: "Datasets",
      description: "Retrospective cohorts",
      collab_path: "/Volumes/人机协作空间/平台/02数据治理",
    });
    expect(onClose).toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Module updated");
  });

  // The update contract reads an absent key as "keep the current value", so a
  // field the user emptied has to travel as an explicit null.
  it("sends an emptied field as null rather than dropping the key", async () => {
    const user = userEvent.setup();
    renderModal();

    await user.clear(screen.getByRole("textbox", { name: "Description" }));
    await user.clear(screen.getByRole("textbox", { name: "Collaboration space" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mocks.updateModule).toHaveBeenCalledWith({
      id: MODULE.id,
      title: "Datasets",
      description: null,
      collab_path: null,
    });
  });

  it("blocks the save on a path the server would reject", async () => {
    const user = userEvent.setup();
    const onClose = renderModal();

    const path = screen.getByRole("textbox", { name: "Collaboration space" });
    await user.clear(path);
    await user.type(path, "01高质量数据集");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mocks.updateModule).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByText("Enter an absolute path, such as /Volumes/share/project."),
    ).toBeInTheDocument();
  });

  // Dialog contract: a rejected save keeps the typed values on screen.
  it("keeps the dialog open with its input when the save fails", async () => {
    mocks.updateModule.mockRejectedValue(new Error("collab_path must be an absolute path"));
    const user = userEvent.setup();
    const onClose = renderModal();

    await user.clear(screen.getByRole("textbox", { name: "Name" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Renamed");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Renamed");
    expect(mocks.toastError).toHaveBeenCalledWith(
      "collab_path must be an absolute path",
    );
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
