import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import { cockpitInputDraftKey, useCockpitInputDraftStore } from "@multica/core/cockpit";
import type { CockpitInputIssueSummary, CockpitInputManifestHeader, CockpitInputManifestItem, CockpitInputManifestVersionMetadata } from "@multica/core/types/cockpit-input";
import { CockpitIssueInputManifestPanel } from "./cockpit-issue-input-manifest";
import { inputHeader, inputVersion, INPUT_ID, INPUT_MEMBER, INPUT_TIME, INPUT_WS } from "./input-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";

const issueId = "b2000000-0000-4000-8000-000000000001";
const manifestId = "b2000000-0000-4000-8000-000000000002";
const navigation = { pathname: `/ws/issues/${issueId}`, searchParams: new URLSearchParams() };
vi.mock("../../navigation", () => ({ useNavigation: () => navigation, AppLink: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a> }));
vi.mock("./cockpit-input-run-launch", () => ({ CockpitInputRunLaunch: () => null }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ cockpit: () => "/ws/cockpit", issueDetail: (id: string) => `/ws/issues/${id}` }) }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: {
  getCockpitInputs: vi.fn(), getCockpitIssueInputManifest: vi.fn(), getCockpitInputManifestItems: vi.fn(), getCockpitInputVersionBatch: vi.fn(), saveCockpitIssueInputManifest: vi.fn(),
} }));
const issue: CockpitInputIssueSummary = { id: issueId, identifier: "PMO-1", title: "Prepare decision", status: "todo", statusCategory: "unstarted", priority: "medium", assigneeType: null, assigneeId: null, assigneeName: "", dueDate: null, projectId: null, moduleId: null, primaryNodeId: null, primaryNodeCode: "", primaryNodeName: "", primaryRevision: 0, creationKey: null };
const meta: CockpitInputManifestVersionMetadata = { workspaceId: INPUT_WS, issueId, id: manifestId, versionNumber: 1, commandKey: manifestId, manifestHash: "a".repeat(64), itemTotal: 127, requiredTotal: 127, createdBy: INPUT_MEMBER, createdByName: "Owner", createdAt: INPUT_TIME, hasNote: false };
const items: CockpitInputManifestItem[] = Array.from({ length: 127 }, (_, index) => ({ position: index, inputId: INPUT_ID, inputTitle: `Material ${index + 1}`,
  inputVersionId: `b3000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, inputVersionNumber: index + 1, payloadKind: "file", filename: `file-${index + 1}.txt`, contentType: "text/plain", sizeBytes: 6,
  contentHash: "a".repeat(64), purpose: `Purpose ${index + 1}`, required: true, availability: "available", unavailableReason: "" }));
let header: CockpitInputManifestHeader;
beforeEach(() => {
  vi.clearAllMocks(); useCockpitInputDraftStore.getState().clearDraft();
  header = { workspaceId: INPUT_WS, issue, revision: 1, currentVersion: meta, counts: { total: 127, required: 127, availableRequired: 127, unknownRequired: 0, unavailableRequired: 0 }, canEdit: true, blockedReasons: [] };
  vi.mocked(api.getCockpitInputs).mockResolvedValue({ workspaceId: INPUT_WS, scope: { ids: [INPUT_ID], projectId: null, meetingId: null, agendaId: null, originIssueId: null, q: "", archive: "all", sourceKind: "" }, pageSize: 100, items: [inputHeader()], total: 1, nextCursor: null, canCreate: true });
  vi.mocked(api.getCockpitIssueInputManifest).mockImplementation(async () => header);
  vi.mocked(api.getCockpitInputManifestItems).mockImplementation(async (_ws, _issue, id, query) => {
    const offset = Number(query?.cursor || "0"); const size = query?.pageSize || 25;
    return { workspaceId: INPUT_WS, issueId, manifestVersionId: id, manifestHash: meta.manifestHash, pageSize: size, items: items.slice(offset, offset + size), total: items.length, nextCursor: offset + size < items.length ? String(offset + size) : null };
  });
  vi.mocked(api.getCockpitInputVersionBatch).mockImplementation(async (_ws, ids) => ({ workspaceId: INPUT_WS, requestedIds: ids,
    items: ids.map((id) => { const item = items.find((entry) => entry.inputVersionId === id)!; return inputVersion({ id, filename: item.filename, versionNumber: item.inputVersionNumber }); }), unavailableIds: [] }));
  vi.mocked(api.saveCockpitIssueInputManifest).mockImplementation(async (_ws, _issue, body) => ({ workspaceId: INPUT_WS, commandKey: body.commandKey, action: "input_manifest_save", replayed: false, current: null,
    receipt: { ...body, issueId, manifestVersionId: "b2000000-0000-4000-8000-000000000003", versionNumber: 2, revision: body.expectedRevision + 1, requestHash: "b".repeat(64), manifestHash: "c".repeat(64), createdBy: INPUT_MEMBER, createdAt: INPUT_TIME } }));
});
function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitIssueInputManifestPanel wsId={INPUT_WS} accountId={INPUT_MEMBER} issueId={issueId} /></I18nProvider></QueryClientProvider>);
  return { ...view, client };
}
describe("Issue fixed input manifest editing", () => {
  it("edits all 127 selections while rendering 25 rows and saves the full ordered list even when current projection is unavailable", async () => {
    const view = show();
    try {
      const edit = await screen.findByRole("button", { name: enCockpit.input_materials.manifest_edit }); await waitFor(() => expect(edit).toBeEnabled()); fireEvent.click(edit);
      const dialog = await screen.findByRole("dialog"); const save = await within(dialog).findByRole("button", { name: enCockpit.input_materials.manifest_save }); await waitFor(() => expect(save).toBeEnabled());
      expect(within(dialog).getAllByRole("checkbox")).toHaveLength(25);
      fireEvent.click(within(dialog).getAllByRole("checkbox")[0]!);
      fireEvent.click(save);
      await waitFor(() => expect(api.saveCockpitIssueInputManifest).toHaveBeenCalledTimes(1));
      const body = vi.mocked(api.saveCockpitIssueInputManifest).mock.calls[0]![2];
      expect(body.items).toHaveLength(127); expect(body.items[0]).toEqual({ inputVersionId: items[0]!.inputVersionId, purpose: "Purpose 1", required: false });
      expect(body.items[126]).toEqual({ inputVersionId: items[126]!.inputVersionId, purpose: "Purpose 127", required: true });
      expect(api.getCockpitInputManifestItems).toHaveBeenCalledWith(INPUT_WS, issueId, manifestId, { pageSize: 100, cursor: "100" }, expect.any(AbortSignal));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(useCockpitInputDraftStore.getState().draft.forms[cockpitInputDraftKey(INPUT_WS, INPUT_MEMBER, "manifest", issueId)]).toBeUndefined();
    } finally { view.unmount(); view.client.clear(); }
  });
  it("keeps a selected version missing from the readable batch and requires explicit removal before saving", async () => {
    vi.mocked(api.getCockpitInputVersionBatch).mockImplementation(async (_ws, ids) => ({ workspaceId: INPUT_WS, requestedIds: ids, items: [], unavailableIds: ids }));
    const view = show();
    try {
      const edit = await screen.findByRole("button", { name: enCockpit.input_materials.manifest_edit }); await waitFor(() => expect(edit).toBeEnabled()); fireEvent.click(edit);
      const dialog = await screen.findByRole("dialog"); const rows = await within(dialog).findAllByRole("checkbox");
      expect(rows).toHaveLength(25); expect(within(dialog).getByRole("button", { name: enCockpit.input_materials.manifest_save })).toBeDisabled();
      expect(api.saveCockpitIssueInputManifest).not.toHaveBeenCalled();
    } finally { view.unmount(); view.client.clear(); }
  });
});
