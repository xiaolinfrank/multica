import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@multica/core/api";
import { I18nProvider } from "@multica/core/i18n/react";
import { cockpitKeys, useCockpitActionCommandStore, useCockpitActionFormDraftStore, useCockpitTaskViewStore } from "@multica/core/cockpit";
import type { CockpitMeetingAction, CockpitMeetingWorkflow } from "@multica/core/types";
import { CockpitMeetingActions } from "./cockpit-meeting-actions";
import { NavigationProvider } from "../../navigation";
import { compactTask, meetingAction, choiceIssue } from "./action-test-fixtures";
import { versionFixture, workflowFixture, workflowSummary, WORKFLOW_MEETING_ID } from "./workflow-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";
import enIssues from "../../locales/en/issues.json";

vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: {
  getCockpitMinutesVersion: vi.fn(), listCockpitMeetingActions: vi.fn(), getCockpitMeetingAction: vi.fn(), resolveCockpitMeetingAction: vi.fn(), updateCockpitMeetingAction: vi.fn(), createCockpitMeetingAction: vi.fn(),
  searchIssues: vi.fn(), getIssue: vi.fn(), getCockpitPrimaryNode: vi.fn(), listIssueStatuses: vi.fn(), searchCockpitAssignees: vi.fn(),
} }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ cockpit: () => "/ws/cockpit", issueDetail: (id: string) => `/ws/issues/${id}` }) }));
vi.mock("./cockpit-assignee-picker", () => ({ CockpitAssigneePicker: () => <button type="button">Assignee picker</button> }));
const nodePicker = vi.hoisted(() => ({ options: [{ node_id: "node-1", code: "01.01.01", label: "01.01.01 Large L3", project_id: "project-1", module_id: "module-1" }], isPending: false, isFetching: false, isError: false, refetch: vi.fn() }));
vi.mock("./cockpit-node-issue-picker", () => {
  const option = { node_id: "node-1", code: "01.01.01", label: "01.01.01 Large L3", project_id: "project-1", module_id: "module-1" };
  return { useCockpitSelectedNodeIssueOption: (nodeId: string) => ({ ...nodePicker, option: nodePicker.options.find((entry) => entry.node_id === nodeId) ?? null }), CockpitNodeIssuePicker: ({ onUpdate }: { onUpdate: (value: typeof option) => void }) =>
    <button type="button" aria-label="Primary work item" onClick={() => onUpdate(option)}>01.01.01 Large L3</button> };
});

let actions: CockpitMeetingAction[];
let workflow: CockpitMeetingWorkflow;
let currentPath: string;
let navigateInTest: (path: string) => void;
function TestNavigation({ children }: { children: React.ReactNode }) {
  const [path, setPath] = useState(currentPath);
  const location = new URL(path, "https://multica.test");
  const move = (next: string) => { currentPath = next; setPath(next); };
  navigateInTest = move;
  return <NavigationProvider value={{ pathname: location.pathname, searchParams: location.searchParams, hash: location.hash,
    push: move, replace: move, back: vi.fn(), getShareableUrl: (href) => href }}>{children}</NavigationProvider>;
}
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return { ...render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, issues: enIssues } }}>
    <TestNavigation><CockpitMeetingActions wsId="ws-1" workflow={workflowSummary(workflow)} userId="reviewer-1" /></TestNavigation>
  </I18nProvider></QueryClientProvider>), client };
}
beforeEach(() => {
  vi.clearAllMocks(); useCockpitActionCommandStore.getState().clearDraft(); useCockpitActionFormDraftStore.getState().clearDraft(); useCockpitTaskViewStore.getState().reset();
  currentPath = "/ws/cockpit";
  nodePicker.options = [{ node_id: "node-1", code: "01.01.01", label: "01.01.01 Large L3", project_id: "project-1", module_id: "module-1" }];
  nodePicker.isPending = false; nodePicker.isFetching = false; nodePicker.isError = false;
  actions = [meetingAction()];
  const published = versionFixture({ decision: "approved", published_at: "2026-10-10T10:00:00Z" });
  workflow = workflowFixture({ current_version_id: published.id, published_version_id: published.id, versions: [published] });
  vi.mocked(api.getCockpitMinutesVersion).mockImplementation(async (_ws, _meeting, id) => {
    const version = workflow.versions.find((entry) => entry.id === id);
    return version ? { workspace_id: "ws-1", meeting_id: workflow.meeting_id, workflow_revision: workflow.revision, version, can_review: false, can_publish: false, can_export_nas: false } : null;
  });
  vi.mocked(api.searchCockpitAssignees).mockImplementation(async (_ws, query) => ({ workspace_id: "ws-1", q: query?.q ?? "", kind: query?.kind ?? "all", selected_type: query?.selected_type ?? null, selected_id: query?.selected_id ?? null,
    items: [{ id: query?.selected_id ?? "reviewer-1", type: query?.selected_type ?? "member", title: "Minutes Writer", email: "", avatar_url: "", status: "active", runtime_bound: null, can_assign: true, reason: "" }], total: 1, next_cursor: null }));
  vi.mocked(api.listIssueStatuses).mockResolvedValue({ statuses: [], categories: [], total: 0 });
  vi.mocked(api.listCockpitMeetingActions).mockImplementation(async (_meetingId, query) => ({ meeting_id: WORKFLOW_MEETING_ID,
    items: query?.q === "needle" ? [meetingAction({ id: "action-51", title: "Needle outside page" })]
      : query?.cursor === "next-actions" ? [meetingAction({ id: "action-26", title: "Next page action" })] : actions,
    total: actions.length === 25 ? 55 : actions.length, filtered_total: query?.q === "needle" ? 1 : actions.length === 25 ? 55 : actions.length,
    next_cursor: !query?.q && !query?.cursor && actions.length === 25 ? "next-actions" : null, can_add: true }));
  vi.mocked(api.getCockpitMeetingAction).mockImplementation(async (_meetingId, actionId) => actions.find((action) => action.id === actionId) ?? null);
  vi.mocked(api.searchIssues).mockResolvedValue({ issues: [choiceIssue(26)] });
  vi.mocked(api.getIssue).mockResolvedValue(choiceIssue(26));
  vi.mocked(api.getCockpitPrimaryNode).mockResolvedValue({ issue_id: "issue-26", node_id: null, revision: 0, project_id: "project-1", module_id: "module-1", node_code: "", node_name: "" });
  vi.mocked(api.resolveCockpitMeetingAction).mockImplementation(async (target, body) => {
    const result = meetingAction({ ...actions.find((action) => action.id === target.id), revision: body.expected_revision + 1,
      status: body.outcome === "dismiss" ? "dismissed" : "accepted", resolution: body.outcome, decision_key: body.decision_key, node_id: body.node_id ?? null,
      issue: body.outcome === "dismiss" ? null : compactTask(body.outcome === "reuse" ? 26 : 101, body.outcome === "reuse" ? { status: "todo", due_date: "2026-11-01" } : {}),
      reason: body.reason ?? "", resolved_by: "reviewer-1", resolved_at: "2026-10-10T11:00:00Z", can_edit: false, can_resolve: false });
    actions = actions.map((action) => action.id === result.id ? result : action);
    return result;
  });
});

async function openAction() {
  fireEvent.click(await screen.findByRole("link", { name: /(?:Create issue for action:|Review action) Verify interface/ }));
  const dialog = await screen.findByRole("dialog", { name: "Confirm action" });
  await within(dialog).findByText("Verify interface");
  await waitFor(() => expect(api.getCockpitMinutesVersion).toHaveBeenCalled());
  return dialog;
}

describe("meeting action decisions", () => {
  it("does not let a late confirmation of action A close or replace the currently selected action B", async () => {
    actions = [meetingAction(), meetingAction({ id: "action-2", title: "Second action" })];
    const resolveAction = vi.mocked(api.resolveCockpitMeetingAction).getMockImplementation()!;
    let finish!: () => void;
    vi.mocked(api.resolveCockpitMeetingAction).mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return resolveAction(...args);
    });
    setup();
    let dialog = await openAction();
    fireEvent.click(within(dialog).getByRole("button", { name: "Primary work item" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm action" }));
    await waitFor(() => expect(api.resolveCockpitMeetingAction).toHaveBeenCalledOnce());
    const nextPath = `/ws/cockpit?meeting=${WORKFLOW_MEETING_ID}&action=action-2&meeting_view=workflow&filter=kept`;
    await act(async () => { navigateInTest(nextPath); });
    dialog = await screen.findByRole("dialog", { name: "Confirm action" });
    await within(dialog).findByText("Second action");
    await act(async () => { finish(); });
    await waitFor(() => expect(actions[0]?.status).toBe("accepted"));
    expect(currentPath).toBe(nextPath);
    expect(within(dialog).getByText("Second action")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("replaces a closed action deep link and shares the next selection without reopening the previous action on reload", async () => {
    currentPath = `/ws/cockpit?meeting=${WORKFLOW_MEETING_ID}&action=action-1&meeting_view=workflow&filter=kept#context`;
    actions = [meetingAction(), meetingAction({ id: "action-2", title: "Second action" })];
    const first = setup();
    let dialog = await screen.findByRole("dialog", { name: "Confirm action" });
    await within(dialog).findByText("Verify interface");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(new URL(currentPath, "https://multica.test").searchParams.get("action")).toBeNull();
    const secondLink = screen.getByRole("link", { name: "Create issue for action: Second action" });
    const shared = new URL(secondLink.getAttribute("href")!, "https://multica.test");
    expect(shared.searchParams.get("meeting")).toBe(WORKFLOW_MEETING_ID);
    expect(shared.searchParams.get("action")).toBe("action-2");
    expect(shared.searchParams.get("meeting_view")).toBe("workflow");
    expect(shared.searchParams.get("filter")).toBe("kept");
    expect(shared.hash).toBe("#context");
    fireEvent.click(secondLink);
    dialog = await screen.findByRole("dialog", { name: "Confirm action" });
    await within(dialog).findByText("Second action");
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit suggestion" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Action title" }), { target: { value: "Second action draft" } });
    first.unmount();
    const reloaded = setup();
    dialog = await screen.findByRole("dialog", { name: "Confirm action" });
    expect(await within(dialog).findByRole("textbox", { name: "Action title" })).toHaveValue("Second action draft");
    expect(new URL(currentPath, "https://multica.test").searchParams.get("action")).toBe("action-2");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    reloaded.unmount(); setup();
    await screen.findByRole("link", { name: "Create issue for action: Second action" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(new URL(currentPath, "https://multica.test").searchParams.get("meeting_view")).toBe("workflow");
    expect(new URL(currentPath, "https://multica.test").searchParams.get("filter")).toBe("kept");
    expect(api.resolveCockpitMeetingAction).not.toHaveBeenCalled();
  });

  it("offers the execution plan when the selected L3 is unavailable without inferring a global empty inventory", async () => {
    nodePicker.options = [];
    currentPath = "/ws/cockpit?project=project-1&module=module-1";
    setup();
    const dialog = await openAction();
    expect(dialog).not.toHaveTextContent("No eligible L3 work item is available");
    expect(within(dialog).getByRole("link", { name: "Open execution plan (new tab)" })).toHaveAttribute("href", "/ws/cockpit?tab=plan&plan_view=gantt&project=project-1&module=module-1");
    expect(within(dialog).getByRole("link", { name: "Open execution plan (new tab)" })).toHaveAttribute("target", "_blank");
    expect(within(dialog).getByRole("button", { name: "Confirm action" })).toBeDisabled();
    expect(api.resolveCockpitMeetingAction).not.toHaveBeenCalled();
  });

  it("treats failed node loading as recoverable loading failure, not as an empty execution plan", async () => {
    nodePicker.options = []; nodePicker.isError = true;
    setup();
    const dialog = await openAction();
    expect(dialog).not.toHaveTextContent("No eligible L3 work item is available");
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    expect(nodePicker.refetch).toHaveBeenCalledOnce();
    expect(within(dialog).getByRole("button", { name: "Confirm action" })).toBeDisabled();
  });

  it("preserves a reuse draft across closing and remounting and rechecks the chosen issue's current ownership", async () => {
    const first = setup();
    const user = userEvent.setup();
    let dialog = await openAction();
    await user.click(within(dialog).getByRole("combobox", { name: "Action outcome" }));
    await user.click(await screen.findByRole("option", { name: "Reuse issue" }));
    await user.click(within(dialog).getByRole("button", { name: "Primary work item" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Search existing issues" }), { target: { value: "Candidate" } });
    await user.click(await within(dialog).findByRole("button", { name: "PMO-26 Candidate 26" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Confirm action" })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    first.unmount();
    vi.mocked(api.getCockpitPrimaryNode).mockResolvedValue({ issue_id: "issue-26", node_id: "original-node", revision: 2,
      project_id: "project-1", module_id: "module-1", node_code: "01.02.01", node_name: "Original work item" });
    setup();
    dialog = await openAction();
    await within(dialog).findByText("Selected issue: PMO-26 Candidate 26");
    await waitFor(() => expect(dialog).toHaveTextContent(enCockpit.meeting_actions.reuse_conflict));
    expect(within(dialog).getByRole("link", { name: "Configure selected work item (new tab)" })).toHaveAttribute("href", "/ws/cockpit?node=node-1&node_view=details");
    expect(within(dialog).getByRole("link", { name: "View selected issue and materials (new tab)" })).toHaveAttribute("href", "/ws/issues/PMO-26");
    expect(within(dialog).getByRole("link", { name: "View existing primary work item (new tab)" })).toHaveAttribute("href", "/ws/cockpit?node=original-node&node_view=details");
    expect(within(dialog).getByRole("button", { name: "Confirm action" })).toBeDisabled();
    expect(api.resolveCockpitMeetingAction).not.toHaveBeenCalled();
    expect(useCockpitActionCommandStore.getState().draft.commands).toEqual({});
  });

  it("restores edited text but requires an explicit discard when the action changed while closed", async () => {
    const first = setup();
    let dialog = await openAction();
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit suggestion" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Action title" }), { target: { value: "Keep my unsaved title" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    first.unmount();
    actions = [meetingAction({ revision: 2, title: "Other person's latest title" })];
    setup();
    fireEvent.click(await screen.findByRole("link", { name: "Create issue for action: Other person's latest title" }));
    dialog = await screen.findByRole("dialog", { name: "Confirm action" });
    expect(await within(dialog).findByRole("textbox", { name: "Action title" })).toHaveValue("Keep my unsaved title");
    expect(within(dialog).getByRole("button", { name: "Save suggestion" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard draft and review latest suggestion" }));
    expect(await within(dialog).findByText("Other person's latest title")).toBeVisible();
    expect(api.updateCockpitMeetingAction).not.toHaveBeenCalled();
  });

  it("keeps an unsubmitted suggestion after closing without silently changing its fixed source", async () => {
    const first = setup();
    await waitFor(() => expect(screen.getByRole("button", { name: "Add action suggestion" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Add action suggestion" }));
    let dialog = await screen.findByRole("dialog", { name: "Add action suggestion" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Action title" }), { target: { value: "Unsubmitted proposal" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    first.unmount();
    const latest = versionFixture({ id: "version-2", version_number: 2, decision: "approved", published_at: "2026-10-11T10:00:00Z" });
    workflow = { ...workflow, current_version_id: latest.id, published_version_id: latest.id, versions: [...workflow.versions, latest] };
    setup();
    await waitFor(() => expect(screen.getByRole("button", { name: "Add action suggestion" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Add action suggestion" }));
    dialog = await screen.findByRole("dialog", { name: "Add action suggestion" });
    expect(within(dialog).getByRole("textbox", { name: "Action title" })).toHaveValue("Unsubmitted proposal");
    expect(within(dialog).getByRole("button", { name: "Save suggestion" })).toBeDisabled();
    await within(dialog).findByText("Minutes v1");
    fireEvent.click(within(dialog).getByRole("button", { name: "Use current published minutes" }));
    await within(dialog).findByText("Minutes v2");
    expect(within(dialog).getByRole("textbox", { name: "Action title" })).toHaveValue("Unsubmitted proposal");
    expect(api.createCockpitMeetingAction).not.toHaveBeenCalled();
  });

  it("blocks a new action issue when its selected executor can no longer be assigned", async () => {
    vi.mocked(api.searchCockpitAssignees).mockResolvedValue({ workspace_id: "ws-1", q: "", kind: "all", selected_type: "member", selected_id: "reviewer-1", items: [], total: 0, next_cursor: null });
    setup();
    const dialog = await openAction();
    fireEvent.click(within(dialog).getByRole("button", { name: "Primary work item" }));
    await waitFor(() => expect(api.searchCockpitAssignees).toHaveBeenCalled());
    expect(within(dialog).getByRole("button", { name: "Confirm action" })).toBeDisabled();
    expect(api.resolveCockpitMeetingAction).not.toHaveBeenCalled();
  });

  it("keeps an unknown future action state read-only even if the server grants editing and resolution capabilities", async () => {
    actions = [meetingAction({ status: "future-review-phase", can_edit: true, can_resolve: true })];
    setup();
    const dialog = await openAction();
    expect(within(dialog).queryByRole("button", { name: "Edit suggestion" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Confirm action" })).toBeNull();
    expect(api.updateCockpitMeetingAction).not.toHaveBeenCalled();
    expect(api.resolveCockpitMeetingAction).not.toHaveBeenCalled();
  });
  it("stops an open edit when the source is superseded without an action revision change", async () => {
    const { client } = setup();
    const dialog = await openAction();
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit suggestion" }));
    expect(within(dialog).getByRole("button", { name: "Save suggestion" })).toBeEnabled();
    await act(async () => { client.setQueryData(cockpitKeys.meetingAction("ws-1", WORKFLOW_MEETING_ID, "action-1"), meetingAction({ can_edit: false, source_superseded: true })); });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Save suggestion" })).toBeDisabled());
    expect(dialog).toHaveTextContent("A newer official version exists");
    expect(api.updateCockpitMeetingAction).not.toHaveBeenCalled();
  });
  it("pages and searches actions on the server without loading every action detail", async () => {
    actions = Array.from({ length: 25 }, (_, index) => meetingAction({ id: `action-${index + 1}`, title: `Action ${index + 1}` }));
    setup();
    await screen.findByText("Action 1");
    expect(api.getCockpitMeetingAction).not.toHaveBeenCalled();
    expect(vi.mocked(api.listCockpitMeetingActions).mock.lastCall?.[1]).toMatchObject({ page_size: 25, cursor: undefined });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("Next page action");
    expect(vi.mocked(api.listCockpitMeetingActions).mock.lastCall?.[1]?.cursor).toBe("next-actions");
    fireEvent.change(screen.getByRole("textbox", { name: "Search meeting actions" }), { target: { value: "needle" } });
    await screen.findByText("Needle outside page");
    expect(vi.mocked(api.listCockpitMeetingActions).mock.lastCall?.[1]).toMatchObject({ q: "needle", cursor: undefined });
  });

  it("shows fixed provenance before creating one backlog issue, retaining the exact key across an uncertain retry", async () => {
    vi.mocked(api.resolveCockpitMeetingAction).mockRejectedValueOnce(new Error("Connection lost"));
    setup();
    const dialog = await openAction();
    expect(dialog).toHaveTextContent("Minutes v1");
    expect(dialog).toHaveTextContent("Fixed minutes text");
    fireEvent.click(within(dialog).getByRole("button", { name: "Primary work item" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm action" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Connection lost");
    expect(within(dialog).getByRole("combobox", { name: "Action outcome" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry action confirmation" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Confirm action" })).toBeNull());
    const calls = vi.mocked(api.resolveCockpitMeetingAction).mock.calls;
    expect(calls[1]?.[1]).toEqual(calls[0]?.[1]);
    expect(calls[0]?.[1]).toMatchObject({ outcome: "create", node_id: "node-1", assignee_type: "member", assignee_id: "reviewer-1" });
    expect(actions[0]?.issue?.status).toBe("backlog");
    expect(useCockpitActionCommandStore.getState().draft.commands).toEqual({});
  });

  it("reuses an eligible issue without sending replacement execution fields", async () => {
    setup();
    const user = userEvent.setup();
    const dialog = await openAction();
    await user.click(within(dialog).getByRole("combobox", { name: "Action outcome" }));
    await user.click(await screen.findByRole("option", { name: "Reuse issue" }));
    await user.click(within(dialog).getByRole("button", { name: "Primary work item" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Search existing issues" }), { target: { value: "Candidate" } });
    await user.click(await within(dialog).findByRole("button", { name: "PMO-26 Candidate 26" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Confirm action" })).toBeEnabled());
    await user.click(within(dialog).getByRole("button", { name: "Confirm action" }));
    await waitFor(() => expect(api.resolveCockpitMeetingAction).toHaveBeenCalled());
    expect(vi.mocked(api.resolveCockpitMeetingAction).mock.lastCall?.[1]).toEqual({ expected_revision: 1, decision_key: expect.any(String), outcome: "reuse", node_id: "node-1", issue_id: "issue-26" });
    expect(actions[0]?.issue).toMatchObject({ status: "todo", due_date: "2026-11-01" });
  });

  it("requires a reason to dismiss a superseded suggestion and sends no issue creation fields", async () => {
    actions = [meetingAction({ source_superseded: true })];
    setup();
    const dialog = await openAction();
    expect(dialog).toHaveTextContent("A newer official version exists");
    expect(within(dialog).getByRole("button", { name: "Confirm action" })).toBeDisabled();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Reason" }), { target: { value: " Superseded by the new plan " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm action" }));
    await waitFor(() => expect(api.resolveCockpitMeetingAction).toHaveBeenCalled());
    expect(vi.mocked(api.resolveCockpitMeetingAction).mock.lastCall?.[1]).toEqual({ expected_revision: 1, decision_key: expect.any(String), outcome: "dismiss", reason: "Superseded by the new plan" });
    expect(actions[0]?.issue).toBeNull();
  });
});
