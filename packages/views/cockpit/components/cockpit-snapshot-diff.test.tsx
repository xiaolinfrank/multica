import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import type { CockpitSnapshotDiff } from "@multica/core/types";
import enCockpit from "../../locales/en/cockpit.json";
import { CockpitSnapshotDiffDialog } from "./cockpit-snapshot-diff";
vi.mock("@multica/core/api", () => ({ api: { getCockpitSnapshotDiff: vi.fn() } }));
const snapshot = { id: "snapshot", trigger_kind: "manual", label: "Delivery baseline", node_count: 26, created_by_type: "member", created_by_label: "Owner", created_at: "2026-10-10T00:00:00Z" };
function page(): CockpitSnapshotDiff {
  return { workspace_id: "workspace", snapshot_id: "snapshot", snapshot_created_at: snapshot.created_at, snapshot_cockpit_id: "board", current_cockpit_id: "board", scope: "workspace",
    generated_at: "2026-10-10T01:00:00Z", comparable: true, reason: "", snapshot_complete: true, current_complete: true,
    snapshot_counts: { nodes: 26, payments: 0, milestones: 0 }, current_counts: { nodes: 26, payments: 0, milestones: 0 }, counts: { added: 0, removed: 0, modified: 26, unchanged: 0 },
    items: Array.from({ length: 25 }, (_, i) => ({ entity_kind: "node", id: `node-${i}`, change: "modified", code: `L3-${i}`, name: `Delivery ${i}`, field_changes: [{ field: "name", before: { value: i === 0 ? "Original" : `Original ${i}`, truncated: false, sha256: "a".repeat(64) }, after: { value: `Delivery ${i}`, truncated: false, sha256: "b".repeat(64) } }] })),
    total: 26, page_size: 25, next_cursor: "page-two", comparison_token: "c".repeat(64) };
}
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitSnapshotDiffDialog wsId="workspace" snapshot={snapshot} onClose={vi.fn()} /></I18nProvider></QueryClientProvider>);
}
beforeEach(() => vi.clearAllMocks());
describe("plan comparison recovery", () => {
  it("explicitly refreshes an indefinitely cached first page after a changed comparison, without relying on realtime", async () => {
    let firstReads = 0;
    const refreshed = page(); refreshed.comparison_token = "d".repeat(64); refreshed.generated_at = "2026-10-10T02:00:00Z"; refreshed.next_cursor = "fresh-page-two";
    refreshed.items[0]!.field_changes[0]!.before.value = "Refreshed baseline value";
    vi.mocked(api.getCockpitSnapshotDiff).mockImplementation(async (_ws, _id, input) => {
      if (input?.cursor === "page-two") throw Object.assign(new Error("comparison changed"), { status: 409 });
      if (input?.cursor === "fresh-page-two") return { ...refreshed, next_cursor: null, items: [{ ...refreshed.items[0]!, id: "last-node", name: "Last comparison item" }] };
      return ++firstReads === 1 ? page() : refreshed;
    });
    setup(); const user = userEvent.setup(); expect(await screen.findByText("Original")).toBeVisible();
    expect(screen.getByText(enCockpit.snapshot_diff.scope)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(enCockpit.snapshot_diff.refresh_required);
    expect(screen.queryByText("Original")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: enCockpit.snapshot_diff.refresh }));
    await waitFor(() => expect(firstReads).toBe(2)); expect(await screen.findByText("Refreshed baseline value")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(api.getCockpitSnapshotDiff).toHaveBeenLastCalledWith("workspace", "snapshot", { cursor: "fresh-page-two", page_size: 25 }, expect.any(AbortSignal)));
    expect(await screen.findByRole("heading", { name: /Last comparison item/ })).toBeVisible();
  });
  it("shows an explicit capacity limit instead of an empty result or a retry that cannot narrow scope", async () => {
    vi.mocked(api.getCockpitSnapshotDiff).mockRejectedValue(Object.assign(new Error("comparison limit"), { status: 413 }));
    setup(); expect(await screen.findByRole("alert")).toHaveTextContent(enCockpit.snapshot_diff.limit);
    expect(screen.queryByText(enCockpit.snapshot_diff.empty)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: enCockpit.snapshot_diff.refresh })).not.toBeInTheDocument();
  });
});
