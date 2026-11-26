import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithI18n } from "../test/i18n";

const mocks = vi.hoisted(() => ({
  createWorkItem: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@multica/core/cockpit", () => ({
  useCreateCockpitWorkItem: () => ({ mutateAsync: mocks.createWorkItem }),
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "workspace-1",
}));

vi.mock("@multica/core/paths", () => ({
  useCurrentWorkspace: () => ({ id: "workspace-1", name: "Test Workspace" }),
}));

// The pickers own project/module selection and have their own tests; the
// stubs expose just the callbacks the modal wires together.
vi.mock("../projects/components/project-picker", () => ({
  ProjectPicker: ({
    projectId,
    onUpdate,
  }: {
    projectId: string | null;
    onUpdate: (updates: { project_id?: string | null }) => void;
  }) => (
    <div data-testid="project-picker" data-project={projectId ?? ""}>
      <button type="button" onClick={() => onUpdate({ project_id: "project-2" })}>
        change-project
      </button>
    </div>
  ),
}));

vi.mock("../projects/components/module-picker", () => ({
  ModulePicker: ({
    projectId,
    moduleId,
    onUpdate,
  }: {
    projectId: string | null;
    moduleId: string | null;
    onUpdate: (updates: { module_id?: string | null }) => void;
  }) => (
    <div data-testid="module-picker" data-project={projectId ?? ""} data-module={moduleId ?? ""}>
      <button type="button" onClick={() => onUpdate({ module_id: "module-1" })}>
        pick-module
      </button>
    </div>
  ),
}));

vi.mock("../editor", () => ({
  TitleEditor: ({
    placeholder,
    onChange,
    onSubmit,
  }: {
    placeholder?: string;
    onChange?: (value: string) => void;
    onSubmit?: () => void;
  }) => (
    <input
      aria-label={placeholder}
      placeholder={placeholder}
      onChange={(e) => onChange?.(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSubmit?.();
      }}
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

import { CreateWorkItemModal } from "./create-work-item";

function renderModal(
  data: Record<string, unknown> | null = { projectId: "project-1", moduleId: "module-1" },
  onClose = vi.fn(),
) {
  renderWithI18n(<CreateWorkItemModal onClose={onClose} data={data} />);
  return onClose;
}

const titleField = () => screen.getByRole("textbox", { name: "Work item name" });
const submitButton = () => screen.getByRole("button", { name: "Create work item" });

beforeEach(() => {
  mocks.createWorkItem.mockReset().mockResolvedValue({ id: "work-item-1" });
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
});

describe("CreateWorkItemModal", () => {
  it("creates the work item from the prefilled project and module", async () => {
    const user = userEvent.setup();
    const onClose = renderModal();

    expect(screen.getByTestId("project-picker")).toHaveAttribute("data-project", "project-1");
    expect(screen.getByTestId("module-picker")).toHaveAttribute("data-module", "module-1");

    await user.type(titleField(), "Grammar pass");
    await user.click(submitButton());

    expect(mocks.createWorkItem).toHaveBeenCalledWith({
      module_id: "module-1",
      name: "Grammar pass",
      creation_key: expect.any(String),
    });
    expect(onClose).toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Work item created");
  });

  it("clears the module when the project changes", async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole("button", { name: "change-project" }));

    expect(screen.getByTestId("project-picker")).toHaveAttribute("data-project", "project-2");
    expect(screen.getByTestId("module-picker")).toHaveAttribute("data-module", "");
    expect(screen.getByTestId("module-picker")).toHaveAttribute("data-project", "project-2");
    await user.type(titleField(), "Grammar pass");
    expect(submitButton()).toBeDisabled();
  });

  it("keeps submit disabled until both a name and a module are present", async () => {
    const user = userEvent.setup();
    renderModal({ projectId: "project-1" });

    expect(submitButton()).toBeDisabled();
    await user.type(titleField(), "Grammar pass");
    expect(submitButton()).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "pick-module" }));
    expect(submitButton()).toBeEnabled();
  });

  it("keeps the modal and draft open after a failure, reusing the creation key on retry", async () => {
    mocks.createWorkItem.mockRejectedValueOnce(new Error("network down"));
    const user = userEvent.setup();
    const onClose = renderModal();

    await user.type(titleField(), "Grammar pass");
    await user.click(submitButton());

    expect(mocks.toastError).toHaveBeenCalledWith("network down");
    expect(onClose).not.toHaveBeenCalled();
    expect(titleField()).toHaveValue("Grammar pass");

    await user.click(submitButton());
    await expect.poll(() => mocks.createWorkItem.mock.calls.length).toBe(2);
    const [first, second] = mocks.createWorkItem.mock.calls as [
      [{ creation_key: string }],
      [{ creation_key: string }],
    ];
    expect(second[0].creation_key).toBe(first[0].creation_key);
    expect(onClose).toHaveBeenCalled();
  });
});
