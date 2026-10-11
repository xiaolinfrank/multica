import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import { CockpitInputVersionPicker } from "./cockpit-input-version-picker";
import { inputHeader, inputVersion, INPUT_ID, INPUT_WS } from "./input-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";

vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ cockpit: () => "/ws/cockpit", issueDetail: (id: string) => `/ws/issues/${id}` }) }));
vi.mock("../../navigation", () => ({ AppLink: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a> }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { getCockpitInputs: vi.fn(), getCockpitInput: vi.fn(), getCockpitInputVersions: vi.fn() } }));
beforeEach(() => vi.clearAllMocks());

describe("shared fixed input version picker", () => {
  it("returns from an expired history cursor to the first page without dropping the selected fixed version", async () => {
    const fixed = inputVersion(); const header = inputHeader({ currentVersion: fixed, versionTotal: 30 });
    vi.mocked(api.getCockpitInputs).mockResolvedValue({ workspaceId: INPUT_WS, scope: { ids: [], projectId: null, meetingId: null, agendaId: null, originIssueId: null, q: "", archive: "active", sourceKind: "" }, pageSize: 25, items: [header], total: 1, nextCursor: null, canCreate: true });
    vi.mocked(api.getCockpitInput).mockResolvedValue(header);
    vi.mocked(api.getCockpitInputVersions).mockImplementation(async (_ws, _id, query) => {
      if (query?.cursor) throw new Error("Expired cursor");
      return { workspaceId: INPUT_WS, inputId: INPUT_ID, pageSize: 25, items: [fixed], total: 30, nextCursor: "page-two" };
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitInputVersionPicker wsId={INPUT_WS} selectedVersionIds={[fixed.id]} onSelect={vi.fn()} /></I18nProvider></QueryClientProvider>);
    try {
      fireEvent.click(await screen.findByRole("button", { name: /Original meeting recording/ }));
      fireEvent.click(await screen.findByRole("button", { name: enCockpit.task_flow.next }));
      fireEvent.click(await screen.findByRole("button", { name: enCockpit.task_flow.first_page }));
      expect(await screen.findByRole("button", { name: "Select Original meeting recording, version 1" })).toBeDisabled();
      expect(screen.getByText("Selected 1 / 200")).toBeVisible();
    } finally { view.unmount(); client.clear(); }
  });

  it("selects an explicit historical version without replacing it with the current version", async () => {
    const historical = inputVersion({ availability: "unavailable", canDownload: false });
    const latest = inputVersion({ id: "b1000000-0000-4000-8000-000000000021", versionNumber: 2, contentHash: "b".repeat(64) });
    const header = inputHeader({ currentVersion: latest, versionTotal: 2 });
    vi.mocked(api.getCockpitInputs).mockResolvedValue({ workspaceId: INPUT_WS, scope: { ids: [], projectId: null, meetingId: null, agendaId: null, originIssueId: null, q: "", archive: "active", sourceKind: "" },
      pageSize: 25, items: [header], total: 1, nextCursor: null, canCreate: true });
    vi.mocked(api.getCockpitInput).mockResolvedValue(header);
    vi.mocked(api.getCockpitInputVersions).mockResolvedValue({ workspaceId: INPUT_WS, inputId: INPUT_ID, pageSize: 25, items: [latest, historical], total: 2, nextCursor: null });
    const select = vi.fn(); const inspect = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}>
      <CockpitInputVersionPicker wsId={INPUT_WS} selectedVersionIds={[]} onSelect={select} onInspect={inspect} />
    </I18nProvider></QueryClientProvider>);
    try {
      expect(api.getCockpitInputVersions).not.toHaveBeenCalled();
      fireEvent.click(await screen.findByRole("button", { name: /Original meeting recording/ }));
      const choose = await screen.findByRole("button", { name: "Select Original meeting recording, version 1" });
      expect(screen.getByText("Fixed copy is currently unavailable")).toBeVisible();
      fireEvent.click(choose);
      expect(select).toHaveBeenCalledExactlyOnceWith(historical);
      expect(select).not.toHaveBeenCalledWith(latest);
      expect(api.getCockpitInputVersions).toHaveBeenCalledExactlyOnceWith(INPUT_WS, INPUT_ID, { pageSize: 25, cursor: undefined }, expect.any(AbortSignal));
      fireEvent.click(screen.getByRole("button", { name: "View registered material" }));
      expect(inspect).toHaveBeenCalledExactlyOnceWith(INPUT_ID);
    } finally { view.unmount(); client.clear(); }
  });
});
