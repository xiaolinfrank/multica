import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import { cockpitInputDraftKey, emptyCockpitInputForm, setCockpitInputForm, useCockpitInputDraftStore } from "@multica/core/cockpit";
import { CockpitNASSelectionRepair } from "./cockpit-meeting-inputs";
import { inputHeader, inputVersion, INPUT_ID, INPUT_MEMBER, INPUT_MEETING, INPUT_VERSION, INPUT_WS } from "./input-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { getCockpitInput: vi.fn(), getCockpitInputSpaces: vi.fn(), createCockpitInput: vi.fn(), submitCockpitInputVersion: vi.fn() } }));
beforeEach(() => { vi.clearAllMocks(); useCockpitInputDraftStore.getState().clearDraft(); });
describe("NAS registration recovery", () => {
  it("requires an explicit review before using an updated record revision and keeps the original input identity and chosen source", async () => {
    const key = cockpitInputDraftKey(INPUT_WS, INPUT_MEMBER, "nas-selection", INPUT_MEETING, INPUT_VERSION);
    const source = { kind: "nas_file", nasFile: { rootId: INPUT_WS, relativePath: "meeting/original.txt", observationToken: "original-observation" }, upload: null, attachment: null, artifactVersion: null };
    setCockpitInputForm(key, { ...emptyCockpitInputForm(INPUT_VERSION), inputId: INPUT_ID, inputRevision: 1, title: "Meeting material", source });
    vi.mocked(api.getCockpitInput).mockResolvedValue(inputHeader({ revision: 2, currentVersion: inputVersion(), versionTotal: 1 }));
    vi.mocked(api.getCockpitInputSpaces).mockResolvedValue({ workspaceId: INPUT_WS, items: [], total: 0 });
    const inspect = vi.fn(); const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitNASSelectionRepair wsId={INPUT_WS} childKey={key} onDone={vi.fn()} onInspect={inspect} /></I18nProvider></QueryClientProvider>);
    try {
      const adopt = await screen.findByRole("button", { name: enCockpit.input_materials.use_current_header });
      expect(useCockpitInputDraftStore.getState().draft.forms[key]?.inputRevision).toBe(1);
      fireEvent.click(screen.getByRole("button", { name: enCockpit.input_materials.open_registered }));
      expect(inspect).toHaveBeenCalledExactlyOnceWith(INPUT_ID, INPUT_VERSION);
      fireEvent.click(adopt);
      await waitFor(() => expect(useCockpitInputDraftStore.getState().draft.forms[key]?.inputRevision).toBe(2));
      expect(useCockpitInputDraftStore.getState().draft.forms[key]).toMatchObject({ inputId: INPUT_ID, versionId: null, source });
      expect(api.createCockpitInput).not.toHaveBeenCalled(); expect(api.submitCockpitInputVersion).not.toHaveBeenCalled();
    } finally { view.unmount(); client.clear(); }
  });
});
