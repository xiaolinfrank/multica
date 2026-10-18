import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@multica/core/api";
import { I18nProvider } from "@multica/core/i18n/react";
import { useCockpitActionCommandStore, useCockpitActionFormDraftStore } from "@multica/core/cockpit";
import type { CockpitMeetingAction, CockpitMeetingWorkflow } from "@multica/core/types";
import { CockpitMeetingActions } from "./cockpit-meeting-actions";
import { NavigationProvider } from "../../navigation";
import { compactTask, meetingAction } from "./action-test-fixtures";
import { versionFixture, workflowFixture, workflowSummary, WORKFLOW_MEETING_ID } from "./workflow-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";
import enIssues from "../../locales/en/issues.json";

vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: {
  getCockpitMinutesVersion: vi.fn(), listCockpitMeetingActions: vi.fn(), getCockpitMeetingAction: vi.fn(),
  resolveCockpitMeetingAction: vi.fn(), reviseCockpitMeetingAction: vi.fn(), createCockpitMeetingAction: vi.fn(), updateCockpitMeetingAction: vi.fn(),
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

// Locale keys for the revise flow are reported by the R2 task and applied to
// the language packs separately; resolve them here so the suite works before
// and after that landing.
function label(path: string): string {
  const resolved = path.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], enCockpit);
  return typeof resolved === "string" ? resolved : path;
}

const acceptedAction = (): CockpitMeetingAction => meetingAction({ status: "accepted", resolution: "create", revision: 2,
  decision_key: "60000000-0000-4000-8000-000000000001", node_id: "node-1", node_code: "01.01.01", node_name: "Large L3",
  issue: compactTask(1), reason: "First decision", resolved_by: "reviewer-1", resolved_at: "2026-10-10T11:00:00Z", can_edit: false, can_resolve: false });

let actions: CockpitMeetingAction[];
let workflow: CockpitMeetingWorkflow;
let currentPath: string;
function TestNavigation({ children }: { children: React.ReactNode }) {
  const [path, setPath] = useState(currentPath);
  const location = new URL(path, "https://multica.test");
  const move = (next: string) => { currentPath = next; setPath(next); };
  return <NavigationProvider value={{ pathname: location.pathname, searchParams: location.searchParams, hash: location.hash,
    push: move, replace: move, back: vi.fn(), getShareableUrl: (href) => href }}>{children}</NavigationProvider>;
}
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, issues: enIssues } }}>
    <TestNavigation><CockpitMeetingActions wsId="ws-1" workflow={workflowSummary(workflow)} userId="reviewer-1" /></TestNavigation>
  </I18nProvider></QueryClientProvider>);
}
beforeEach(() => {
  vi.clearAllMocks(); useCockpitActionCommandStore.getState().clearDraft(); useCockpitActionFormDraftStore.getState().clearDraft();
  currentPath = "/ws/cockpit";
  actions = [acceptedAction()];
  const published = versionFixture({ decision: "approved", published_at: "2026-10-10T10:00:00Z" });
  workflow = workflowFixture({ current_version_id: published.id, published_version_id: published.id, versions: [published] });
  vi.mocked(api.getCockpitMinutesVersion).mockImplementation(async (_ws, _meeting, id) => {
    const version = workflow.versions.find((entry) => entry.id === id);
    return version ? { workspace_id: "ws-1", meeting_id: workflow.meeting_id, workflow_revision: workflow.revision, version, can_review: false, can_publish: false, can_export_nas: false } : null;
  });
  vi.mocked(api.listCockpitMeetingActions).mockImplementation(async () => ({ meeting_id: WORKFLOW_MEETING_ID, items: actions, total: actions.length, filtered_total: actions.length, next_cursor: null, can_add: true }));
  vi.mocked(api.getCockpitMeetingAction).mockImplementation(async (_meetingId, actionId) => actions.find((action) => action.id === actionId) ?? null);
  vi.mocked(api.listIssueStatuses).mockResolvedValue({ statuses: [], categories: [], total: 0 });
  vi.mocked(api.searchCockpitAssignees).mockImplementation(async (_ws, query) => ({ workspace_id: "ws-1", q: query?.q ?? "", kind: query?.kind ?? "all", selected_type: query?.selected_type ?? null, selected_id: query?.selected_id ?? null,
    items: [{ id: query?.selected_id ?? "reviewer-1", type: query?.selected_type ?? "member", title: "Minutes Writer", email: "", avatar_url: "", status: "active", runtime_bound: null, can_assign: true, reason: "" }], total: 1, next_cursor: null }));
  vi.mocked(api.reviseCockpitMeetingAction).mockImplementation(async (target, body) => {
    const settled = meetingAction({ ...actions.find((action) => action.id === target.id), revision: body.expected_revision + 1,
      status: body.outcome === "dismiss" ? "dismissed" : "accepted", resolution: body.outcome, decision_key: body.decision_key,
      node_id: body.node_id ?? null, issue: body.outcome === "dismiss" ? null : compactTask(2), reason: body.reason ?? "",
      resolved_by: "reviewer-1", resolved_at: "2026-10-11T11:00:00Z", can_edit: false, can_resolve: false });
    actions = actions.map((action) => action.id === settled.id ? settled : action);
    return settled;
  });
});

async function openDecidedAction() {
  fireEvent.click(await screen.findByRole("link", { name: "Review action Verify interface" }));
  const dialog = await screen.findByRole("dialog", { name: "Confirm action" });
  await within(dialog).findByText("Verify interface");
  await waitFor(() => expect(api.getCockpitMinutesVersion).toHaveBeenCalled());
  return dialog;
}

describe("revising a written action resolution", () => {
  it("starts from the current decision and requires a reason in the dismiss direction", async () => {
    const user = userEvent.setup();
    setup();
    const dialog = await openDecidedAction();
    expect(within(dialog).getByText("First decision")).toBeVisible();
    // No decision form before the entry is used; confirming is gone.
    expect(within(dialog).queryByRole("combobox", { name: "Action outcome" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: label("meeting_actions.revise") }));
    expect(within(dialog).getByRole("combobox", { name: "Action outcome" })).toHaveTextContent("Create issue");
    expect(within(dialog).getByRole("button", { name: "Primary work item" })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("combobox", { name: "Action outcome" }));
    await user.click(await screen.findByRole("option", { name: "Do not proceed" }));
    const submit = within(dialog).getByRole("button", { name: label("meeting_actions.confirm_revise") });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByRole("textbox", { name: label("meeting_actions.revise_reason") }), { target: { value: " Tracked by the delivery stream " } });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    await waitFor(() => expect(api.reviseCockpitMeetingAction).toHaveBeenCalledOnce());
    expect(vi.mocked(api.reviseCockpitMeetingAction).mock.lastCall?.[1]).toEqual({ expected_revision: 2, decision_key: expect.any(String), outcome: "dismiss", reason: "Tracked by the delivery stream" });
    expect(api.resolveCockpitMeetingAction).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(actions[0]?.status).toBe("dismissed");
    expect(useCockpitActionCommandStore.getState().draft.commands).toEqual({});
  });

  it("keeps the exact revision command across an uncertain retry and a remount", async () => {
    vi.mocked(api.reviseCockpitMeetingAction).mockRejectedValueOnce(new Error("Connection lost"));
    const first = setup();
    let dialog = await openDecidedAction();
    fireEvent.click(within(dialog).getByRole("button", { name: label("meeting_actions.revise") }));
    const user = userEvent.setup();
    await user.click(within(dialog).getByRole("combobox", { name: "Action outcome" }));
    await user.click(await screen.findByRole("option", { name: "Do not proceed" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: label("meeting_actions.revise_reason") }), { target: { value: "Tracked by the delivery stream" } });
    const submit = within(dialog).getByRole("button", { name: label("meeting_actions.confirm_revise") });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Connection lost");
    expect(within(dialog).getByRole("button", { name: label("meeting_actions.retry_revise") })).toBeInTheDocument();
    // Closing and reopening keeps the remembered revision command and its body.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    first.unmount();
    setup();
    dialog = await openDecidedAction();
    expect(within(dialog).getByRole("textbox", { name: label("meeting_actions.revise_reason") })).toHaveValue("Tracked by the delivery stream");
    expect(within(dialog).queryByRole("button", { name: label("meeting_actions.revise") })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: label("meeting_actions.retry_revise") }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const calls = vi.mocked(api.reviseCockpitMeetingAction).mock.calls;
    expect(calls[1]?.[1]).toEqual(calls[0]?.[1]);
    expect(useCockpitActionCommandStore.getState().draft.commands).toEqual({});
  });

  it("re-creates execution from a dismissed decision and keeps the confirm channel for drafts only", async () => {
    actions = [meetingAction({ ...acceptedAction(), status: "dismissed", resolution: "dismiss", revision: 2, node_id: null, issue: null, reason: "Not needed then" })];
    setup();
    let dialog = await openDecidedAction();
    fireEvent.click(within(dialog).getByRole("button", { name: label("meeting_actions.revise") }));
    // Dismissed decisions start the revision at dismiss; move to create.
    const user = userEvent.setup();
    await user.click(within(dialog).getByRole("combobox", { name: "Action outcome" }));
    await user.click(await screen.findByRole("option", { name: "Create issue" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Primary work item" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: label("meeting_actions.revise_reason") }), { target: { value: "Scope returned to this meeting" } });
    const submit = within(dialog).getByRole("button", { name: label("meeting_actions.confirm_revise") });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    await waitFor(() => expect(api.reviseCockpitMeetingAction).toHaveBeenCalledOnce());
    expect(vi.mocked(api.reviseCockpitMeetingAction).mock.lastCall?.[1]).toMatchObject({ expected_revision: 2, outcome: "create", node_id: "node-1", reason: "Scope returned to this meeting", assignee_type: "member", assignee_id: "reviewer-1" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(actions[0]?.status).toBe("accepted");
    // A pending suggestion confirms; it has no decision to revise.
    actions = [meetingAction()];
    fireEvent.click(await screen.findByRole("link", { name: "Review action Verify interface" }));
    dialog = await screen.findByRole("dialog", { name: "Confirm action" });
    await within(dialog).findByText("Verify interface");
    expect(within(dialog).queryByRole("button", { name: label("meeting_actions.revise") })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Confirm action" })).toBeInTheDocument();
  });
});
