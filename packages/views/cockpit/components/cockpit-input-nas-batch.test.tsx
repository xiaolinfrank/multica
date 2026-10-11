import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import { advanceCockpitInputForm, beginCockpitInputNASBatch, cockpitInputDraftKey, emptyCockpitInputForm, setCockpitInputForm, useCockpitInputDraftStore } from "@multica/core/cockpit";
import { CockpitInputNASBatch } from "./cockpit-input-nas-batch";
import { CockpitInputEndedRegistrations } from "./cockpit-input-ended-registrations";
import { inputHeader, INPUT_ID, INPUT_KEY, INPUT_MEMBER, INPUT_MEETING, INPUT_WS } from "./input-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";

const navigation = { pathname: "/ws/cockpit", searchParams: new URLSearchParams(), push: vi.fn() };
vi.mock("../../navigation", () => ({ useNavigation: () => navigation }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { getCockpitInputs: vi.fn() } }));
beforeEach(() => { vi.clearAllMocks(); useCockpitInputDraftStore.getState().clearDraft(); });

describe("ending this device's NAS registration", () => {
  it("retains the registered material without a fixed version, closes the batch, and offers an explicit local-record removal", async () => {
    const parentKey = cockpitInputDraftKey(INPUT_WS, INPUT_MEMBER, "nas", INPUT_MEETING, "");
    const selectionId = "b1000000-0000-4000-8000-000000000040";
    setCockpitInputForm(parentKey, { ...emptyCockpitInputForm(INPUT_KEY), sourceSelections: [{ selectionId, rootId: INPUT_KEY,
      relativePath: "meeting/obsolete.wav", observationToken: "observed", filename: "obsolete.wav", sizeBytes: 100, modifiedAt: null }] });
    const batch = beginCockpitInputNASBatch(INPUT_WS, INPUT_MEMBER, INPUT_MEETING, parentKey, useCockpitInputDraftStore.getState().draft.forms[parentKey]!);
    advanceCockpitInputForm(batch.childKeys[0]!, selectionId, { inputId: INPUT_ID, inputRevision: 1 });
    vi.mocked(api.getCockpitInputs).mockResolvedValue({ workspaceId: INPUT_WS, items: [inputHeader({ currentVersion: null, versionTotal: 0 })], total: 1, pageSize: 100, nextCursor: null, canCreate: true, scope: { ids: [INPUT_ID], projectId: null, meetingId: null, agendaId: null, originIssueId: null, q: "", archive: "all", sourceKind: "" } });
    const finished = vi.fn(); const inspect = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}>
      <CockpitInputNASBatch wsId={INPUT_WS} accountId={INPUT_MEMBER} meetingId={INPUT_MEETING} draftKey={parentKey} canAdd targetLabel="Meeting materials" onOpenVersion={inspect} onRepair={vi.fn()} onBack={vi.fn()} onFinished={finished} />
      <CockpitInputEndedRegistrations wsId={INPUT_WS} accountId={INPUT_MEMBER} meetingId={INPUT_MEETING} onInspect={inspect} onResume={vi.fn()} />
    </I18nProvider></QueryClientProvider>);
    try {
      fireEvent.click(screen.getByRole("button", { name: enCockpit.input_materials.end_registration }));
      const dialog = await screen.findByRole("dialog", { name: enCockpit.input_materials.end_registration });
      fireEvent.change(within(dialog).getByRole("textbox", { name: enCockpit.input_materials.end_reason }), { target: { value: "No longer needed by the team" } });
      fireEvent.click(within(dialog).getByRole("button", { name: enCockpit.input_materials.end_registration }));
      expect(await screen.findByText(enCockpit.input_materials.registration_ended)).toBeVisible();
      expect(screen.queryByRole("button", { name: enCockpit.input_materials.continue_item })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: enCockpit.input_materials.finish_batch }));
      expect(finished).toHaveBeenCalledOnce();
      expect(useCockpitInputDraftStore.getState().draft.forms[batch.childKeys[0]!]).toMatchObject({ inputId: INPUT_ID, versionId: null, transferId: null });
      fireEvent.click(screen.getByText(/This device’s registration records/));
      expect(await screen.findByText(enCockpit.input_materials.local_records_hint)).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: enCockpit.input_materials.open_registered })); expect(inspect).toHaveBeenCalledWith(INPUT_ID);
      fireEvent.click(screen.getByRole("button", { name: enCockpit.input_materials.remove_local_record }));
      const removal = await screen.findByRole("dialog", { name: enCockpit.input_materials.remove_local_record });
      expect(within(removal).getByText(enCockpit.input_materials.remove_local_record_hint)).toBeVisible();
      fireEvent.click(within(removal).getByRole("button", { name: enCockpit.input_materials.remove_local_record }));
      expect(useCockpitInputDraftStore.getState().draft.forms[batch.childKeys[0]!]).toBeUndefined();
    } finally { view.unmount(); client.clear(); }
  });
});
