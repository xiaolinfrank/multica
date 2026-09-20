/**
 * Collaboration-space paths inside rendered content.
 *
 * Agents name where they saved a deliverable in ordinary prose. Asking them to
 * wrap it in a special syntax would put the burden on every model in the fleet
 * and break the first time one forgot, so the renderer finds the path itself —
 * which is what these tests pin down, end to end through the real markdown
 * pipeline rather than against the detector in isolation.
 *
 * The `.md` case is a regression fixture: `preprocessLinks` has its own
 * extension-based file-path detector, and before this it claimed
 * `/Volumes/share/report.md` and emitted a site-relative anchor. Clicking it
 * dispatched an in-app navigation to a route that does not exist, so the link
 * looked real and did nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithI18n } from "../test/i18n";

const mocks = vi.hoisted(() => ({
  copyText: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@multica/ui/lib/clipboard", () => ({ copyText: mocks.copyText }));
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

vi.mock("../issues/hooks", () => ({ useResolveIssueIdentifier: () => null }));

vi.mock("@multica/core/api", () => ({
  api: { getAttachmentTextContent: vi.fn() },
  PreviewTooLargeError: class extends Error {},
  PreviewUnsupportedError: class extends Error {},
}));

vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({
    issueDetail: (id: string) => `/acme/issues/${id}`,
    projectDetail: (id: string) => `/acme/projects/${id}`,
  }),
  useWorkspaceSlug: () => "acme",
}));

vi.mock("../editor/link-hover-card", () => ({
  useLinkHover: () => ({}),
  LinkHoverCard: () => null,
}));

import { RichContent } from "./rich-content";

const PATH = "/Volumes/人机协作空间/AI医药联合创新平台/01高质量数据集";

beforeEach(() => {
  mocks.copyText.mockReset().mockResolvedValue(true);
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
});

describe("local paths in rendered content", () => {
  it("turns a path written in prose into an actionable control", () => {
    renderWithI18n(<RichContent content={`报告已写入 ${PATH}，请查收。`} />);

    expect(screen.getByRole("button", { name: PATH })).toBeInTheDocument();
  });

  it("does not leave a path as a link that navigates nowhere", () => {
    const path = "/Volumes/share/report.md";
    const { container } = renderWithI18n(
      <RichContent content={`写到 ${path} 了`} />,
    );

    expect(container.querySelector(`a[href="${path}"]`)).toBeNull();
    expect(screen.getByRole("button", { name: path })).toBeInTheDocument();
  });

  it("acts on the path when clicked", async () => {
    const user = userEvent.setup();
    renderWithI18n(<RichContent content={`报告在 ${PATH}`} />);

    await user.click(screen.getByRole("button", { name: PATH }));

    // No desktop bridge in jsdom, so this is the browser branch.
    expect(mocks.copyText).toHaveBeenCalledWith(PATH);
  });

  it("leaves a path inside inline code as code", () => {
    const { container } = renderWithI18n(
      <RichContent content={`run \`ls ${PATH}\``} />,
    );

    expect(screen.queryByRole("button", { name: PATH })).not.toBeInTheDocument();
    expect(container.querySelector("code")?.textContent).toContain(PATH);
  });

  it("leaves a machine-local path as plain text", () => {
    renderWithI18n(<RichContent content="config lives at /etc/hosts" />);

    expect(
      screen.queryByRole("button", { name: "/etc/hosts" }),
    ).not.toBeInTheDocument();
  });

  // The href the detector emits must survive rehype-sanitize; an unlisted
  // scheme is stripped to nothing and the path would render as bare text.
  it("keeps the detected path through the sanitizer", () => {
    renderWithI18n(<RichContent content={`见 ${PATH}`} />);

    const button = screen.getByRole("button", { name: PATH });
    expect(button).toHaveAttribute("data-local-path");
  });
});
