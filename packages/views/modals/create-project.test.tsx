import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithI18n } from "../test/i18n";

const mocks = vi.hoisted(() => ({
  createProject: vi.fn(),
}));

const longRepoUrl =
  "https://github.com/multica-ai/a-very-long-repository-name-that-needs-a-tooltip";
const apiRepoUrl = "https://github.com/multica-ai/api";
const webRepoUrl = "https://github.com/multica-ai/web";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: [] }),
  // The modal now reads the runtime list to gate worktree mode, and
  // runtimeListOptions builds its descriptor with queryOptions.
  queryOptions: (options: unknown) => options,
}));

vi.mock("@multica/core/projects/mutations", () => ({
  useCreateProject: () => ({ mutateAsync: mocks.createProject }),
}));

vi.mock("@multica/core/projects", () => ({
  useProjectDraftStore: (selector: (state: unknown) => unknown) =>
    selector({
      draft: {
        title: "",
        description: "",
        status: "planned",
        priority: "medium",
        leadType: undefined,
        leadId: undefined,
        icon: undefined,
      },
      setDraft: vi.fn(),
      clearDraft: vi.fn(),
    }),
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "workspace-1",
}));

vi.mock("@multica/core/paths", () => ({
  useCurrentWorkspace: () => ({
    id: "workspace-1",
    name: "Test Workspace",
    slug: "test-workspace",
    repos: [{ url: longRepoUrl }, { url: apiRepoUrl }, { url: webRepoUrl }],
  }),
  useWorkspacePaths: () => ({
    projectDetail: (id: string) => `/test-workspace/projects/${id}`,
  }),
}));

vi.mock("@multica/core/workspace/queries", () => ({
  memberListOptions: () => ({ queryKey: ["members"], queryFn: vi.fn() }),
  agentListOptions: () => ({ queryKey: ["agents"], queryFn: vi.fn() }),
}));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: vi.fn() }),
}));

vi.mock("../navigation", () => ({
  useNavigation: () => ({ push: vi.fn() }),
}));

vi.mock("../editor", () => {
  // Mirrors ContentEditorRef: the modal reads the description off the handle
  // (`getMarkdown()`) when it submits, so a bare <textarea> ref would throw
  // inside handleSubmit's try block and silently abort every create.
  const ContentEditor = React.forwardRef<
    { getMarkdown: () => string },
    { placeholder?: string }
  >(({ placeholder }, ref) => {
    const inner = React.useRef<HTMLTextAreaElement>(null);
    React.useImperativeHandle(ref, () => ({
      getMarkdown: () => inner.current?.value ?? "",
    }));
    return <textarea ref={inner} placeholder={placeholder} />;
  });
  ContentEditor.displayName = "ContentEditor";

  return {
    ContentEditor,
    TitleEditor: ({
      placeholder,
      onChange,
    }: {
      placeholder?: string;
      onChange?: (value: string) => void;
    }) => <input placeholder={placeholder} onChange={(e) => onChange?.(e.target.value)} />,
  };
});

vi.mock("../issues/components/priority-icon", () => ({
  PriorityIcon: () => <span data-testid="priority-icon" />,
}));

vi.mock("../common/actor-avatar", () => ({
  ActorAvatar: () => <span data-testid="actor-avatar" />,
}));

// Stub the date pickers so this test doesn't pull the real Calendar (and its
// buttonVariants import) into the modal's module graph; the pickers have their
// own test. The stubs render the placeholder label so the pills are assertable.
vi.mock("../projects/components/project-start-date-picker", () => ({
  ProjectStartDatePicker: () => <button type="button">Start date</button>,
}));

vi.mock("../projects/components/project-due-date-picker", () => ({
  ProjectDueDatePicker: () => <button type="button">Due date</button>,
}));

vi.mock("@multica/ui/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@multica/ui/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ render }: { render: React.ReactNode }) => <>{render}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock("@multica/ui/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ render }: { render: React.ReactNode }) => <>{render}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@multica/ui/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => <>{render}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div role="tooltip">{children}</div>
  ),
}));

vi.mock("@multica/ui/components/ui/button", () => ({
  Button: ({
    children,
    disabled,
    onClick,
    type = "button",
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
    type?: "button" | "submit" | "reset";
  }) => (
    <button type={type} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock("@multica/ui/components/common/emoji-picker", () => ({
  EmojiPicker: () => null,
}));

vi.mock("@multica/ui/lib/utils", () => ({
  cn: (...values: Array<string | false | null | undefined>) =>
    values.filter(Boolean).join(" "),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { CreateProjectModal } from "./create-project";

const COLLAB_PATH = "/Volumes/人机协作空间/AI医药联合创新平台";

beforeEach(() => {
  mocks.createProject.mockReset().mockResolvedValue({ id: "project-1" });
});

describe("CreateProjectModal", () => {
  it("exposes full repository URLs in the repository picker", () => {
    render(<CreateProjectModal onClose={vi.fn()} />);

    // The Tooltip is the single reveal mechanism. A native `title` carrying the
    // same URL would stack a browser tooltip on top of it (MUL-4836).
    expect(screen.getByRole("tooltip", { name: longRepoUrl })).toBeInTheDocument();
    expect(screen.queryByTitle(longRepoUrl)).toBeNull();
  });

  it("reveals the start/due date pickers from the ⋯ overflow menu", async () => {
    const user = userEvent.setup();
    renderWithI18n(<CreateProjectModal onClose={vi.fn()} />);

    // Dates are collapsed behind the overflow by default (progressive disclosure).
    expect(screen.queryByRole("button", { name: "Start date" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Due date" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Set start date/ }));
    expect(screen.getByRole("button", { name: "Start date" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Set due date/ }));
    expect(screen.getByRole("button", { name: "Due date" })).toBeInTheDocument();
  });

  // Collapsed behind ⋯ like the dates: most projects don't have a shared
  // directory, and the ones that do reveal it in one click.
  it("reveals the collaboration space from the ⋯ overflow and sends it", async () => {
    const user = userEvent.setup();
    renderWithI18n(<CreateProjectModal onClose={vi.fn()} />);

    expect(
      screen.queryByRole("textbox", { name: "Collaboration space" }),
    ).not.toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("Project title"), "Platform");
    await user.click(screen.getByRole("button", { name: /Set collaboration space/ }));
    await user.type(
      screen.getByRole("textbox", { name: "Collaboration space" }),
      COLLAB_PATH,
    );
    await user.click(screen.getByRole("button", { name: "Create Project" }));

    expect(mocks.createProject).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Platform", collab_path: COLLAB_PATH }),
    );
  });

  // The path rides in the same call that creates the project and its
  // resources, so a server rejection would fail the whole creation.
  it("does not create the project when the path would be rejected", async () => {
    const user = userEvent.setup();
    renderWithI18n(<CreateProjectModal onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText("Project title"), "Platform");
    await user.click(screen.getByRole("button", { name: /Set collaboration space/ }));
    await user.type(
      screen.getByRole("textbox", { name: "Collaboration space" }),
      "AI医药联合创新平台",
    );
    await user.click(screen.getByRole("button", { name: "Create Project" }));

    expect(mocks.createProject).not.toHaveBeenCalled();
    expect(
      screen.getByText("Enter an absolute path, such as /Volumes/share/project."),
    ).toBeInTheDocument();
  });

  it("filters workspace repositories by search text", async () => {
    const user = userEvent.setup();

    renderWithI18n(<CreateProjectModal onClose={vi.fn()} />);

    const repoSearchInput = screen.getByRole("textbox", { name: "Search repositories..." });

    await user.type(repoSearchInput, "api");

    expect(
      screen.getByRole("button", { name: (name) => name.includes(apiRepoUrl) }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: (name) => name.includes(webRepoUrl) }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: (name) => name.includes(longRepoUrl) }),
    ).not.toBeInTheDocument();

    await user.clear(repoSearchInput);
    await user.type(repoSearchInput, "no-match");

    expect(screen.getByText("No repositories match your search.")).toBeInTheDocument();
  });
});
