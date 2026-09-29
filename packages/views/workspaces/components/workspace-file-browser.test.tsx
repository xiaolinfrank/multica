import { describe, it, expect, beforeEach, vi } from "vitest";
import { cleanup, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderWithI18n } from "../../test/i18n";

// The whole publish flow talks to the API boundary; mock it there per the
// repo testing rules (no store/transport mocking deeper in).
const apiMocks = vi.hoisted(() => ({
  fetchWorkspaceTree: vi.fn(),
  readWorkspaceFile: vi.fn(),
  downloadWorkspaceFile: vi.fn(),
  uploadFile: vi.fn(),
}));
vi.mock("@multica/core/api", () => ({ api: apiMocks }));

const commentMocks = vi.hoisted(() => ({ mutateAsync: vi.fn() }));
vi.mock("@multica/core/issues/mutations", () => ({
  useCreateComment: () => ({ mutateAsync: commentMocks.mutateAsync }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { api } from "@multica/core/api";
import { toast } from "sonner";
import { WorkspaceFileExplorer, WORKSPACE_PUBLISH_MAX_BYTES } from "./workspace-file-browser";

const PUBLISH = { issueId: "i1", agentLabel: "Agent One" };

function renderExplorer(publish: typeof PUBLISH | null = PUBLISH) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderWithI18n(
    <QueryClientProvider client={qc}>
      <WorkspaceFileExplorer wsId="ws-1" taskShort="abcd1234" publish={publish} />
    </QueryClientProvider>,
  );
}

async function selectReport() {
  const row = await screen.findByRole("button", { name: /report\.md/ });
  fireEvent.click(row);
  // The preview pane is ready once its file content query has resolved.
  await waitFor(() => expect(api.readWorkspaceFile).toHaveBeenCalled());
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  apiMocks.fetchWorkspaceTree.mockResolvedValue({
    status: "completed",
    data: {
      entries: [{ path: "workdir/report.md", size: 12, is_dir: false }],
      truncated: false,
    },
  });
  apiMocks.readWorkspaceFile.mockResolvedValue({
    status: "completed",
    data: { path: "workdir/report.md", size: 12, is_text: true, content: "# hi", truncated: false },
  });
  apiMocks.downloadWorkspaceFile.mockResolvedValue({
    status: "completed",
    data: {
      path: "workdir/report.md",
      size: 12,
      mime: "text/markdown",
      encoding: "base64",
      content: "aGVsbG8gd29ybGQ=", // "hello world"
      is_image: false,
      too_large: false,
    },
  });
  apiMocks.uploadFile.mockResolvedValue({ id: "att-1" });
  commentMocks.mutateAsync.mockResolvedValue({ id: "c1" });
});

describe("publish as deliverable", () => {
  it("hides the action when the explorer has no publish target", async () => {
    renderExplorer(null);
    await selectReport();
    expect(
      screen.queryByRole("button", { name: /publish/i }),
    ).not.toBeInTheDocument();
  });

  it("uploads the file as a comment attachment on its issue", async () => {
    renderExplorer();
    await selectReport();
    fireEvent.click(screen.getByRole("button", { name: /publish as deliverable/i }));

    await waitFor(() =>
      expect(api.downloadWorkspaceFile).toHaveBeenCalledWith("ws-1", "abcd1234", "workdir/report.md"),
    );
    await waitFor(() => expect(commentMocks.mutateAsync).toHaveBeenCalled());

    const uploadCall = apiMocks.uploadFile.mock.calls[0];
    if (!uploadCall) throw new Error("uploadFile was not called");
    const [file, opts] = uploadCall;
    expect((file as File).name).toBe("report.md");
    expect((file as File).type).toBe("text/markdown");
    expect(opts).toEqual({ issueId: "i1" });

    const commentCall = commentMocks.mutateAsync.mock.calls[0];
    if (!commentCall) throw new Error("createComment was not called");
    const [comment] = commentCall;
    expect(comment.attachmentIds).toEqual(["att-1"]);
    // The comment names the workspace's agent as the file's origin; the file
    // itself is carried by the attachment card, not the body text.
    expect(comment.content).toContain("Agent One");
    expect(toast.success).toHaveBeenCalled();
  });

  it("refuses to publish when the download op reports too_large", async () => {
    apiMocks.downloadWorkspaceFile.mockResolvedValue({
      status: "completed",
      data: { path: "workdir/report.md", size: 0, mime: "", content: "", is_image: false, too_large: true },
    });
    renderExplorer();
    await selectReport();
    fireEvent.click(screen.getByRole("button", { name: /publish as deliverable/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(apiMocks.uploadFile).not.toHaveBeenCalled();
    expect(commentMocks.mutateAsync).not.toHaveBeenCalled();
  });

  it("disables the action for files above the download-op cap", async () => {
    apiMocks.fetchWorkspaceTree.mockResolvedValue({
      status: "completed",
      data: {
        entries: [
          { path: "workdir/report.md", size: WORKSPACE_PUBLISH_MAX_BYTES + 1, is_dir: false },
        ],
        truncated: false,
      },
    });
    renderExplorer();
    await selectReport();
    const button = screen.getByRole("button", { name: /too large to publish/i });
    expect(button).toBeDisabled();
    expect(apiMocks.downloadWorkspaceFile).not.toHaveBeenCalled();
  });
});
