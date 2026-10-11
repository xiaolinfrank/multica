import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import { cockpitInputRunLaunchKey, useCockpitInputRunLaunchStore } from "@multica/core/cockpit";
import type { CockpitInputManifestHeader } from "@multica/core/types/cockpit-input";
import { CockpitInputRunLaunch } from "./cockpit-input-run-launch";
import { INPUT_ID, INPUT_MEMBER, INPUT_TIME, INPUT_VERSION, INPUT_WS } from "./input-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";
import enIssues from "../../locales/en/issues.json";

const navigation = { pathname: `/ws/issues/${INPUT_ID}`, searchParams: new URLSearchParams() };
vi.mock("../../navigation", () => ({ useNavigation: () => navigation, AppLink: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a> }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ cockpit: () => "/ws/cockpit", issueDetail: (id: string) => `/ws/issues/${id}` }) }));
vi.mock("../../issues/components/issue-runs-dialog", () => ({ IssueRunsDialog: ({ onOpenChange }: { onOpenChange: (open: boolean) => void }) => <div role="dialog" aria-label="Execution history"><button onClick={() => onOpenChange(false)}>Close history</button></div> }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { rerunIssue: vi.fn(), getIssueOperationBasis: vi.fn(), getCockpitInputManifestItems: vi.fn(), listTasksByIssue: vi.fn() } }));
const header: CockpitInputManifestHeader = { workspaceId: INPUT_WS, revision: 1, canEdit: true, blockedReasons: [], counts: { total: 0, required: 0, availableRequired: 0, unknownRequired: 0, unavailableRequired: 0 },
  issue: { id: INPUT_ID, identifier: "PMO-1", title: "Prepare meeting", status: "todo", statusCategory: "unstarted", priority: "medium", assigneeType: "agent", assigneeId: INPUT_MEMBER, assigneeName: "Agent", dueDate: null, projectId: null, moduleId: null, primaryNodeId: null, primaryNodeCode: "", primaryNodeName: "", primaryRevision: 0, creationKey: null },
  currentVersion: { workspaceId: INPUT_WS, issueId: INPUT_ID, id: INPUT_VERSION, versionNumber: 1, commandKey: INPUT_VERSION, manifestHash: "a".repeat(64), itemTotal: 0, requiredTotal: 0, createdBy: INPUT_MEMBER, createdByName: "Owner", createdAt: INPUT_TIME, hasNote: false } };
beforeEach(() => {
  vi.clearAllMocks(); useCockpitInputRunLaunchStore.getState().clearDraft();
  const allowed = { state: "allowed" as const, reason_codes: [] };
  vi.mocked(api.getIssueOperationBasis).mockResolvedValue({ workspace_id: INPUT_WS, schema_version: 1, generated_at: INPUT_TIME, items: [{ issue_id: INPUT_ID, availability: "available", issue_revision: 1,
    status: { ...allowed, allowed_categories: ["unstarted", "started", "done", "closed"] }, assignee: allowed, scope: allowed, parent: allowed, primary: allowed, delete: allowed, execution: allowed, targets: [], targets_total: 0 }] });
  vi.mocked(api.getCockpitInputManifestItems).mockResolvedValue({ workspaceId: INPUT_WS, issueId: INPUT_ID, manifestVersionId: INPUT_VERSION, manifestHash: "a".repeat(64), pageSize: 25, items: [], total: 0, nextCursor: null });
  vi.mocked(api.rerunIssue).mockRejectedValue(new TypeError("Lost response"));
  vi.mocked(api.listTasksByIssue).mockResolvedValue([]);
});
function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, issues: enIssues } }}><CockpitInputRunLaunch wsId={INPUT_WS} accountId={INPUT_MEMBER} header={header} hasDraft={false} onRefresh={vi.fn()} onInspect={vi.fn()} /></I18nProvider></QueryClientProvider>);
  return { ...view, client };
}
describe("explicit new run with fixed inputs", () => {
  it("retains an unknown launch across remount and opens actual history without retrying; another run needs a distinct explicit authorization", async () => {
    const first = show();
    const start = screen.getByRole("button", { name: enCockpit.input_materials.run_with_manifest }); await waitFor(() => expect(start).toBeEnabled()); fireEvent.click(start);
    fireEvent.click(screen.getByRole("button", { name: enCockpit.input_materials.run_confirm }));
    await waitFor(() => expect(api.rerunIssue).toHaveBeenCalledExactlyOnceWith(INPUT_ID, undefined, { expectedInputManifestVersionId: INPUT_VERSION, workspaceId: INPUT_WS }));
    await screen.findByText(enCockpit.input_materials.run_result_unknown);
    const key = cockpitInputRunLaunchKey(INPUT_WS, INPUT_MEMBER, INPUT_ID);
    const original = useCockpitInputRunLaunchStore.getState().draft.intents[key]!;
    expect(original.state).toBe("unknown");
    first.unmount(); first.client.clear();
    const second = show();
    try {
      expect(screen.getByText(enCockpit.input_materials.run_result_unknown)).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: enCockpit.input_materials.run_history }));
      await screen.findByRole("dialog", { name: "Execution history" });
      expect(api.listTasksByIssue).toHaveBeenCalledWith(INPUT_ID);
      expect(api.rerunIssue).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole("button", { name: "Close history" }));
      const additional = screen.getByRole("button", { name: enCockpit.input_materials.run_authorize_another }); await waitFor(() => expect(additional).toBeEnabled()); fireEvent.click(additional);
      const confirm = screen.getByRole("button", { name: enCockpit.input_materials.run_confirm }); expect(confirm).toBeDisabled();
      fireEvent.click(screen.getByRole("checkbox", { name: enCockpit.input_materials.run_additional_ack })); fireEvent.click(confirm);
      await waitFor(() => expect(api.rerunIssue).toHaveBeenCalledTimes(2));
      expect(useCockpitInputRunLaunchStore.getState().draft.intents[key]?.attemptId).not.toBe(original.attemptId);
    } finally { second.unmount(); second.client.clear(); }
  });
});
