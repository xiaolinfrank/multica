import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api, ApiError } from "@multica/core/api";
import { CockpitIssueInputManifestInspector } from "./cockpit-issue-input-manifest";
import { CockpitInputManifestHistory } from "./cockpit-input-manifest-history";
import { INPUT_ID, INPUT_MEMBER, INPUT_TIME, INPUT_VERSION, INPUT_WS } from "./input-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";
const navigation = { pathname: "/ws/issues/PMO-1", searchParams: new URLSearchParams(), push: vi.fn() };
vi.mock("../../navigation", () => ({ useNavigation: () => navigation }));
vi.mock("@multica/core", () => ({ useWorkspaceId: () => INPUT_WS }));
vi.mock("@multica/core/auth", async (original) => {
  const actual = await original<typeof import("@multica/core/auth")>();
  const state = { user: { id: "b1000000-0000-4000-8000-000000000006" } };
  return { ...actual, useAuthStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state }) };
});
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { getCockpitContext: vi.fn(), getCockpitInputManifestVersion: vi.fn(), getCockpitInputManifestItems: vi.fn(), getCockpitIssueInputManifest: vi.fn() } }));
beforeEach(() => {
  vi.clearAllMocks(); navigation.searchParams = new URLSearchParams(`comment=comment-1&input_manifest=${INPUT_VERSION}`);
  vi.mocked(api.getCockpitInputManifestVersion).mockResolvedValue({ workspaceId: INPUT_WS, issueId: INPUT_ID, id: INPUT_VERSION, versionNumber: 3, commandKey: INPUT_VERSION, manifestHash: "a".repeat(64), itemTotal: 0, requiredTotal: 0, createdBy: INPUT_MEMBER, createdByName: "Owner", createdAt: INPUT_TIME, hasNote: true, note: "Original authorization" });
  vi.mocked(api.getCockpitInputManifestItems).mockResolvedValue({ workspaceId: INPUT_WS, issueId: INPUT_ID, manifestVersionId: INPUT_VERSION, manifestHash: "a".repeat(64), pageSize: 25, items: [], total: 0, nextCursor: null });
});
function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitInputManifestHistory wsId={INPUT_WS} accountId={INPUT_MEMBER} issueId={INPUT_ID} manifestVersionId={INPUT_VERSION} onSelect={vi.fn()} onClose={vi.fn()} /></I18nProvider></QueryClientProvider>);
  return { ...view, client };
}
describe("retained historical input manifest", () => {
  it("opens an exact Issue deep link outside the collapsed sidebar without relying on creation capabilities", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitIssueInputManifestInspector issueId={INPUT_ID} /></I18nProvider></QueryClientProvider>);
    try {
      await screen.findByText("Original authorization");
      expect(api.getCockpitContext).not.toHaveBeenCalled();
      fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]!);
      expect(navigation.push).toHaveBeenCalledExactlyOnceWith("/ws/issues/PMO-1?comment=comment-1");
    } finally { view.unmount(); client.clear(); }
  });
  it("reads the exact saved manifest and its note without substituting the Issue current list", async () => {
    const view = show();
    try {
      expect(await screen.findByText("Original authorization")).toBeVisible();
      expect(screen.getByText(enCockpit.input_materials.manifest_history_notice)).toBeVisible();
      expect(api.getCockpitInputManifestVersion).toHaveBeenCalledWith(INPUT_WS, INPUT_ID, INPUT_VERSION, expect.any(AbortSignal));
      expect(api.getCockpitIssueInputManifest).not.toHaveBeenCalled();
    } finally { view.unmount(); view.client.clear(); }
  });
  it("keeps an unavailable exact historical manifest as an actionable gap", async () => {
    vi.mocked(api.getCockpitInputManifestVersion).mockRejectedValue(new ApiError("Not found", 404, "Not Found"));
    const view = show();
    try {
      expect(await screen.findByText(enCockpit.task_flow.load_failed)).toBeVisible();
      expect(screen.getByRole("button", { name: enCockpit.binding.retry })).toBeEnabled();
      expect(api.getCockpitIssueInputManifest).not.toHaveBeenCalled();
      expect(api.getCockpitInputManifestItems).not.toHaveBeenCalled();
    } finally { view.unmount(); view.client.clear(); }
  });
});
