import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import { cockpitInputDraftKey, useCockpitInputDraftStore } from "@multica/core/cockpit";
import type { CockpitInputHeader } from "@multica/core/types/cockpit-input";
import { CockpitInputMetadataEditor, CockpitInputArchiveForm } from "./cockpit-input-metadata";
import { inputHeader, inputVersion, INPUT_ID, INPUT_MEMBER, INPUT_TIME, INPUT_WS } from "./input-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";
const navigation = { pathname: "/ws/cockpit", searchParams: new URLSearchParams(`input=${INPUT_ID}`) };
vi.mock("../../navigation", () => ({ useNavigation: () => navigation }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { editCockpitInput: vi.fn(), archiveCockpitInput: vi.fn() } }));
beforeEach(() => { vi.clearAllMocks(); useCockpitInputDraftStore.getState().clearDraft(); });
function show(child: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}>{child}</I18nProvider></QueryClientProvider>);
  return { ...view, client };
}
describe("input material maintenance", () => {
  it("retains the user's name and description after an unconfirmed edit response", async () => {
    vi.mocked(api.editCockpitInput).mockResolvedValue(null);
    const done = vi.fn(); const view = show(<CockpitInputMetadataEditor wsId={INPUT_WS} accountId={INPUT_MEMBER} input={inputHeader()} onDone={done} onRefresh={vi.fn()} />);
    try {
      fireEvent.change(screen.getByRole("textbox", { name: enCockpit.input_materials.name }), { target: { value: "Board preparation" } });
      fireEvent.change(screen.getByRole("textbox", { name: enCockpit.input_materials.description_optional }), { target: { value: "Original discussion notes" } });
      fireEvent.click(screen.getByRole("button", { name: enCockpit.input_materials.save_metadata }));
      await screen.findByText(enCockpit.task_flow.unconfirmed);
      expect(done).not.toHaveBeenCalled();
      expect(useCockpitInputDraftStore.getState().draft.forms[cockpitInputDraftKey(INPUT_WS, INPUT_MEMBER, "input-metadata", INPUT_ID)]).toMatchObject({ title: "Board preparation", description: "Original discussion notes", observedRevision: 1 });
      expect(api.editCockpitInput).toHaveBeenCalledExactlyOnceWith(INPUT_WS, INPUT_ID, { expectedRevision: 1, title: "Board preparation", description: "Original discussion notes" });
    } finally { view.unmount(); view.client.clear(); }
  });
  it("waits for a confirmed archive response and keeps the fixed version identity", async () => {
    let finish!: (value: CockpitInputHeader) => void;
    vi.mocked(api.archiveCockpitInput).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const fixed = inputVersion(); const original = inputHeader({ currentVersion: fixed, versionTotal: 1 }); const done = vi.fn();
    const view = show(<CockpitInputArchiveForm wsId={INPUT_WS} input={original} archived observedRevision={1} onDone={done} onRefresh={vi.fn()} />);
    try {
      expect(screen.getByText(enCockpit.input_materials.archive_hint)).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: enCockpit.input_materials.archive }));
      await waitFor(() => expect(api.archiveCockpitInput).toHaveBeenCalledOnce()); expect(done).not.toHaveBeenCalled();
      finish({ ...original, revision: 2, archivedAt: INPUT_TIME, canArchive: false, canUnarchive: true });
      await waitFor(() => expect(done).toHaveBeenCalledOnce());
      expect(api.archiveCockpitInput).toHaveBeenCalledExactlyOnceWith(INPUT_WS, INPUT_ID, { expectedRevision: 1, archived: true });
      expect(original.currentVersion?.id).toBe(fixed.id);
    } finally { view.unmount(); view.client.clear(); }
  });
});
