import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api, ApiError } from "@multica/core/api";
import { cockpitScopeViewKey, prepareCockpitMeetingCreation, useCockpitMeetingCreateDraftStore } from "@multica/core/cockpit";
import enCockpit from "../../locales/en/cockpit.json";
import enCommon from "../../locales/en/common.json";
import enIssues from "../../locales/en/issues.json";
import { CockpitMeetingCreate, type CockpitMeetingCreateProps, type CockpitMeetingCreationResult } from "./cockpit-meeting-create";
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { getCockpitContext: vi.fn(), getCockpitMeetingNextCode: vi.fn(), getCockpitMeetingDestination: vi.fn(), searchCockpitScopeMembers: vi.fn(), searchCockpitAssignees: vi.fn(), listProjects: vi.fn(), listModules: vi.fn(), getCockpitPlan: vi.fn(), getCockpitNodeDetail: vi.fn(), searchCockpitScopeNodes: vi.fn() } }));
vi.mock("@multica/core/paths", () => ({ issueRouteRef: (issue: { id: string; identifier?: string | null }) => issue.identifier || issue.id,  useWorkspacePaths: () => ({ cockpit: () => "/ws/cockpit", projects: () => "/ws/projects", projectDetail: (id: string) => `/ws/projects/${id}`, settings: () => "/ws/settings" }) }));
vi.mock("../../navigation", () => ({ useNavigation: () => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams("tab=meetings") }), AppLink: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a> }));
const scope = { projectId: null, moduleId: null };
const key = cockpitScopeViewKey("ws-1", scope);
function setup(overrides: Partial<CockpitMeetingCreateProps> = {}) {
  const props: CockpitMeetingCreateProps = { open: true, wsId: "ws-1", scope, today: "2026-10-10", members: [], currentUserName: "Owner", currentUserId: "person", savedMeetingId: null, workflowCreated: false,
    defaultProjectId: "project", defaultModuleId: "module", defaultNodeId: null, defaultAssigneeType: null, defaultAssigneeId: null,
    onOpenChange: vi.fn(), onCreated: vi.fn(), onSaveDirectoryEntry: vi.fn().mockResolvedValue(true), onAutoSaveDirectory: vi.fn(), onSubmit: vi.fn().mockResolvedValue({ meetingId: "meeting-created" }), ...overrides };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, common: enCommon, issues: enIssues } }}>{children}</I18nProvider></QueryClientProvider>;
  const view = render(<CockpitMeetingCreate {...props} />, { wrapper }); return { ...view, props };
}
beforeEach(() => {
  vi.clearAllMocks(); useCockpitMeetingCreateDraftStore.getState().clearDraft();
  vi.mocked(api.getCockpitContext).mockImplementation(async (ws, input) => ({ workspace_id: ws, scope: { project_id: input.projectId, module_id: input.moduleId, project_title: "", module_title: "" }, cockpit: null, actor: { user_id: "person", role: "member", is_human: true }, has_stable_bindings: false, has_meeting_workflows: false }));
  vi.mocked(api.getCockpitMeetingDestination).mockResolvedValue({ project_id: "project", project_title: "Project", module_id: "module", module_title: "Module", node_id: "", node_code: "", node_title: "", collab_path: "/Volumes/team", base_dir: "/Volumes/team/Meetings", derived: false, base_dir_exists: true, creatable: true, error: "" });
  vi.mocked(api.getCockpitMeetingNextCode).mockImplementation(async (ws, date) => ({ workspace_id: ws, date, code: "M-0001" }));
  vi.mocked(api.searchCockpitScopeMembers).mockResolvedValue({ workspace_id: "ws-1", scope: { q: "", ids: ["person"] }, items: [{ id: "person", title: "Owner", email: "owner@example.test", avatar_url: "", role: "member" }], total: 1, filtered_total: 1, next_cursor: null });
  vi.mocked(api.searchCockpitAssignees).mockResolvedValue({ workspace_id: "ws-1", q: "", kind: "all", selected_type: "member", selected_id: "person", items: [{ id: "person", type: "member", title: "Owner", email: "owner@example.test", avatar_url: "", status: "active", runtime_bound: null, can_assign: true, reason: "" }], total: 1, next_cursor: null });
  vi.mocked(api.listProjects).mockResolvedValue({ projects: [{ id: "project", title: "Programme" }], total: 1 } as unknown as Awaited<ReturnType<typeof api.listProjects>>);
  vi.mocked(api.listModules).mockResolvedValue({ modules: [{ id: "module", project_id: "project", title: "Module" }], total: 1 } as unknown as Awaited<ReturnType<typeof api.listModules>>);
  vi.mocked(api.getCockpitPlan).mockResolvedValue({
    workspace_id: "ws-1",
    scope: { project_id: "project", module_id: "module", project_title: "Programme", module_title: "Module" },
    cockpit: { id: "cp", workspace_id: "ws-1", goal_date: null, plan_reconciled_at: "2026-11-20T00:00:00Z" },
    actor: { user_id: "person", role: "member", is_human: true },
    has_meeting_workflows: false, has_stable_bindings: false, complete: true,
    nodes: [
      { id: "row-module", code: "01.02", name: "Module", kind: "module", parent_id: "row-project", position: 0, project_id: "project", module_id: "module" },
      { id: "node-work", code: "01.02.01", name: "Draft", kind: "work_item", parent_id: "row-module", position: 0, project_id: "project", module_id: null },
    ],
    task_counts: [], context_node_ids: [], payments: [], milestones: [], node_index: [],
  } as unknown as Awaited<ReturnType<typeof api.getCockpitPlan>>);
  vi.mocked(api.searchCockpitScopeNodes).mockResolvedValue({ workspace_id: "ws-1", scope: { project_id: null, module_id: null, q: "", eligible: false }, items: [], total: 0, filtered_total: 0, next_cursor: null });
  vi.mocked(api.getCockpitNodeDetail).mockResolvedValue({
    workspace_id: "ws-1",
    scope: { project_id: "project", module_id: "module", project_title: "Programme", module_title: "Module" },
    cockpit: { id: "cp", workspace_id: "ws-1", goal_date: null, plan_reconciled_at: "2026-11-20T00:00:00Z" },
    actor: { user_id: "person", role: "member", is_human: true },
    has_meeting_workflows: false, has_stable_bindings: false,
    node: { id: "node-work", code: "01.02.01", name: "Draft", parent_id: "row-module", project_id: "project", module_id: null },
    ancestors: [], children_count: 0, scope_match: true, node_index: [],
    binding: { project_id: "project", module_id: "module", project_title: "Programme", module_title: "Module", source_node_id: "row-module", eligible: false, reason: "" },
    payments: { items: [], total: 0, next_cursor: null }, payment_total: 0,
    meetings: { items: [], total: 0, next_cursor: null },
  } as unknown as Awaited<ReturnType<typeof api.getCockpitNodeDetail>>);
});
describe("meeting creation command recovery", () => {
  it("reopens an uncertain command with its original key/body and retries before clearing the draft", async () => {
    const view = setup(); const user = userEvent.setup(); vi.mocked(view.props.onSubmit).mockRejectedValueOnce(new Error("response lost"));
    await user.type(screen.getByRole("textbox", { name: "Subject" }), "Quarterly decisions");
    await user.click(screen.getByRole("button", { name: "Create meeting" })); expect(await screen.findByRole("alert")).toHaveTextContent("response lost");
    const first = vi.mocked(view.props.onSubmit).mock.calls[0]!; expect(first[0].creation_key).toMatch(/^[0-9a-f-]{36}$/); expect(first[0].title).toBe("Quarterly decisions");
    expect(screen.getByRole("textbox", { name: "Subject" })).toBeDisabled();
    view.rerender(<CockpitMeetingCreate {...view.props} open={false} />); view.rerender(<CockpitMeetingCreate {...view.props} />);
    expect(await screen.findByDisplayValue("Quarterly decisions")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(view.props.onCreated).toHaveBeenCalledWith({ meetingId: "meeting-created" }));
    expect(vi.mocked(view.props.onSubmit).mock.calls[1]).toEqual(first); expect(useCockpitMeetingCreateDraftStore.getState().draft.byScope[key]).toBeUndefined();
  });
  it("settles the captured command without closing or navigating another form or learning contacts after leaving", async () => {
    prepareCockpitMeetingCreation(key, { meeting: { creation_key: "10000000-0000-4000-8000-000000000001", node_id: null, meet_date: "2026-10-10", start_time: "", end_time: "", kind: "", status: "", track: "", parties: "Unit", organizer: "Owner", attendees: "Guest", location: "", title: "Captured meeting" }, provision: { create_dir: false }, workflow: null, autoSaveEntries: [{ party: "Unit", name: "Guest", position: "" }] });
    const view = setup(); let finish!: (value: CockpitMeetingCreationResult) => void; vi.mocked(view.props.onSubmit).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" })); await waitFor(() => expect(view.props.onSubmit).toHaveBeenCalledOnce());
    const nextClose = vi.fn(), nextCreated = vi.fn(); view.rerender(<CockpitMeetingCreate key="ws-2" {...view.props} wsId="ws-2" onOpenChange={nextClose} onCreated={nextCreated} />);
    await act(async () => finish({ meetingId: "meeting-created" }));
    expect(view.props.onAutoSaveDirectory).not.toHaveBeenCalled(); expect(view.props.onOpenChange).not.toHaveBeenCalled(); expect(view.props.onCreated).not.toHaveBeenCalled(); expect(nextClose).not.toHaveBeenCalled(); expect(nextCreated).not.toHaveBeenCalled();
    expect(useCockpitMeetingCreateDraftStore.getState().draft.byScope[key]).toBeUndefined(); expect(screen.getByRole("textbox", { name: "Subject" })).toHaveValue("");
  });
});

  it("starts another creation only after an explicit deleted-receipt acknowledgement, never after an unknown response", async () => {
    const view = setup(); const user = userEvent.setup(); vi.mocked(view.props.onSubmit).mockRejectedValueOnce(new Error("response lost")).mockRejectedValueOnce(new ApiError("Created meeting was deleted", 410, "Gone"));
    await user.type(screen.getByRole("textbox", { name: "Subject" }), "Replacement meeting"); await user.click(screen.getByRole("button", { name: "Create meeting" })); await screen.findByText("response lost");
    expect(screen.queryByRole("button", { name: enCockpit.meeting_center.restart_deleted })).toBeNull(); await user.click(screen.getByRole("button", { name: "Retry" })); await screen.findByText("Created meeting was deleted");
    expect(view.props.onSubmit).toHaveBeenCalledTimes(2); const first = vi.mocked(view.props.onSubmit).mock.calls[0]![0]; expect(vi.mocked(view.props.onSubmit).mock.calls[1]![0]).toEqual(first);
    await user.click(screen.getByRole("button", { name: enCockpit.meeting_center.restart_deleted })); expect(view.props.onSubmit).toHaveBeenCalledTimes(2); expect(screen.getByRole("textbox", { name: "Subject" })).toHaveValue("Replacement meeting");
    await user.click(screen.getByRole("button", { name: "Create meeting" })); await waitFor(() => expect(view.props.onCreated).toHaveBeenCalled()); expect(vi.mocked(view.props.onSubmit).mock.calls[2]![0].creation_key).not.toBe(first.creation_key);
  });

  it("waits for the directory destination before creating the meeting, without creating a minutes issue", async () => {
    let fail!: (error: Error) => void; vi.mocked(api.getCockpitContext).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const view = setup({ defaultProjectId: "project", defaultModuleId: "module" }); const user = userEvent.setup();
    const create = screen.getByRole("button", { name: "Create meeting" }); expect(create).toBeDisabled(); expect(await screen.findByText(enCockpit.meeting_center.checking_destination)).toBeVisible(); expect(view.props.onSubmit).not.toHaveBeenCalled();
    await act(async () => fail(new Error("Scope unavailable"))); expect(await screen.findByRole("alert")).toHaveTextContent("Could not load"); expect(create).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Retry" })); await waitFor(() => expect(create).toBeEnabled()); await user.click(create); await waitFor(() => expect(view.props.onSubmit).toHaveBeenCalledOnce());
    expect(vi.mocked(view.props.onSubmit).mock.calls[0]?.[2]).toBeNull();
    expect(vi.mocked(view.props.onSubmit).mock.calls[0]?.[1]).toMatchObject({ create_dir: true, create_task: false });
  });
  it("picks project, module and work item in one tree and files the meeting there", async () => {
    const view = setup({ defaultProjectId: null, defaultModuleId: null, defaultNodeId: null }); const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Ownership" }));
    await user.click(await screen.findByRole("button", { name: "Toggle project Programme" }));
    await user.click(await screen.findByRole("button", { name: "Toggle module Module" }));
    await user.click(await screen.findByRole("button", { name: "01.02.01 Draft" }));

    // The same selection drives the folder preview.
    expect(await screen.findByText(/\/Volumes\/team\/Meetings/)).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Subject" }), "Tree destination");
    await user.click(screen.getByRole("button", { name: "Create meeting" }));
    await waitFor(() => expect(view.props.onSubmit).toHaveBeenCalledOnce());
    expect(vi.mocked(view.props.onSubmit).mock.calls[0]?.[1]).toMatchObject({
      project_id: "project", module_id: "module", node_id: "node-work", create_dir: true,
    });
  });

  it("asks for the project's own folder when no module is picked", async () => {
    setup({ defaultProjectId: "project", defaultModuleId: null, defaultNodeId: null });
    // Empty, not omitted: omitting module_id asks the server for the board's
    // remembered module, which is another project's (or another module's)
    // folder and is refused or previewed wrongly.
    await waitFor(() =>
      expect(api.getCockpitMeetingDestination).toHaveBeenLastCalledWith(
        { projectId: "project", moduleId: "", nodeId: "" },
        "ws-1",
      ),
    );
  });

  it("retries a fixed creation command with its original task and folder actions while fresh destination reads fail", async () => {
    const command = prepareCockpitMeetingCreation(key, { meeting: { creation_key: "10000000-0000-4000-8000-000000000001", node_id: null, meet_date: "2026-10-10", start_time: "", end_time: "", kind: "", status: "", track: "", parties: "", organizer: "Owner", attendees: "", location: "", title: "Fixed request" }, provision: { project_id: "project", module_id: "module", node_id: "", create_dir: true, base_dir: "/captured-folder" }, workflow: { reviewer_id: "person", project_id: "project", module_id: "module" }, autoSaveEntries: [] });
    vi.mocked(api.getCockpitContext).mockRejectedValue(new Error("Scope unavailable")); vi.mocked(api.getCockpitMeetingDestination).mockRejectedValue(new Error("Folder unavailable"));
    const view = setup(); const user = userEvent.setup(); const retry = (await screen.findAllByRole("button", { name: "Retry" })).find((button) => !button.matches(":disabled"))!; expect(retry).toBeEnabled(); await user.click(retry);
    await waitFor(() => expect(view.props.onSubmit).toHaveBeenCalledExactlyOnceWith(command.meeting, command.provision, command.workflow));
  });
