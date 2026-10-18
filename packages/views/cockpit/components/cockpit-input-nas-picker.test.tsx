import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api, ApiError } from "@multica/core/api";
import { cockpitInputDraftKey, cockpitInputEntriesOptions, emptyCockpitInputForm, setCockpitInputForm, useCockpitInputDraftStore } from "@multica/core/cockpit";
import { CockpitInputNASPicker } from "./cockpit-input-nas-picker";
import { INPUT_KEY, INPUT_MEMBER, INPUT_MEETING, INPUT_TIME, INPUT_WS } from "./input-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";

const ROOT = "b1000000-0000-4000-8000-000000000009";
const DIRECTORY = "project/meetings";
const key = cockpitInputDraftKey(INPUT_WS, INPUT_MEMBER, "nas", INPUT_MEETING, "");
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { getCockpitInputSpaces: vi.fn(), browseCockpitInputEntries: vi.fn() } }));
beforeEach(() => { vi.clearAllMocks(); useCockpitInputDraftStore.getState().clearDraft(); });

describe("bounded NAS selection", () => {
  it("distinguishes identical folder names on two managed roots and reads only the chosen root", async () => {
    const user = userEvent.setup();
    const otherRoot = "b1000000-0000-4000-8000-000000000019";
    vi.mocked(api.getCockpitInputSpaces).mockResolvedValue({ workspaceId: INPUT_WS, total: 2, items: [ROOT, otherRoot].map((rootId, index) => ({ rootId, rootPath: `/managed/team-${index + 1}`, inputSubpaths: ["shared"], rootConfigHash: "a".repeat(64), canBrowse: true, unavailableReason: "" })) });
    vi.mocked(api.browseCockpitInputEntries).mockResolvedValue({ workspaceId: INPUT_WS, rootId: otherRoot, relativeDirectory: "shared", q: "", rootConfigHash: "a".repeat(64), observationToken: "directory", pageSize: 25, items: [], total: 0, hasMore: false, nextCursor: null });
    setCockpitInputForm(key, emptyCockpitInputForm(INPUT_KEY));
    function Picker() { const draft = useCockpitInputDraftStore((state) => state.draft.forms[key]!); return <CockpitInputNASPicker wsId={INPUT_WS} draft={draft} onChange={(patch) => setCockpitInputForm(key, { ...draft, ...patch })} onReview={vi.fn()} />; }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><Picker /></I18nProvider></QueryClientProvider>);
    try {
      await user.click(await screen.findByRole("combobox", { name: enCockpit.input_materials.source_directory }));
      expect(screen.getByRole("option", { name: "/managed/team-1 · shared" })).toBeVisible();
      await user.click(screen.getByRole("option", { name: "/managed/team-2 · shared" }));
      await waitFor(() => expect(api.browseCockpitInputEntries).toHaveBeenCalledWith(INPUT_WS, otherRoot, { relativeDirectory: "shared", q: "", cursor: "", pageSize: 25 }, expect.any(AbortSignal)));
      expect(vi.mocked(api.browseCockpitInputEntries).mock.calls.every((call) => call[1] === otherRoot)).toBe(true);
    } finally { view.unmount(); client.clear(); }
  });

  it("keeps 27 selections across two pages and cursor recovery without adopting changed observations", async () => {
    let failCursor = false;
    let changed = false;
    const review = vi.fn();
    const files = Array.from({ length: 31 }, (_, index) => ({ name: `recording-${String(index).padStart(2, "0")}.wav`, relativePath: `${DIRECTORY}/recording-${index}.wav`, kind: "file",
      sizeBytes: 6, modifiedAt: INPUT_TIME, observationToken: `observation-${index}`, canSelect: true, canOpenDirectory: false, unavailableReason: "" }));
    vi.mocked(api.getCockpitInputSpaces).mockResolvedValue({ workspaceId: INPUT_WS, items: [{ rootId: ROOT, rootPath: "/Volumes/team", inputSubpaths: [DIRECTORY], rootConfigHash: "a".repeat(64), canBrowse: true, unavailableReason: "" }], total: 1 });
    vi.mocked(api.browseCockpitInputEntries).mockImplementation(async (_ws, _root, body) => {
      if (body.cursor && failCursor) throw new ApiError("Expired directory observation", 409, "Conflict", { code: "cursor_expired" });
      const items = body.cursor ? files.slice(25) : files.slice(0, 25).map((file, index) => changed && index === 0 ? { ...file, observationToken: "changed-observation" } : file);
      return { workspaceId: INPUT_WS, rootId: ROOT, relativeDirectory: DIRECTORY, q: "", rootConfigHash: "a".repeat(64), observationToken: "directory-observation", pageSize: 25,
        items, total: null, hasMore: !body.cursor, nextCursor: body.cursor ? null : "page-two" };
    });
    setCockpitInputForm(key, { ...emptyCockpitInputForm(INPUT_KEY), nasBrowse: { rootId: ROOT, scopePath: DIRECTORY, relativeDirectory: DIRECTORY, q: "" } });
    function Picker() {
      const draft = useCockpitInputDraftStore((state) => state.draft.forms[key]!);
      return <CockpitInputNASPicker wsId={INPUT_WS} draft={draft} onChange={(patch) => setCockpitInputForm(key, { ...draft, ...patch })} onReview={review} />;
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><Picker /></I18nProvider></QueryClientProvider>);
    try {
      await screen.findByRole("checkbox", { name: "recording-00.wav" });
      expect(screen.getAllByRole("checkbox")).toHaveLength(25);
      for (const checkbox of screen.getAllByRole("checkbox")) fireEvent.click(checkbox);
      fireEvent.click(screen.getByRole("button", { name: "Next page" }));
      await screen.findByRole("checkbox", { name: "recording-25.wav" });
      expect(screen.getAllByRole("checkbox")).toHaveLength(6);
      fireEvent.click(screen.getByRole("checkbox", { name: "recording-25.wav" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "recording-26.wav" }));
      expect(screen.getByText("Selected 27 / 50")).toBeVisible();
      const original = structuredClone(useCockpitInputDraftStore.getState().draft.forms[key]!.sourceSelections);
      failCursor = true;
      await act(async () => { await client.invalidateQueries({ queryKey: cockpitInputEntriesOptions(INPUT_WS, ROOT, { relativeDirectory: DIRECTORY, q: "", cursor: "page-two", pageSize: 25 }).queryKey }); });
      expect(await screen.findByText(enCockpit.input_materials.selection_retained)).toBeVisible();
      expect(screen.getByRole("button", { name: "Review selected items" })).toBeEnabled();
      changed = true;
      fireEvent.click(screen.getByRole("button", { name: "Read from the first page again" }));
      await screen.findByRole("checkbox", { name: "recording-00.wav" });
      await waitFor(() => expect(screen.getByText(enCockpit.input_materials.selected_source_changed)).toBeVisible());
      expect(useCockpitInputDraftStore.getState().draft.forms[key]!.sourceSelections).toEqual(original);
      fireEvent.click(screen.getByRole("button", { name: "Review selected items" }));
      expect(review).toHaveBeenCalledOnce();
      expect(vi.mocked(api.browseCockpitInputEntries).mock.calls.every((call) => call[0] === INPUT_WS && call[1] === ROOT && call[2].pageSize === 25 && call[2].relativeDirectory === DIRECTORY)).toBe(true);
    } finally { view.unmount(); client.clear(); }
  });
});
