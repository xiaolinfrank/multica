import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithI18n } from "../test/i18n";

const mocks = vi.hoisted(() => ({
  createModule: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@multica/core/modules/mutations", () => ({
  useCreateModule: () => ({ mutateAsync: mocks.createModule }),
}));

vi.mock("@multica/core/paths", () => ({
  useCurrentWorkspace: () => ({ id: "workspace-1", name: "Test Workspace" }),
}));

// The picker owns project selection and has its own tests; the modal is opened
// with a project already chosen, which is how every real entry point opens it.
vi.mock("../projects/components/project-picker", () => ({
  ProjectPicker: () => <div data-testid="project-picker" />,
}));

vi.mock("../editor", () => ({
  TitleEditor: ({
    placeholder,
    onChange,
  }: {
    placeholder?: string;
    onChange?: (value: string) => void;
  }) => (
    <input
      aria-label={placeholder}
      placeholder={placeholder}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));

vi.mock("@multica/ui/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

import { CreateModuleModal } from "./create-module";

const PATH = "/Volumes/人机协作空间/AI医药联合创新平台/01高质量数据集";

function renderModal(onClose = vi.fn()) {
  renderWithI18n(<CreateModuleModal onClose={onClose} data={{ projectId: "project-1" }} />);
  return onClose;
}

beforeEach(() => {
  mocks.createModule.mockReset().mockResolvedValue({ id: "module-1" });
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
});

describe("CreateModuleModal collaboration space", () => {
  it("sends the collaboration space alongside the title", async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByRole("textbox", { name: "Module name" }), "Datasets");
    await user.type(screen.getByRole("textbox", { name: "Collaboration space" }), PATH);
    await user.click(screen.getByRole("button", { name: "Create module" }));

    expect(mocks.createModule).toHaveBeenCalledWith({
      project_id: "project-1",
      title: "Datasets",
      collab_path: PATH,
    });
  });

  // Create has no prior value to clear, so an untouched field must be absent
  // from the payload rather than an explicit null.
  it("omits the field entirely when it is left blank", async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByRole("textbox", { name: "Module name" }), "Datasets");
    await user.click(screen.getByRole("button", { name: "Create module" }));

    expect(mocks.createModule).toHaveBeenCalledWith({
      project_id: "project-1",
      title: "Datasets",
    });
  });

  it("blocks the create on a path the server would reject", async () => {
    const user = userEvent.setup();
    const onClose = renderModal();

    await user.type(screen.getByRole("textbox", { name: "Module name" }), "Datasets");
    await user.type(
      screen.getByRole("textbox", { name: "Collaboration space" }),
      "01高质量数据集",
    );
    await user.click(screen.getByRole("button", { name: "Create module" }));

    expect(mocks.createModule).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByText("Enter an absolute path, such as /Volumes/share/project."),
    ).toBeInTheDocument();
  });
});
