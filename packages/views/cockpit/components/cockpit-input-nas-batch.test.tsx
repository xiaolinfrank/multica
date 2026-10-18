import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import { advanceCockpitInputForm, beginCockpitInputNASBatch, cockpitInputDraftKey, emptyCockpitInputForm, setCockpitInputForm, useCockpitInputDraftStore } from "@multica/core/cockpit";
import { CockpitInputNASBatch } from "./cockpit-input-nas-batch";
import { CockpitInputEndedRegistrations } from "./cockpit-input-ended-registrations";
import { inputHeader, inputPrincipal, inputVersion, INPUT_ID, INPUT_KEY, INPUT_MEMBER, INPUT_MEETING, INPUT_TIME, INPUT_VERSION, INPUT_WS } from "./input-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";

const navigation = { pathname: "/ws/cockpit", searchParams: new URLSearchParams(), push: vi.fn() };
vi.mock("../../navigation", () => ({ useNavigation: () => navigation }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { getCockpitInputs: vi.fn(), createCockpitInput: vi.fn(), submitCockpitInputVersion: vi.fn(), getCockpitInputVersionBatch: vi.fn() } }));
beforeEach(() => { vi.clearAllMocks(); useCockpitInputDraftStore.getState().clearDraft(); });

describe("NAS input registration", () => {
  it("registers selected NAS files as independent inputs without meeting reference commands", async () => {
    const parentKey = cockpitInputDraftKey(INPUT_WS, INPUT_MEMBER, "nas", INPUT_MEETING, "");
    const selectionId = "b1000000-0000-4000-8000-000000000040";
    setCockpitInputForm(parentKey, { ...emptyCockpitInputForm(INPUT_KEY), sourceSelections: [{ selectionId, rootId: INPUT_KEY,
      relativePath: "meeting/source.txt", observationToken: "observed", filename: "source.txt", sizeBytes: 6, modifiedAt: null }] });
    vi.mocked(api.createCockpitInput).mockImplementation(async (_ws, body) => ({ workspaceId: INPUT_WS, commandKey: body.commandKey, action: "input_create", replayed: false,
      receipt: { ...body, inputRevision: 1, inputId: INPUT_ID, requestHash: "a".repeat(64), principal: inputPrincipal(), createdAt: INPUT_TIME },
      current: inputHeader({ title: body.title }) }));
    vi.mocked(api.submitCockpitInputVersion).mockImplementation(async (_ws, inputId, body) => ({ workspaceId: INPUT_WS, inputId, commandKey: body.commandKey, action: "input_version_submit", replayed: false,
      receipt: { commandKey: body.commandKey, requestHash: "b".repeat(64), inputId, inputRevision: 2, versionId: INPUT_VERSION, versionNumber: 1, source: body.source,
        payloadKind: "file", captureState: "queued", transferId: null, transferRevision: null, principal: inputPrincipal(), acceptedAt: INPUT_TIME }, current: null, transfer: null }));
    vi.mocked(api.getCockpitInputs).mockResolvedValue({ workspaceId: INPUT_WS, items: [inputHeader()], total: 1, pageSize: 100, nextCursor: null, canCreate: true,
      scope: { ids: [INPUT_ID], projectId: null, meetingId: null, agendaId: null, originIssueId: null, q: "", archive: "all", sourceKind: "" } });
    vi.mocked(api.getCockpitInputVersionBatch).mockResolvedValue({ workspaceId: INPUT_WS, requestedIds: [INPUT_VERSION], items: [inputVersion()], unavailableIds: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const finished = vi.fn();
    const view = render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}>
      <CockpitInputNASBatch wsId={INPUT_WS} accountId={INPUT_MEMBER} meetingId={INPUT_MEETING} draftKey={parentKey} canAdd targetLabel="Selected files"
        onOpenVersion={vi.fn()} onRepair={vi.fn()} onBack={vi.fn()} onFinished={finished} />
    </I18nProvider></QueryClientProvider>);
    try {
      fireEvent.click(screen.getByRole("button", { name: enCockpit.input_materials.register_selection }));
      const finish = await screen.findByRole("button", { name: enCockpit.input_materials.finish_batch });
      await waitFor(() => expect(finish).toBeEnabled());
      expect(api.createCockpitInput).toHaveBeenCalledExactlyOnceWith(INPUT_WS, expect.objectContaining({ title: "source.txt", projectId: null, originIssueId: null }));
      expect(api.submitCockpitInputVersion).toHaveBeenCalledExactlyOnceWith(INPUT_WS, INPUT_ID, expect.objectContaining({ expectedRevision: 1,
        source: expect.objectContaining({ kind: "nas_file", nasFile: { rootId: INPUT_KEY, relativePath: "meeting/source.txt", observationToken: "observed" } }) }));
      expect(vi.mocked(api.submitCockpitInputVersion).mock.calls[0]?.[2]).not.toHaveProperty("initialReference");
      fireEvent.click(finish);
      expect(finished).toHaveBeenCalledOnce();
      expect(useCockpitInputDraftStore.getState().draft.forms[parentKey]?.batch).toBeNull();
    } finally { view.unmount(); client.clear(); }
  });
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
