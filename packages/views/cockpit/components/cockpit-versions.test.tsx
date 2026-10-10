import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import enCockpit from "../../locales/en/cockpit.json";
import { CockpitVersions } from "./cockpit-versions";
vi.mock("@multica/core/api", () => ({ api: { listCockpitSnapshotPage: vi.fn(), listCockpitSnapshots: vi.fn(), getCockpitSnapshotDiff: vi.fn(), createCockpitSnapshot: vi.fn(), deleteCockpitSnapshot: vi.fn(), restoreCockpitSnapshot: vi.fn() } }));
const snapshots = Array.from({ length: 27 }, (_, index) => ({ id: `snapshot-${index + 1}`, label: `Checkpoint ${index + 1}`, trigger_kind: "manual", node_count: 10, created_by_type: "member", created_by_label: "Person", created_at: "2026-10-10T00:00:00Z" }));
function setup() { const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitVersions wsId="ws-1" canRestore hasStableBindings /></I18nProvider></QueryClientProvider>); }
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.listCockpitSnapshotPage).mockImplementation(async (_ws, query = {}) => ({ workspace_id: "ws-1", scope: "workspace", q: query.q ?? "", items: query.cursor ? snapshots.slice(25) : snapshots.slice(0, 25), total: 27, next_cursor: query.cursor ? null : "second-page" })); });
describe("bounded workspace snapshot history", () => {
  it("opens a read-only comparison on demand and explains a legacy snapshot without allowing restore", async () => {
    vi.mocked(api.getCockpitSnapshotDiff).mockResolvedValue({ workspace_id: "ws-1", snapshot_id: "snapshot-1", snapshot_created_at: snapshots[0]!.created_at,
      snapshot_cockpit_id: "", current_cockpit_id: "board", scope: "workspace", generated_at: "2026-10-10T01:00:00Z", comparable: false, reason: "legacy_identity_missing",
      snapshot_complete: false, current_complete: true, snapshot_counts: { nodes: 0, payments: 0, milestones: 0 }, current_counts: { nodes: 10, payments: 0, milestones: 0 },
      counts: { added: 0, removed: 0, modified: 0, unchanged: 0 }, items: [], total: 0, page_size: 25, next_cursor: null, comparison_token: "" });
    setup(); const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: enCockpit.versions.button }));
    expect(await screen.findByText("Checkpoint 1")).toBeVisible(); expect(api.getCockpitSnapshotDiff).not.toHaveBeenCalled();
    await user.click(screen.getAllByRole("button", { name: enCockpit.snapshot_diff.compare })[0]!);
    expect(await screen.findByRole("dialog", { name: enCockpit.snapshot_diff.title })).toBeVisible();
    expect(await screen.findByText(enCockpit.snapshot_diff.legacy)).toBeVisible();
    expect(screen.queryByText(enCockpit.snapshot_diff.empty)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: enCockpit.snapshot_diff.refresh })).not.toBeInTheDocument();
    expect(api.restoreCockpitSnapshot).not.toHaveBeenCalled();
  });
  it("loads metadata only when opened and preserves stable-binding protection across real pages", async () => {
    setup(); expect(api.listCockpitSnapshotPage).not.toHaveBeenCalled(); const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: enCockpit.versions.button }));
    expect(await screen.findByText("Checkpoint 25")).toBeVisible(); expect(screen.queryByText("Checkpoint 26")).toBeNull(); expect(screen.getByText(enCockpit.governance.workspace_history)).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Restore" }).every((button) => button.hasAttribute("disabled"))).toBe(true);
    await user.click(screen.getByRole("button", { name: "Next page" })); expect(await screen.findByText("Checkpoint 27")).toBeVisible(); expect(api.listCockpitSnapshotPage).toHaveBeenLastCalledWith("ws-1", { q: "", cursor: "second-page", page_size: 25 }, expect.any(AbortSignal)); expect(api.listCockpitSnapshots).not.toHaveBeenCalled();
  });
  it("keeps the previous-page action available after a failed continuation", async () => {
    vi.mocked(api.listCockpitSnapshotPage).mockImplementation(async (_ws, query = {}) => { if (query.cursor) throw new Error("cursor expired"); return { workspace_id: "ws-1", scope: "workspace", q: "", items: snapshots.slice(0, 25), total: 27, next_cursor: "second-page" }; });
    setup(); const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: enCockpit.versions.button })); await screen.findByText("Checkpoint 25"); await user.click(screen.getByRole("button", { name: "Next page" })); expect(await screen.findByRole("alert")).toHaveTextContent("Could not load");
    await user.click(screen.getByRole("button", { name: "Previous page" })); await waitFor(() => expect(screen.getByText("Checkpoint 25")).toBeVisible()); expect(screen.queryByText(enCockpit.versions.empty)).toBeNull();
  });
});
