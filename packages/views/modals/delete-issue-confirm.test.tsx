import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "@multica/core/api";
import { issueOperationPageFixture } from "../issues/operation-basis-test-fixture";
import enIssues from "../locales/en/issues.json";
import { DeleteIssueConfirmModal } from "./delete-issue-confirm";
import { NavigationProvider } from "../navigation";
import type { NavigationAdapter } from "../navigation";

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/api", async (original) => ({ ...await original<typeof import("@multica/core/api")>(), api: { getIssueOperationBasis: vi.fn() } }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ issueDetail: (id: string) => `/acme/issues/${id}`, cockpit: () => "/acme/cockpit" }) }));

const mockDelete = vi.fn().mockResolvedValue(undefined);
vi.mock("@multica/core/issues/mutations", () => ({
  useDeleteIssue: () => ({ mutateAsync: mockDelete }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("../i18n", () => ({
  useT: () => ({
    t: (sel: (x: Record<string, Record<string, string>>) => string) =>
      sel({
        operation_basis: enIssues.operation_basis,
        delete_issue: {
          title: "Delete issue?",
          description: "This cannot be undone.",
          hint: "Sub-issues are deleted too.",
          cancel: "Cancel",
          confirm: "Delete",
          deleting: "Deleting...",
          toast_deleted: "Issue deleted",
          toast_delete_failed: "Delete failed",
        },
      }),
  }),
}));

function makeAdapter(
  overrides: Partial<NavigationAdapter> = {},
): NavigationAdapter {
  return {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname: "/acme/issues/issue-1",
    searchParams: new URLSearchParams(),
    hash: "",
    getShareableUrl: (p) => p,
    ...overrides,
  };
}

async function deleteWith(
  adapter: NavigationAdapter,
  data: Record<string, unknown> | null,
) {
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><NavigationProvider value={adapter}>
      <DeleteIssueConfirmModal onClose={onClose} data={data} />
    </NavigationProvider></QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByText("Delete")).toBeEnabled());
  fireEvent.click(screen.getByText("Delete"));
  await waitFor(() => expect(mockDelete).toHaveBeenCalledWith("issue-1"));
  return onClose;
}

describe("DeleteIssueConfirmModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getIssueOperationBasis).mockImplementation(async (wsId, ids) => issueOperationPageFixture(wsId, ids));
  });

  it("explains retained history before deletion and keeps a real recovery link without issuing delete", async () => {
    const page = issueOperationPageFixture("ws-1", ["issue-1"]);
    page.items[0]!.delete = { state: "blocked", reason_codes: ["retained_formal_history"] };
    page.items[0]!.targets = [{ kind: "artifact_version", artifact_id: "artifact-1", version_id: "version-1", purpose: "history", label: "Approved interface evidence" }];
    page.items[0]!.targets_total = 1;
    vi.mocked(api.getIssueOperationBasis).mockResolvedValue(page);
    const close = vi.fn();
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><NavigationProvider value={makeAdapter()}><DeleteIssueConfirmModal onClose={close} data={{ issueId: "issue-1" }} /></NavigationProvider></QueryClientProvider>);
    expect(await screen.findByText(enIssues.operation_basis.retained_formal)).toBeVisible();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    const link = screen.getByRole("link", { name: "Approved interface evidence (new tab)" });
    expect(link).toHaveAttribute("href", "/acme/cockpit?tab=artifacts&artifact=artifact-1&artifact_version=version-1");
    expect(link).toHaveAttribute("target", "_blank");
    expect(mockDelete).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  });

  it("does not close or navigate a reopened A confirmation when the first A deletion settles after visiting B", async () => {
    let finish!: () => void;
    mockDelete.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const close = vi.fn(), adapter = makeAdapter({ canGoBack: () => true });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const element = (id: string) => <QueryClientProvider client={client}><NavigationProvider value={adapter}><DeleteIssueConfirmModal onClose={close} data={{ issueId: id, onDeletedFallbackPath: "/acme/issues" }} /></NavigationProvider></QueryClientProvider>;
    const view = render(element("issue-a"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled()); fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith("issue-a"));
    view.rerender(element("issue-b")); await waitFor(() => expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled());
    view.rerender(element("issue-a")); await waitFor(() => expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled());
    await act(async () => finish());
    expect(close).not.toHaveBeenCalled(); expect(adapter.back).not.toHaveBeenCalled(); expect(adapter.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeVisible();
  });

  // The bug this guards (GH #5995): deleting from an issue opened out of My
  // Issues used to hard-push the workspace Issues list, dropping the user's
  // navigation context. The same applied to project lists, search and pins.
  it("returns to the list the issue was opened from", async () => {
    const adapter = makeAdapter({ canGoBack: () => true });

    await deleteWith(adapter, {
      issueId: "issue-1",
      onDeletedFallbackPath: "/acme/issues",
    });

    await waitFor(() => expect(adapter.back).toHaveBeenCalledTimes(1));
    expect(adapter.replace).not.toHaveBeenCalled();
    expect(adapter.push).not.toHaveBeenCalled();
  });

  it("falls back to the workspace list when the issue was opened cold", async () => {
    const adapter = makeAdapter({ canGoBack: () => false });

    await deleteWith(adapter, {
      issueId: "issue-1",
      onDeletedFallbackPath: "/acme/issues",
    });

    await waitFor(() =>
      expect(adapter.replace).toHaveBeenCalledWith("/acme/issues"),
    );
    expect(adapter.back).not.toHaveBeenCalled();
  });

  // List surfaces delete in place (row context menu, batch toolbar): there is
  // no page to leave, so the modal must not navigate at all.
  it("does not navigate when no fallback path is supplied", async () => {
    const adapter = makeAdapter({ canGoBack: () => true });

    const onClose = await deleteWith(adapter, { issueId: "issue-1" });

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(adapter.back).not.toHaveBeenCalled();
    expect(adapter.replace).not.toHaveBeenCalled();
    expect(adapter.push).not.toHaveBeenCalled();
  });

  it("stays put when the delete fails", async () => {
    mockDelete.mockRejectedValueOnce(new Error("nope"));
    const adapter = makeAdapter({ canGoBack: () => true });

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><NavigationProvider value={adapter}>
        <DeleteIssueConfirmModal
          onClose={vi.fn()}
          data={{ issueId: "issue-1", onDeletedFallbackPath: "/acme/issues" }}
        />
      </NavigationProvider></QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText("Delete")).toBeEnabled());
  fireEvent.click(screen.getByText("Delete"));

    await waitFor(() => expect(screen.getByText("Delete")).toBeInTheDocument());
    expect(adapter.back).not.toHaveBeenCalled();
    expect(adapter.replace).not.toHaveBeenCalled();
  });
});
