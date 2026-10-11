import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import { useCockpitInputDraftStore } from "@multica/core/cockpit";
import { CockpitInputReferenceForm } from "./cockpit-input-reference-form";
import { inputVersion, inputPrincipal, INPUT_ID, INPUT_MEETING, INPUT_MEMBER, INPUT_REFERENCE, INPUT_TIME, INPUT_VERSION, INPUT_WS } from "./input-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";
const navigation = { pathname: "/ws/cockpit", searchParams: new URLSearchParams(`meeting=${INPUT_MEETING}&input=${INPUT_ID}&input_version=${INPUT_VERSION}`) };
vi.mock("../../navigation", () => ({ useNavigation: () => navigation }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { getCockpitInputVersionBatch: vi.fn(), createCockpitInputReference: vi.fn(), removeCockpitInputReference: vi.fn() } }));
beforeEach(() => {
  vi.clearAllMocks(); useCockpitInputDraftStore.getState().clearDraft();
  vi.mocked(api.getCockpitInputVersionBatch).mockResolvedValue({ workspaceId: INPUT_WS, requestedIds: [INPUT_VERSION], items: [inputVersion({ versionNumber: 2 })], unavailableIds: [] });
  vi.mocked(api.createCockpitInputReference).mockImplementation(async (_ws, meetingId, body) => ({ workspaceId: INPUT_WS, commandKey: body.commandKey, action: "input_reference_create", replayed: false, current: null,
    receipt: { ...body, requestHash: "a".repeat(64), referenceId: INPUT_REFERENCE, meetingId, inputId: INPUT_ID, removed: false, principal: inputPrincipal(), acceptedAt: INPUT_TIME } }));
});
describe("explicit fixed-version meeting association", () => {
  it("links exactly the selected new version while explaining that old references remain and never removes them implicitly", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); const done = vi.fn();
    const view = render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitInputReferenceForm wsId={INPUT_WS} accountId={INPUT_MEMBER} meetingId={INPUT_MEETING} versionId={INPUT_VERSION} targetLabel="Project review" canAdd onDone={done} onCancel={vi.fn()} /></I18nProvider></QueryClientProvider>);
    try {
      expect(screen.getByText(enCockpit.input_materials.reference_keeps_previous)).toBeVisible();
      const submit = screen.getByRole("button", { name: enCockpit.input_materials.link_version }); await waitFor(() => expect(submit).toBeEnabled()); fireEvent.click(submit);
      await waitFor(() => expect(done).toHaveBeenCalledOnce());
      expect(api.createCockpitInputReference).toHaveBeenCalledExactlyOnceWith(INPUT_WS, INPUT_MEETING, expect.objectContaining({ inputVersionId: INPUT_VERSION, agendaId: null, purpose: "material" }));
      expect(api.removeCockpitInputReference).not.toHaveBeenCalled();
    } finally { view.unmount(); client.clear(); }
  });
});
