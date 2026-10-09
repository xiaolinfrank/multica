import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@multica/core/api";
import { I18nProvider } from "@multica/core/i18n/react";
import { cockpitKeys, useCockpitActionCommandStore, useCockpitTaskViewStore } from "@multica/core/cockpit";
import type { CockpitMeetingAction, CockpitMeetingWorkflow } from "@multica/core/types";
import { CockpitMeetingActions } from "./cockpit-meeting-actions";
import { compactTask, meetingAction, choiceIssue } from "./action-test-fixtures";
import { versionFixture, workflowFixture, WORKFLOW_MEETING_ID } from "./workflow-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";
import enIssues from "../../locales/en/issues.json";

vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: {
  listCockpitMeetingActions: vi.fn(), getCockpitMeetingAction: vi.fn(), resolveCockpitMeetingAction: vi.fn(), updateCockpitMeetingAction: vi.fn(), createCockpitMeetingAction: vi.fn(),
  searchIssues: vi.fn(), getCockpitPrimaryNode: vi.fn(), listIssueStatuses: vi.fn(),
} }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ issueDetail: (id: string) => `/ws/issues/${id}` }) }));
vi.mock("../../navigation", () => ({ useNavigation: () => ({ searchParams: new URLSearchParams() }), AppLink: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("../../issues/components/pickers/assignee-picker", () => ({ AssigneePicker: () => <button type="button">Assignee picker</button> }));
vi.mock("./cockpit-node-issue-picker", () => {
  const option = { node_id: "node-1", code: "01.01.01", label: "01.01.01 Large L3", project_id: "project-1", module_id: "module-1" };
  return { useCockpitNodeIssueOptions: () => [option], CockpitNodeIssuePicker: ({ onUpdate }: { onUpdate: (value: typeof option) => void }) =>
    <button type="button" aria-label="Primary work item" onClick={() => onUpdate(option)}>01.01.01 Large L3</button> };
});

let actions: CockpitMeetingAction[];
let workflow: CockpitMeetingWorkflow;
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return { ...render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, issues: enIssues } }}>
    <CockpitMeetingActions wsId="ws-1" workflow={workflow} userId="reviewer-1" />
  </I18nProvider></QueryClientProvider>), client };
}
beforeEach(() => {
  vi.clearAllMocks(); useCockpitActionCommandStore.getState().clearDraft(); useCockpitTaskViewStore.getState().reset();
  actions = [meetingAction()];
  const published = versionFixture({ decision: "approved", published_at: "2026-10-10T10:00:00Z" });
  workflow = workflowFixture({ current_version_id: published.id, published_version_id: published.id, versions: [published] });
  vi.mocked(api.listIssueStatuses).mockResolvedValue({ statuses: [], categories: [], total: 0 });
  vi.mocked(api.listCockpitMeetingActions).mockImplementation(async (_meetingId, query) => ({ meeting_id: WORKFLOW_MEETING_ID,
    items: query?.q === "needle" ? [meetingAction({ id: "action-51", title: "Needle outside page" })]
      : query?.cursor === "next-actions" ? [meetingAction({ id: "action-26", title: "Next page action" })] : actions,
    total: actions.length === 25 ? 55 : actions.length, filtered_total: query?.q === "needle" ? 1 : actions.length === 25 ? 55 : actions.length,
    next_cursor: !query?.q && !query?.cursor && actions.length === 25 ? "next-actions" : null, can_add: true }));
  vi.mocked(api.getCockpitMeetingAction).mockImplementation(async (_meetingId, actionId) => actions.find((action) => action.id === actionId) ?? null);
  vi.mocked(api.searchIssues).mockResolvedValue({ issues: [choiceIssue(26)] });
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
  fireEvent.click(await screen.findByRole("button", { name: "Review action Verify interface" }));
  const dialog = await screen.findByRole("dialog", { name: "Confirm action" });
  await within(dialog).findByText("Verify interface");
  return dialog;
}

describe("meeting action decisions", () => {
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
