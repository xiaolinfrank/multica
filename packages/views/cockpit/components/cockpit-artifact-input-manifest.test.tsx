import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import type { CockpitInputManifestHeader, CockpitInputManifestVersionMetadata } from "@multica/core/types/cockpit-input";
import { CockpitArtifactInputManifest } from "./cockpit-artifact-input-manifest";
import { choiceIssue } from "./action-test-fixtures";
import { INPUT_ID, INPUT_MEMBER, INPUT_TIME, INPUT_VERSION, INPUT_WS } from "./input-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";
const otherIssue = "b5000000-0000-4000-8000-000000000001";
const otherVersion = "b5000000-0000-4000-8000-000000000002";
vi.mock("../../navigation", () => ({ AppLink: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a> }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ issueDetail: (id: string) => `/ws/issues/${id}` }) }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { getCockpitIssueInputManifest: vi.fn(), getCockpitInputManifestVersions: vi.fn(), getCockpitInputManifestVersion: vi.fn(), searchIssues: vi.fn() } }));
function metadata(issueId: string): CockpitInputManifestVersionMetadata {
  return { workspaceId: INPUT_WS, issueId, id: issueId === otherIssue ? otherVersion : INPUT_VERSION, versionNumber: issueId === otherIssue ? 2 : 1, commandKey: INPUT_VERSION, manifestHash: "a".repeat(64), itemTotal: 4, requiredTotal: 3, createdBy: INPUT_MEMBER, createdByName: "Owner", createdAt: INPUT_TIME, hasNote: false };
}
function header(issueId: string): CockpitInputManifestHeader {
  return { workspaceId: INPUT_WS, issue: { id: issueId, identifier: "PMO-2", title: issueId === otherIssue ? "Source discussion" : "Production issue", status: "todo", statusCategory: "unstarted", priority: "medium", assigneeType: null, assigneeId: null, assigneeName: "", dueDate: null, projectId: null, moduleId: null, primaryNodeId: null, primaryNodeCode: "", primaryNodeName: "", primaryRevision: 0, creationKey: null }, revision: 1, currentVersion: metadata(issueId), counts: { total: 4, required: 3, availableRequired: 3, unknownRequired: 0, unavailableRequired: 0 }, canEdit: true, blockedReasons: [] };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getCockpitIssueInputManifest).mockImplementation(async (_ws, issueId) => header(issueId));
  vi.mocked(api.getCockpitInputManifestVersions).mockImplementation(async (_ws, issueId) => ({ workspaceId: INPUT_WS, issueId, pageSize: 25, items: [metadata(issueId)], total: 1, nextCursor: null }));
  vi.mocked(api.getCockpitInputManifestVersion).mockImplementation(async (_ws, issueId) => ({ ...metadata(issueId), note: "" }));
  vi.mocked(api.searchIssues).mockResolvedValue({ issues: [{ ...choiceIssue(2), id: otherIssue, workspace_id: INPUT_WS, title: "Source discussion" }] });
});
function show(selected = false) {
  const change = vi.fn(); const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitArtifactInputManifest wsId={INPUT_WS} producerIssueId={INPUT_ID} selectedIssueId={selected ? otherIssue : ""} selectedVersionId={selected ? otherVersion : ""} onChange={change} /></I18nProvider></QueryClientProvider>);
  return { ...view, client, change };
}
describe("human artifact input provenance", () => {
  it("never infers the producer current manifest and allows an explicitly selected historical manifest from another issue", async () => {
    const view = show();
    try {
      expect(screen.getByText(enCockpit.input_materials.artifact_no_manifest)).toBeVisible(); expect(view.change).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: enCockpit.input_materials.artifact_choose_manifest }));
      await screen.findByText("PMO-2 Production issue"); expect(view.change).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: enCockpit.input_materials.choose_other_issue }));
      fireEvent.change(screen.getByRole("textbox", { name: enCockpit.task_flow.issue_search }), { target: { value: "Source" } });
      fireEvent.click(await screen.findByRole("button", { name: "PMO-2 Source discussion" }));
      await screen.findByText("PMO-2 Source discussion"); expect(view.change).not.toHaveBeenCalled();
      const choose = screen.getByRole("button", { name: enCockpit.input_materials.select_version }); await waitFor(() => expect(choose).toBeEnabled()); fireEvent.click(choose);
      expect(view.change).toHaveBeenCalledExactlyOnceWith({ inputManifestIssueId: otherIssue, inputManifestVersionId: otherVersion });
      expect(api.getCockpitInputManifestVersions).toHaveBeenCalledWith(INPUT_WS, otherIssue, { pageSize: 25, cursor: undefined }, expect.any(AbortSignal));
    } finally { view.unmount(); view.client.clear(); }
  });
  it("preserves a different Issue source when browsing is cancelled", async () => {
    const view = show(true);
    try {
      const link = await screen.findByRole("link", { name: /PMO-2 Source discussion/ });
      expect(link).toHaveAttribute("href", `/ws/issues/${otherIssue}?input_manifest=${otherVersion}`);
      fireEvent.click(screen.getByRole("button", { name: enCockpit.input_materials.artifact_choose_manifest }));
      fireEvent.click(screen.getByRole("button", { name: enCockpit.input_materials.choose_other_issue }));
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(view.change).not.toHaveBeenCalled();
      expect(screen.getByRole("link", { name: /PMO-2 Source discussion/ })).toHaveAttribute("href", `/ws/issues/${otherIssue}?input_manifest=${otherVersion}`);
    } finally { view.unmount(); view.client.clear(); }
  });
});
