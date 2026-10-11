import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api, ApiError } from "@multica/core/api";
import { cockpitInputVersionOptions, useCockpitInputDraftStore } from "@multica/core/cockpit";
import { CockpitInputInspector } from "./cockpit-input-inspector";
import { inputHeader, inputVersion, INPUT_ID, INPUT_MEMBER, INPUT_VERSION, INPUT_WS } from "./input-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";

const navigation = { pathname: "/ws/cockpit", searchParams: new URLSearchParams(), push: vi.fn() };
vi.mock("../../navigation", () => ({ useNavigation: () => navigation, AppLink: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a> }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ cockpit: () => "/ws/cockpit", issueDetail: (id: string) => `/ws/issues/${id}` }) }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { verifyCockpitInputVersion: vi.fn(), getCockpitInput: vi.fn(), getCockpitInputVersion: vi.fn(), getCockpitMeetingDetail: vi.fn(), getCockpitMeetingInputReferences: vi.fn(), getCockpitInputCapabilities: vi.fn() } }));
beforeEach(() => {
  vi.clearAllMocks(); useCockpitInputDraftStore.getState().clearDraft();
  navigation.searchParams = new URLSearchParams(`tab=gantt&input=${INPUT_ID}&input_version=${INPUT_VERSION}`);
  vi.mocked(api.getCockpitInput).mockResolvedValue(inputHeader({ currentVersion: inputVersion() }));
  vi.mocked(api.getCockpitInputVersion).mockResolvedValue({ workspaceId: INPUT_WS, inputId: INPUT_ID, version: inputVersion(), content: null, captureError: "" });
});
function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitInputInspector wsId={INPUT_WS} accountId={INPUT_MEMBER} inputsAvailable={false} /></I18nProvider></QueryClientProvider>);
  return { ...view, client };
}
describe("global fixed material inspector", () => {
  it("shows asynchronous copy verification as checking and offers download only after the real available result", async () => {
    let version = inputVersion({ availability: "unknown", canDownload: false });
    vi.mocked(api.getCockpitInputVersion).mockImplementation(async () => ({ workspaceId: INPUT_WS, inputId: INPUT_ID, version, content: null, captureError: "" }));
    vi.mocked(api.verifyCockpitInputVersion).mockImplementation(async () => {
      version = { ...version, availability: "checking", canDownload: false, canVerify: false };
      return version;
    });
    const view = show();
    try {
      fireEvent.click(await screen.findByRole("button", { name: enCockpit.input_materials.verify_version }));
      expect(await screen.findByText(enCockpit.input_materials.verifying)).toBeVisible();
      expect(screen.queryByRole("button", { name: enCockpit.input_materials.download_version })).toBeNull();
      expect(screen.getByText(/^Last checked:/)).toBeVisible();
      version = { ...version, availability: "available", canDownload: true, canVerify: true };
      await act(async () => { await view.client.invalidateQueries({ queryKey: cockpitInputVersionOptions(INPUT_WS, INPUT_ID, INPUT_VERSION).queryKey }); });
      expect(await screen.findByRole("button", { name: enCockpit.input_materials.download_version })).toBeEnabled();
      expect(api.verifyCockpitInputVersion).toHaveBeenCalledExactlyOnceWith(INPUT_WS, INPUT_ID, INPUT_VERSION);
    } finally { view.unmount(); view.client.clear(); }
  });

  it("opens an exact input-only deep link even when new registration is disabled and closes back to the same view", async () => {
    const view = show();
    try {
      await screen.findByText("Original meeting recording");
      expect(await screen.findByRole("button", { name: enCockpit.input_materials.download_version })).toBeEnabled();
      expect(api.getCockpitInputVersion).toHaveBeenCalledWith(INPUT_WS, INPUT_ID, INPUT_VERSION, expect.any(AbortSignal));
      expect(api.getCockpitMeetingDetail).not.toHaveBeenCalled(); expect(api.getCockpitInputCapabilities).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(navigation.push).toHaveBeenCalledExactlyOnceWith("/ws/cockpit?tab=gantt");
    } finally { view.unmount(); view.client.clear(); }
  });
  it("never substitutes the current version when an explicitly linked historical version cannot be read", async () => {
    const latest = inputVersion({ id: "b1000000-0000-4000-8000-000000000099", versionNumber: 2 });
    vi.mocked(api.getCockpitInput).mockResolvedValue(inputHeader({ currentVersion: latest, versionTotal: 2 }));
    vi.mocked(api.getCockpitInputVersion).mockRejectedValue(new ApiError("Version unavailable", 404, "Not Found"));
    const view = show();
    try {
      await screen.findByText(enCockpit.task_flow.load_failed);
      await waitFor(() => expect(api.getCockpitInputVersion).toHaveBeenCalledTimes(1));
      expect(vi.mocked(api.getCockpitInputVersion).mock.calls[0]?.[2]).toBe(INPUT_VERSION);
      expect(screen.queryByRole("button", { name: enCockpit.input_materials.download_version })).toBeNull();
      expect(screen.queryByText("Version 2")).toBeNull();
    } finally { view.unmount(); view.client.clear(); }
  });
});
