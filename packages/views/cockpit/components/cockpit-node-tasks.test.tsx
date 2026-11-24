import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createPortal } from "react-dom";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@multica/core/api";
import { I18nProvider } from "@multica/core/i18n/react";
import { useCockpitActionCommandStore, useCockpitTaskViewStore } from "@multica/core/cockpit";
import { CockpitNodeTasks } from "./cockpit-node-tasks";
import { actionNode, compactPage, compactTask } from "./action-test-fixtures";
import { issueOperationPageFixture } from "../../issues/operation-basis-test-fixture";
import enCockpit from "../../locales/en/cockpit.json";
import enIssues from "../../locales/en/issues.json";

vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: {
  getCockpitNodeTasks: vi.fn(), listIssueStatuses: vi.fn(), createCockpitNodeTask: vi.fn(), getCockpitPrimaryNode: vi.fn(), setCockpitPrimaryNode: vi.fn(), searchIssues: vi.fn(),
  // The filing dialog reads these: the project and module lists for its
  // before/after line, the node detail for the work item it is leaving, the
  // issue's children, and the workflow list for the handoff check.
  listProjects: vi.fn(async () => ({ projects: [], total: 0 })),
  listModules: vi.fn(async () => ({ modules: [], total: 0 })),
  getCockpitNodeDetail: vi.fn(async () => null),
  getIssue: vi.fn(async () => null),
  listChildIssues: vi.fn(async () => ({ issues: [], total: 0 })),
  listIssueWorkflows: vi.fn(async () => ({ workflows: [], total: 0 })),
  updateIssue: vi.fn(async (id: string) => ({ id })),
  appendCockpitNodeIssue: vi.fn(async () => ({})),
  getIssueOperationBasis: vi.fn(async (_ws: string, ids: string[]) => issueOperationPageFixture("ws-1", ids)),
} }));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ cockpit: () => "/ws/cockpit", issueDetail: (id: string) => `/ws/issues/${id}` }) }));
vi.mock("../../navigation", () => ({
  AppLink: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
  useNavigation: () => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams(), push: vi.fn() }),
}));
vi.mock("../../issues/components/pickers/assignee-picker", () => ({ AssigneePicker: () => <button type="button">Assignee picker</button> }));
// The handoff dialog has its own suite; here it only has to report that the
// move asked first and to fire its confirmation.
const handoff = vi.hoisted(() => ({ confirms: 0 }));
vi.mock("../../workflows/handoff-confirm-dialog", () => ({
  // Portalled like the real dialog: while the filing dialog is open its
  // trigger's subtree is inert, and an inline mock would inherit that.
  WorkflowHandoffConfirmDialog: ({ issue, onConfirm }: { issue: unknown; onConfirm: (o: { stopPreviousRuns: boolean }) => void }) =>
    issue
      ? createPortal(
          <div role="dialog" aria-label="handoff">
            <button type="button" onClick={() => { handoff.confirms += 1; onConfirm({ stopPreviousRuns: false }); }}>
              Confirm handoff
            </button>
          </div>,
          document.body,
        )
      : null,
}));

function setup(referenceOnly = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, issues: enIssues } }}>
    <CockpitNodeTasks wsId="ws-1" node={actionNode} userId="reviewer-1" referenceOnly={referenceOnly} />
  </I18nProvider></QueryClientProvider>);
}
beforeEach(() => {
  vi.clearAllMocks(); handoff.confirms = 0; useCockpitTaskViewStore.getState().reset(); useCockpitActionCommandStore.getState().clearDraft();
  vi.mocked(api.listIssueStatuses).mockResolvedValue({ statuses: [], categories: [], total: 0 });
  vi.mocked(api.getCockpitNodeTasks).mockImplementation(async (_node, query) => {
    if (query?.status === "done") return compactPage({ items: query.category === "active" ? [] : [compactTask(120, { status: "done", status_category: "done" })], filtered_total: query.category === "active" ? 0 : 20, next_cursor: null });
    if (query?.q === "needle") return compactPage({ items: [compactTask(110, { title: "Needle outside first page" })], filtered_total: 1, next_cursor: null });
    if (query?.category === "done") return compactPage({ items: [compactTask(120, { status: "done", status_category: "done" })], filtered_total: 20, next_cursor: null });
    if (query?.cursor === "page-2") return compactPage({ items: [compactTask(26)], next_cursor: null });
    return compactPage();
  });
});

const candidate = (overrides: Record<string, unknown> = {}) => ({
  id: "issue-42",
  workspace_id: "ws-1",
  number: 42,
  identifier: "BIO-42",
  title: "Existing task",
  description: null,
  status: "todo",
  priority: "none",
  assignee_type: null,
  assignee_id: null,
  creator_type: "member",
  creator_id: "reviewer-1",
  parent_issue_id: null,
  project_id: "project-2",
  module_id: "module-2",
  work_item_id: "work-item-elsewhere",
  position: 0,
  stage: null,
  start_date: null,
  due_date: null,
  metadata: {},
  properties: {},
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  ...overrides,
});

/** Opens the filing dialog and picks the candidate the search answers with. */
async function pickCandidate(issue: Record<string, unknown>, label = "BIO-42 Existing task") {
  vi.mocked(api.searchIssues).mockResolvedValue({ issues: [issue], total: 1 } as never);
  setup();
  await screen.findByText("Work item 1");
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Add existing task" }));
  await user.type(await screen.findByRole("textbox", { name: "Search existing issues" }), "BIO-42");
  await user.click(await screen.findByRole("button", { name: label }));
  return user;
}

describe("assigning an existing task files it here", () => {
  it("writes the filing through the issue update and closes", async () => {
    const user = await pickCandidate(candidate());
    // The title, not just the entry button: they used to share a string by
    // accident, and the title is what names the dialog to a screen reader.
    expect(await screen.findByRole("dialog", { name: "Add existing task" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Change the filing" }));

    // A named work item carries its module and project, so the write names
    // the work item alone — through the issue update, not the legacy primary
    // endpoint.
    await waitFor(() => expect(api.updateIssue).toHaveBeenCalledWith("issue-42", { work_item_id: "node-1" }));
    expect(api.setCockpitPrimaryNode).not.toHaveBeenCalled();
  });

  it("says the old work item stops being linked when the task had one", async () => {
    await pickCandidate(candidate());
    expect(screen.getByText("The work item it leaves behind is no longer linked to it.")).toBeInTheDocument();
  });

  it("files a task that had no project, module or work item", async () => {
    // The old primary gate refused a task with no project or module; filing
    // it is exactly what this dialog is for.
    const user = await pickCandidate(candidate({ project_id: null, module_id: null, work_item_id: null }));
    expect(screen.getByText(/BIO-42's filing will change/)).toHaveTextContent("Not filed");
    await user.click(screen.getByRole("button", { name: "Change the filing" }));
    await waitFor(() => expect(api.updateIssue).toHaveBeenCalledWith("issue-42", { work_item_id: "node-1" }));
  });

  it("names the filing it has and the one it will have, in that order and with codes on both sides", async () => {
    vi.mocked(api.listProjects).mockResolvedValue({
      projects: [
        { id: "project-2", title: "Alpha", workspace_id: "ws-1" },
        { id: "project-1", title: "Beta", workspace_id: "ws-1" },
      ],
      total: 2,
    } as never);
    vi.mocked(api.listModules).mockResolvedValue({
      modules: [
        { id: "module-2", title: "Delivery", project_id: "project-2", workspace_id: "ws-1" },
        { id: "module-1", title: "Build", project_id: "project-1", workspace_id: "ws-1" },
      ],
      total: 2,
    } as never);
    vi.mocked(api.getCockpitNodeDetail).mockResolvedValue({ node: { id: "work-item-elsewhere", code: "01.01.01", name: "Old work item", kind: "work_item" } } as never);
    vi.mocked(api.getCockpitNodeTasks).mockResolvedValue(compactPage({
      eligibility: { eligible: true, reason: "", project_id: "project-1", module_id: "module-1" },
    }));

    await pickCandidate(candidate());

    // One sentence, so the halves cannot be read apart: from the filing it
    // has, to the one it will have — and the old work item carries its code
    // just as the new one does.
    expect(screen.getByText("BIO-42's filing will change from “Alpha / Delivery / 01.01.01 Old work item” to “Beta / Build / 01.01.01 Large L3”.")).toBeInTheDocument();
    // Nothing written before the confirmation.
    expect(api.updateIssue).not.toHaveBeenCalled();
  });

  it("does not mention the old work item when the task had none", async () => {
    // The reverse of the case above, on its own: an unfiled task leaves
    // nothing behind, so the line about the old link has nothing to say.
    await pickCandidate(candidate({ work_item_id: null }));
    expect(screen.queryByText("The work item it leaves behind is no longer linked to it.")).toBeNull();
  });

  it("does not describe the change while a sub-issue is blocked", async () => {
    vi.mocked(api.getIssue).mockResolvedValue({ ...candidate({ id: "parent-1", identifier: "BIO-1", title: "Parent task" }) } as never);
    await pickCandidate(candidate({ parent_issue_id: "parent-1" }));

    expect(await screen.findByText("A sub-issue follows its parent's filing. Move the parent instead.")).toBeInTheDocument();
    // "Will change from A to B" would contradict the refusal under it.
    expect(screen.queryByText(/filing will change from/)).toBeNull();
  });

  it("disables the confirmation when the scope change is not allowed, whatever the primary says", async () => {
    vi.mocked(api.getIssueOperationBasis).mockImplementationOnce(async (_ws: string, ids: string[]) => {
      const page = issueOperationPageFixture("ws-1", ids);
      page.items[0]!.scope = { state: "blocked", reason_codes: ["retained_artifact_scope"] };
      // Primary is allowed and must not unlock the move.
      page.items[0]!.primary = { state: "allowed", reason_codes: [] };
      return page;
    });
    await pickCandidate(candidate());

    // The reason the panel actually prints, and no "will change from A to B"
    // above a refusal that says it will not.
    expect(await screen.findByText(/^This project and module are retained as part of artifact history\./)).toBeInTheDocument();
    expect(screen.queryByText(/filing will change from/)).toBeNull();
    expect(screen.getByRole("button", { name: "Change the filing" })).toBeDisabled();
  });

  it("says how many sub-issues move with it", async () => {
    vi.mocked(api.listChildIssues).mockResolvedValue({ issues: [{ id: "c1" }, { id: "c2" }], total: 2 } as never);
    await pickCandidate(candidate());
    expect(await screen.findByText("Its 2 sub-issues and their descendants move with it.")).toBeInTheDocument();
  });

  it("confirms the handoff first when the destination project hands off", async () => {
    vi.mocked(api.listIssueWorkflows).mockResolvedValue({
      workflows: [{
        id: "wf-1",
        workspace_id: "ws-1",
        name: "Delivery",
        is_default: false,
        project_ids: ["project-1"],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        steps: [{ status_key: "todo", handler: { type: "member", id: "member-9" }, instructions: "" }],
      }],
      total: 1,
    } as never);
    // The destination project has to resolve for its workflow to be checked.
    vi.mocked(api.listProjects).mockResolvedValue({
      projects: [{ id: "project-1", title: "Beta", workspace_id: "ws-1", workflow_id: "wf-1" }],
      total: 1,
    } as never);
    vi.mocked(api.getCockpitNodeTasks).mockResolvedValue(compactPage({
      eligibility: { eligible: true, reason: "", project_id: "project-1", module_id: "module-1" },
    }));

    const user = await pickCandidate(candidate());
    // Both reads the handoff check needs settle before the click — the
    // destination project and the workflows.
    await waitFor(() => expect(api.listProjects).toHaveBeenCalled());
    await waitFor(() => expect(api.listIssueWorkflows).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "Change the filing" }));

    // The move asked first, and the write carries the workflow step.
    const confirm = await screen.findByRole("button", { name: "Confirm handoff" });
    expect(api.updateIssue).not.toHaveBeenCalled();
    await user.click(confirm);
    await waitFor(() => expect(api.updateIssue).toHaveBeenCalledWith("issue-42", expect.objectContaining({
      work_item_id: "node-1",
      enter_workflow_step: true,
    })));
    expect(handoff.confirms).toBe(1);
  });

  it("blocks a sub-issue and links its parent instead", async () => {
    vi.mocked(api.getIssue).mockResolvedValue({ ...candidate({ id: "parent-1", identifier: "BIO-1", title: "Parent task" }) } as never);
    await pickCandidate(candidate({ parent_issue_id: "parent-1" }));

    expect(await screen.findByText("A sub-issue follows its parent's filing. Move the parent instead.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open parent BIO-1" })).toHaveAttribute("href", "/ws/issues/parent-1");
    expect(screen.getByRole("button", { name: "Change the filing" })).toBeDisabled();
  });

  it("refuses when the task is already filed here", async () => {
    await pickCandidate(candidate({ work_item_id: "node-1" }));
    expect(screen.getByText("Already filed under this work item.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change the filing" })).toBeDisabled();
  });
});

describe("bounded L3 task workbench", () => {
  it("explains a missing binding and links directly to its repair without enabling issue creation", async () => {
    vi.mocked(api.getCockpitNodeTasks).mockResolvedValue(compactPage({
      eligibility: { eligible: false, reason: "module_binding_required", project_id: null, module_id: null },
    }));
    setup();
    expect(await screen.findByText("Bind a project and module on parent rows before creating or assigning issues here.")).toBeInTheDocument();
    expect(screen.queryByText("module_binding_required")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open plan details and binding" }))
      .toHaveAttribute("href", "/ws/cockpit?node=node-1&node_view=details");
    expect(screen.getByRole("button", { name: "Create issue" })).toBeDisabled();
    expect(api.createCockpitNodeTask).not.toHaveBeenCalled();
  });
  it("offers no create button in the reference-only list", async () => {
    // A related issue is attached from the issue side; this list only reads
    // and unlinks, so the create affordance is gone.
    setup(true);
    await screen.findByText("Work item 1");
    expect(screen.queryByRole("button", { name: "New issue" })).not.toBeInTheDocument();
  });
  it("clears the default open category and cursor when a specific completed status is selected", async () => {
    setup();
    const user = userEvent.setup();
    await screen.findByText("Work item 1");
    expect(screen.getByRole("button", { name: "Open (100)" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("Work item 26");
    expect(vi.mocked(api.getCockpitNodeTasks).mock.lastCall?.[1]?.cursor).toBe("page-2");
    await user.click(screen.getByRole("combobox", { name: "Issue status" }));
    await user.click(await screen.findByRole("option", { name: "Done (20)" }));
    await waitFor(() => expect(vi.mocked(api.getCockpitNodeTasks).mock.lastCall?.[1]).toMatchObject({ category: "", status: "done", cursor: undefined }));
    await screen.findByText("Work item 120");
    expect(screen.getByRole("combobox", { name: "Issue status" })).toHaveTextContent("Done");
    expect(vi.mocked(api.getCockpitNodeTasks).mock.lastCall?.[1]).toMatchObject({ category: "", status: "done", cursor: undefined });
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
  });
  it("requests only the selected L3's first 25 active rows while reporting whole-scope done/closed/unknown counts", async () => {
    setup();
    await screen.findByText("Work item 1");
    expect(api.getCockpitNodeTasks).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.getCockpitNodeTasks).mock.calls[0]?.[1]).toMatchObject({ page_size: 25, category: "active", relation: "primary" });
    expect(screen.getAllByRole("link")).toHaveLength(25);
    expect(screen.getByRole("button", { name: "All (125)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open (100)" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Completed (20)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Closed (5)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Unknown (1)" })).toBeTruthy();
    expect(screen.queryByText("Work item 26")).toBeNull();
  });

  it("uses the server cursor, retains it when returning, and resets it for server search and category changes", async () => {
    const first = setup();
    await screen.findByText("Work item 1");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("Work item 26");
    expect(vi.mocked(api.getCockpitNodeTasks).mock.lastCall?.[1]?.cursor).toBe("page-2");
    first.unmount();
    setup();
    await screen.findByText("Work item 26");
    expect(vi.mocked(api.getCockpitNodeTasks).mock.lastCall?.[1]?.cursor).toBe("page-2");
    fireEvent.change(screen.getByRole("textbox", { name: "Search issues under this work item" }), { target: { value: "needle" } });
    await screen.findByText("Needle outside first page");
    expect(vi.mocked(api.getCockpitNodeTasks).mock.lastCall?.[1]).toMatchObject({ q: "needle", cursor: undefined });
    fireEvent.change(screen.getByRole("textbox", { name: "Search issues under this work item" }), { target: { value: "" } });
    await waitFor(() => expect(vi.mocked(api.getCockpitNodeTasks).mock.lastCall?.[1]?.q).toBe(""));
    await screen.findByText("Work item 1");
    expect(vi.mocked(api.getCockpitNodeTasks).mock.lastCall?.[1]?.cursor).toBeUndefined();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Completed (20)" }));
    await screen.findByText("Work item 120");
    expect(vi.mocked(api.getCockpitNodeTasks).mock.lastCall?.[1]).toMatchObject({ category: "done", cursor: undefined });
  });

  it("shows malformed or failed reads as retryable errors instead of claiming an empty L3", async () => {
    vi.mocked(api.getCockpitNodeTasks).mockResolvedValue(null);
    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load this list");
    expect(screen.queryByText("No issues in this relationship yet.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(api.getCockpitNodeTasks).toHaveBeenCalledTimes(2));
  });
});
