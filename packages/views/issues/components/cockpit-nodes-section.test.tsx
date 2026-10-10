// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@multica/core/api";
import type { CockpitIssueNodeReference, CockpitIssueReferencePage } from "@multica/core/types";
import { WorkspaceSlugProvider } from "@multica/core/paths";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider } from "../../navigation";
import type { NavigationAdapter } from "../../navigation/types";
import { CockpitNodesSection } from "./cockpit-nodes-section";
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/api", () => ({ api: { getCockpit: vi.fn(), getCockpitIssueNodeReferences: vi.fn(), getCockpitPrimaryNode: vi.fn(), getCockpitNodeIndex: vi.fn(), appendCockpitNodeIssue: vi.fn(), removeCockpitIssueNodeReference: vi.fn() } }));
vi.mock("../../cockpit/components/cockpit-node-choice", () => ({ CockpitNodeChoicePicker: ({ onSelect, disabled, label }: { onSelect: (node: { id: string }) => Promise<unknown>; disabled?: boolean; label: string }) => <button disabled={disabled} onClick={() => void onSelect({ id: "node-3" })}>{label}</button> }));
const adapter: NavigationAdapter = { push: vi.fn(), replace: vi.fn(), back: vi.fn(), pathname: "/", searchParams: new URLSearchParams(), hash: "", getShareableUrl: (path) => path };
const ref = (id = "node-2", title = "Execution"): CockpitIssueNodeReference => ({ node_id: id, code: "02", title, available: true, relation: "reference", can_unlink: true });
let page: CockpitIssueReferencePage<CockpitIssueNodeReference>;
function renderSection(issueId = "issue-1") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return renderWithI18n(<QueryClientProvider client={client}><WorkspaceSlugProvider slug="acme"><NavigationProvider value={adapter}><CockpitNodesSection issueId={issueId} /></NavigationProvider></WorkspaceSlugProvider></QueryClientProvider>);
}
beforeEach(() => {
  cleanup(); vi.clearAllMocks();
  page = { workspace_id: "ws-1", issue_id: "issue-1", items: [ref()], total: 1, next_cursor: null };
  vi.mocked(api.getCockpitIssueNodeReferences).mockImplementation(async () => structuredClone(page));
  vi.mocked(api.getCockpitPrimaryNode).mockResolvedValue({ issue_id: "issue-1", node_id: null, node_code: "", node_name: "", project_id: null, module_id: null, revision: 0 });
  vi.mocked(api.getCockpitNodeIndex).mockResolvedValue({ workspace_id: "ws-1", total: 1, items: [{ id: "node-2", parent_id: null, code: "02", position: 0 }] });
  vi.mocked(api.removeCockpitIssueNodeReference).mockImplementation(async (_ws, issueId, targetId) => {
    page.items = page.items.filter((item) => item.node_id !== targetId); page.total = page.items.length;
    return { workspace_id: "ws-1", issue_id: issueId, kind: "node", target_id: targetId, removed: true };
  });
  vi.mocked(api.appendCockpitNodeIssue).mockResolvedValue({ id: "link-1", node_id: "node-3", issue_id: "issue-1", issue_number: 1, issue_identifier: "BIO-1", issue_title: "Issue", issue_status: "backlog", position: 0 } as Awaited<ReturnType<typeof api.appendCockpitNodeIssue>>);
});
describe("bounded issue work-item references", () => {
  it("reads this issue's reference page without loading the full board", async () => {
    renderSection();
    expect(await screen.findByRole("link", { name: "02 Execution" })).toHaveAttribute("href", "/acme/cockpit?node=node-2");
    expect(api.getCockpitIssueNodeReferences).toHaveBeenCalledWith("ws-1", "issue-1", { cursor: undefined }, expect.any(AbortSignal));
    expect(api.getCockpit).not.toHaveBeenCalled();
  });
  it("keeps primary ownership separate from removable references", async () => {
    vi.mocked(api.getCockpitPrimaryNode).mockResolvedValue({ issue_id: "issue-1", node_id: "primary", node_code: "01", node_name: "Primary execution", project_id: "p", module_id: "m", revision: 2 });
    renderSection();
    expect(await screen.findByRole("link", { name: "01 Primary execution" })).toHaveAttribute("href", "/acme/cockpit?node=primary");
    expect(screen.queryByRole("button", { name: /Unlink.*Primary execution/ })).toBeNull();
    expect(await screen.findByRole("button", { name: "Unlink 02 Execution" })).toBeEnabled();
  });
  it("appends one reference without replacing an unseen node collection", async () => {
    renderSection(); await screen.findByRole("link", { name: "02 Execution" });
    fireEvent.click(screen.getByRole("button", { name: "Add work item" }));
    await waitFor(() => expect(api.appendCockpitNodeIssue).toHaveBeenCalledWith("ws-1", "node-3", "issue-1"));
    fireEvent.click(screen.getByRole("button", { name: "Unlink 02 Execution" }));
    await waitFor(() => expect(api.removeCockpitIssueNodeReference).toHaveBeenCalledWith("ws-1", "issue-1", "node-2"));
  });
  it("cleans an unavailable reference only after the explicit Issue-side command is confirmed", async () => {
    page.items = [{ ...ref("missing", ""), available: false, can_unlink: true, code: "" }]; renderSection();
    await screen.findByText("Work item unavailable"); expect(screen.queryByRole("link")).toBeNull();
    expect(api.removeCockpitIssueNodeReference).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove unavailable work-item reference missing" }));
    await waitFor(() => expect(api.removeCockpitIssueNodeReference).toHaveBeenCalledWith("ws-1", "issue-1", "missing"));
    await waitFor(() => expect(screen.queryByText("Work item unavailable")).toBeNull());
  });
  it("preserves encoded identities and accessible unnamed work items", async () => {
    const id = "node/1?scope=a&b"; page.items = [{ ...ref(id, ""), code: "" }]; renderSection();
    const row = await screen.findByRole("link", { name: "Untitled work item" });
    const href = `/acme/cockpit?node=${encodeURIComponent(id)}`; expect(row).toHaveAttribute("href", href);
    fireEvent.click(row); expect(adapter.push).toHaveBeenCalledWith(href);
  });
  it("uses server totals and continuation cursors, resetting when a different issue opens", async () => {
    page.total = 30; page.next_cursor = "next";
    vi.mocked(api.getCockpitIssueNodeReferences).mockImplementation(async (_ws, issue, query) => ({ ...page, issue_id: issue, items: [ref(query?.cursor ? "node-3" : "node-2", query?.cursor ? "Next page" : "Execution")], next_cursor: query?.cursor ? null : "next" }));
    const first = renderSection(); await screen.findByRole("link", { name: "02 Execution" }); fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByRole("link", { name: "02 Next page" });
    expect(api.getCockpitIssueNodeReferences).toHaveBeenLastCalledWith("ws-1", "issue-1", { cursor: "next" }, expect.any(AbortSignal));
    first.unmount(); renderSection("issue-2"); await screen.findByRole("link", { name: "02 Execution" });
    expect(api.getCockpitIssueNodeReferences).toHaveBeenLastCalledWith("ws-1", "issue-2", { cursor: undefined }, expect.any(AbortSignal));
  });
  it("shows a recoverable read failure instead of declaring references empty", async () => {
    vi.mocked(api.getCockpitIssueNodeReferences).mockRejectedValue(new Error("Unavailable")); renderSection();
    await screen.findByRole("alert"); expect(screen.queryByText("No work items linked.")).toBeNull();
    vi.mocked(api.getCockpitIssueNodeReferences).mockResolvedValue(page); fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("link", { name: "02 Execution" });
  });
  it("keeps the empty add entry and collapse control usable", async () => {
    page.items = []; page.total = 0; renderSection(); await screen.findByText("No work items linked.");
    expect(screen.getByRole("button", { name: "Add work item" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /Work items/ })); expect(screen.queryByRole("button", { name: "Add work item" })).toBeNull();
  });
});
