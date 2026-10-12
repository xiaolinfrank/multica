import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import { cockpitKeys, cockpitScopeSelectorKeys, cockpitMeetingWorkflowOptions, useCockpitMinutesDraftStore, useCockpitReviewerHandoffDraftStore, useCockpitHistoryViewStore } from "@multica/core/cockpit";
import { CockpitNasExportSchema, EMPTY_COCKPIT_MEETING_WORKFLOW } from "@multica/core/api/schemas";
import type { CockpitMeetingIssueLink, CockpitMeetingWorkflow, MemberWithUser } from "@multica/core/types";
import { workflowFixture, versionFixture, workflowSummary, compactWorkflow, versionMetadata, historyNasJobs, WORKFLOW_MEETING_ID } from "./workflow-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";
import enIssues from "../../locales/en/issues.json";
import { CockpitMeetingWorkflowPanel } from "./cockpit-meeting-workflow";

vi.mock("@multica/core/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/api")>()),
  api: {
    getCockpitMeetingWorkflowSummary: vi.fn(), commandCockpitMeetingWorkflow: vi.fn(), getCockpitMinutesVersion: vi.fn(), getCockpitMinutesVersions: vi.fn(), getCockpitReviewerHandoffs: vi.fn(), getCockpitNasExports: vi.fn(),
    getCockpitMeetingWorkflow: vi.fn(), enableCockpitMeetingWorkflow: vi.fn(), updateCockpitMeetingReadiness: vi.fn(),
    releaseCockpitMeetingWorkflow: vi.fn(), submitCockpitMinutesVersion: vi.fn(), reviewCockpitMinutesVersion: vi.fn(),
    publishCockpitMinutesVersion: vi.fn(), reassignCockpitMeetingReviewer: vi.fn(), bindCockpitMinutesIssue: vi.fn(), unbindCockpitMinutesIssue: vi.fn(), focusCockpitMinutesIssue: vi.fn(), listProjects: vi.fn(), listModules: vi.fn(),
    getIssue: vi.fn(), searchIssues: vi.fn(), listCockpitMeetingActions: vi.fn(), listIssueStatuses: vi.fn(), searchCockpitAssignees: vi.fn(), searchCockpitScopeMembers: vi.fn(), getCockpitContext: vi.fn(), searchCockpitScopes: vi.fn(),
  },
}));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ issueDetail: (id: string) => `/ws/issues/${id}`, projects: () => "/ws/projects", projectDetail: (id: string) => `/ws/projects/${id}`, settings: () => "/ws/settings" }) }));
vi.mock("../../navigation", () => ({ useNavigation: () => ({ searchParams: new URLSearchParams() }), AppLink: ({ href, target, children }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} target={target}>{children}</a> }));
vi.mock("../../issues/components/status-icon", () => ({ StatusIcon: () => <span /> }));
vi.mock("@multica/core/workspace/hooks", () => ({ useActorName: () => ({ getActorName: (_type: string, id: string) => id === "reviewer-1" ? "Human Reviewer" : "Minutes Writer" }) }));
vi.mock("./cockpit-assignee-picker", () => ({ CockpitAssigneePicker: () => <button type="button">Minutes assignee picker</button> }));

const members = [{ id: "member-row-1", user_id: "reviewer-1", name: "Human Reviewer", email: "reviewer@example.test", role: "owner" }] as MemberWithUser[];
let knownMembers: MemberWithUser[];
let membersLoaded: boolean;
let server: CockpitMeetingWorkflow;
let currentUserId: string;
let readOnly: boolean;
let links: CockpitMeetingIssueLink[];
let placement: { project_id: string | null; module_id: string | null; node_id: string | null };

function Harness() {
  const query = useQuery(cockpitMeetingWorkflowOptions("ws-1", WORKFLOW_MEETING_ID));
  return <CockpitMeetingWorkflowPanel wsId="ws-1" meetingId={WORKFLOW_MEETING_ID} currentUserId={currentUserId} readOnly={readOnly}
    members={knownMembers} issueLinks={links} workflow={query.data} loading={query.isPending} loadError={query.isError}
    onReload={() => void query.refetch()} resourcesHref="/ws/cockpit?meeting=10000000-0000-4000-8000-000000000001&meeting_view=resources" defaultPlacement={placement}
    defaultAssigneeType="member" defaultAssigneeId="reviewer-1" />;
}
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const rendered = render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, issues: enIssues } }}><Harness /></I18nProvider></QueryClientProvider>);
  return { ...rendered, client };
}

async function openCurrentMinutes() {
  fireEvent.click(await screen.findByRole("button", { name: /Read (current|and review) minutes/ }));
  const dialog = await screen.findByRole("dialog", { name: /Minutes version/ });
  await within(dialog).findByText(server.versions.find((version) => version.id === server.current_version_id)?.content || "Fixed minutes text", { exact: false });
  return dialog;
}
async function openHandoffHistory() {
  fireEvent.click(await screen.findByRole("button", { name: /Version history/ }));
  fireEvent.click(await screen.findByRole("tab", { name: "Reviewer changes" }));
  const region = screen.getByRole("region", { name: "Minutes history" });
  await waitFor(() => expect(within(region).getAllByRole("article").length).toBeGreaterThan(0));
  for (const details of within(region).getAllByText("Reason and linked review issues")) fireEvent.click(details);
  return region;
}

beforeEach(() => {
  vi.clearAllMocks();
  useCockpitMinutesDraftStore.getState().clearDraft();
  useCockpitHistoryViewStore.getState().reset();
  useCockpitReviewerHandoffDraftStore.getState().clearDraft();
  currentUserId = "reviewer-1";
  readOnly = false;
  server = { ...EMPTY_COCKPIT_MEETING_WORKFLOW, meeting_id: WORKFLOW_MEETING_ID };
  links = [];
  knownMembers = members;
  membersLoaded = true;
  placement = { project_id: "p1", module_id: "m1", node_id: null };
  vi.mocked(api.getCockpitMeetingWorkflow).mockImplementation(async () => structuredClone(server));
  vi.mocked(api.getCockpitMeetingWorkflowSummary).mockImplementation(async () => workflowSummary(await api.getCockpitMeetingWorkflow(WORKFLOW_MEETING_ID)));
  vi.mocked(api.getCockpitMinutesVersion).mockImplementation(async (_ws, _meeting, versionId) => {
    const version = server.versions.find((entry) => entry.id === versionId);
    return version ? { workspace_id: "ws-1", meeting_id: server.meeting_id, workflow_revision: server.revision, version,
      can_review: server.can_review, can_publish: server.can_publish, can_export_nas: server.can_export_nas } : null;
  });
  vi.mocked(api.getCockpitMinutesVersions).mockImplementation(async (_ws, _meeting, query) => {
    const offset = Number(query?.cursor || 0); const items = [...server.versions].sort((a, b) => b.version_number - a.version_number).slice(offset, offset + 25).map(versionMetadata);
    return { workspace_id: "ws-1", meeting_id: server.meeting_id, workflow_revision: server.revision, items, total: server.versions.length, next_cursor: offset + 25 < server.versions.length ? String(offset + 25) : null };
  });
  vi.mocked(api.getCockpitReviewerHandoffs).mockImplementation(async () => ({ workspace_id: "ws-1", meeting_id: server.meeting_id, workflow_revision: server.revision,
    items: server.reviewer_handoffs.map((entry) => ({ ...entry, version_number: server.versions.find((version) => version.id === entry.version_id)?.version_number ?? null })), total: server.reviewer_handoffs.length, next_cursor: null }));
  vi.mocked(api.getCockpitNasExports).mockImplementation(async () => ({ workspace_id: "ws-1", meeting_id: server.meeting_id, workflow_revision: server.revision,
    version_id: null, status: "", items: historyNasJobs(server), total: server.nas_exports.length, next_cursor: null }));
  vi.mocked(api.commandCockpitMeetingWorkflow).mockImplementation(async (_ws, meetingId, command) => {
    let result: CockpitMeetingWorkflow;
    switch (command.action) {
      case "enabled": result = await api.enableCockpitMeetingWorkflow(meetingId, command.body); break;
      case "readiness": result = await api.updateCockpitMeetingReadiness(meetingId, command.body); break;
      case "released": result = await api.releaseCockpitMeetingWorkflow(meetingId, command.body.expected_revision); break;
      case "submitted": result = await api.submitCockpitMinutesVersion(meetingId, command.body); break;
      case "reviewed": result = await api.reviewCockpitMinutesVersion(meetingId, command.version_id, command.body); break;
      case "published": result = await api.publishCockpitMinutesVersion(meetingId, command.version_id, command.body.expected_revision, command.body.nas_export); break;
      case "reviewer_reassigned": result = await api.reassignCockpitMeetingReviewer(meetingId, command.body); break;
      case "bound": result = await api.bindCockpitMinutesIssue(meetingId, command.body.issue_id, command.body.expected_revision); break;
      case "unbound": result = await api.unbindCockpitMinutesIssue(meetingId, command.issue_id, command.expected_revision); break;
      case "focused": result = await api.focusCockpitMinutesIssue(meetingId, command.body.issue_id, command.body.expected_revision); break;
      default: throw new Error("Unexpected workflow command");
    }
    return compactWorkflow(result, command);
  });
  vi.mocked(api.listCockpitMeetingActions).mockResolvedValue({ meeting_id: WORKFLOW_MEETING_ID, items: [], total: 0, filtered_total: 0, next_cursor: null, can_add: false });
  vi.mocked(api.getCockpitContext).mockImplementation(async (_ws, scope) => ({ workspace_id: "ws-1", scope: { project_id: scope?.projectId ?? null, module_id: scope?.moduleId ?? null, project_title: scope?.projectId ? "Project" : "", module_title: scope?.moduleId ? "Module" : "" },
    cockpit: null, actor: { user_id: "reviewer-1", role: "owner", is_human: true }, has_meeting_workflows: false, has_stable_bindings: true }));
  vi.mocked(api.searchCockpitScopes).mockImplementation(async (_ws, kind, query) => ({ workspace_id: "ws-1", project_id: query.project_id ?? null, items: [{ id: kind === "projects" ? "p1" : "m1", title: kind === "projects" ? "Project" : "Module", project_id: kind === "projects" ? null : "p1" }], total: 1, next_cursor: null }));
  vi.mocked(api.searchCockpitScopeMembers).mockImplementation(async (_ws, query) => {
    if (!membersLoaded) return new Promise(() => {});
    const matched = knownMembers.filter((member) => !query?.ids?.length || query.ids.includes(member.user_id)).filter((member) => !query?.q || member.name.toLowerCase().includes(query.q.toLowerCase()));
    return { workspace_id: "ws-1", scope: { q: query?.q ?? "", ids: query?.ids ?? [] }, items: matched.map((member) => ({ id: member.user_id, title: member.name, role: member.role, avatar_url: member.avatar_url ?? "" })), total: matched.length, filtered_total: matched.length, next_cursor: null };
  });
  vi.mocked(api.searchCockpitAssignees).mockImplementation(async (_ws, query) => ({ workspace_id: "ws-1", q: query?.q ?? "", kind: query?.kind ?? "all", selected_type: query?.selected_type ?? null, selected_id: query?.selected_id ?? null,
    items: [{ id: query?.selected_id ?? "reviewer-1", type: query?.selected_type ?? "member", title: "Minutes Writer", email: "", avatar_url: "", status: "active", runtime_bound: null, can_assign: true, reason: "" }], total: 1, next_cursor: null }));
  const adoptedIssue = { id: "legacy-issue", workspace_id: "ws-1", identifier: "BIO-10", title: "Legacy minutes", status: "backlog", project_id: null, module_id: null };
  vi.mocked(api.searchIssues).mockResolvedValue({ issues: [adoptedIssue] } as Awaited<ReturnType<typeof api.searchIssues>>);
  vi.mocked(api.getIssue).mockResolvedValue(adoptedIssue as Awaited<ReturnType<typeof api.getIssue>>);
  vi.mocked(api.listIssueStatuses).mockResolvedValue({ statuses: [], categories: [], total: 0 });
  vi.mocked(api.listProjects).mockResolvedValue({ projects: [{ id: "p1", title: "Project" }], total: 1 } as Awaited<ReturnType<typeof api.listProjects>>);
  vi.mocked(api.bindCockpitMinutesIssue).mockImplementation(async (_meetingId, issueId) => {
    server = { ...server, revision: server.revision + 1, minutes_issues: [...server.minutes_issues, { issue: { id: issueId, identifier: `BIO-${issueId.slice(0, 2)}`, title: "Second writer", status: "backlog", assignee_type: "member", assignee_id: "reviewer-1" }, is_focus: false, roles: ["minutes"] }] };
    return structuredClone(server);
  });
  vi.mocked(api.unbindCockpitMinutesIssue).mockImplementation(async (_meetingId, issueId) => {
    server = { ...server, revision: server.revision + 1, minutes_issues: server.minutes_issues.filter((b) => b.issue?.id !== issueId) };
    return structuredClone(server);
  });
  vi.mocked(api.focusCockpitMinutesIssue).mockImplementation(async (_meetingId, issueId) => {
    server = { ...server, revision: server.revision + 1, minutes_issue: server.minutes_issues.find((b) => b.issue?.id === issueId)?.issue ?? server.minutes_issue,
      minutes_issues: server.minutes_issues.map((b) => ({ ...b, is_focus: b.issue?.id === issueId })) };
    return structuredClone(server);
  });
  vi.mocked(api.listModules).mockResolvedValue({ modules: [{ id: "m1", project_id: "p1", title: "Module" }], total: 1 } as Awaited<ReturnType<typeof api.listModules>>);
  vi.mocked(api.enableCockpitMeetingWorkflow).mockImplementation(async (_meetingId, body) => {
    server = workflowFixture({ reviewer_id: body.reviewer_id });
    if (body.existing_issue_id && server.minutes_issue) server.minutes_issue = { ...server.minutes_issue, id: body.existing_issue_id, identifier: "BIO-10" };
    return structuredClone(server);
  });
  vi.mocked(api.updateCockpitMeetingReadiness).mockImplementation(async (_meetingId, body) => {
    server = { ...server, revision: server.revision + 1,
      ended_at: body.ended ? "2026-10-09T10:00:00Z" : server.ended_at,
      materials_ready: body.materials_ready ?? server.materials_ready };
    return structuredClone(server);
  });
  vi.mocked(api.releaseCockpitMeetingWorkflow).mockImplementation(async () => {
    server = { ...server, revision: server.revision + 1, released_at: "2026-10-09T10:01:00Z", minutes_issue: { ...server.minutes_issue!, status: "todo" } };
    return structuredClone(server);
  });
  vi.mocked(api.submitCockpitMinutesVersion).mockImplementation(async (_meetingId, body) => {
    const version = versionFixture({ submission_key: body.submission_key, content: body.content });
    // A generic Issue edit may close or reassign this task; it is not a formal review.
    version.review_issue.status = "done";
    server = { ...server, revision: server.revision + 1, current_version_id: version.id, versions: [version] };
    return structuredClone(server);
  });
  vi.mocked(api.reviewCockpitMinutesVersion).mockImplementation(async (_meetingId, versionId, body) => {
    server = { ...server, revision: server.revision + 1, versions: server.versions.map((version) => version.id === versionId
      ? { ...version, decision: body.decision, feedback: body.feedback, reviewed_at: "2026-10-09T10:02:00Z", reviewed_by: "reviewer-1" } : version) };
    return structuredClone(server);
  });
  vi.mocked(api.reassignCockpitMeetingReviewer).mockImplementation(async (_meetingId, body) => {
    const current = server.versions.find((version) => version.id === server.current_version_id);
    const pending = current?.decision === "pending";
    const nextIssue = pending ? { ...current.review_issue, id: "review-2", identifier: "BIO-3", assignee_id: body.reviewer_id } : null;
    server = { ...server, reviewer_id: body.reviewer_id, revision: server.revision + 1,
      versions: server.versions.map((version) => version.id === current?.id && pending ? { ...version, reviewer_id: body.reviewer_id, review_issue: nextIssue! } : version),
      reviewer_handoffs: [...server.reviewer_handoffs, {
        id: "handoff-1", handoff_key: body.handoff_key, from_reviewer_id: server.reviewer_id!, to_reviewer_id: body.reviewer_id,
        version_id: pending ? current.id : null, from_review_issue: pending ? { ...current.review_issue, status: "cancelled" } : null,
        to_review_issue: nextIssue, reason: body.reason, created_by: currentUserId, created_at: "2026-10-10T10:00:00Z", revision: server.revision + 1,
      }],
    };
    return structuredClone(server);
  });
  vi.mocked(api.publishCockpitMinutesVersion).mockImplementation(async (_meetingId, versionId) => {
    server = { ...server, revision: server.revision + 1, published_version_id: versionId, versions: server.versions.map((version) => version.id === versionId
      ? { ...version, published_at: "2026-10-09T10:03:00Z", published_by: "reviewer-1" } : version) };
    return structuredClone(server);
  });
});

describe("meeting work package workflow", () => {
  it("makes readiness prerequisites actionable without dispatching an unassigned minutes issue", async () => {
    const ready = workflowFixture({ ended_at: "2026-10-10T10:00:00Z", materials_ready: true });
    server = { ...ready, minutes_issue: { ...ready.minutes_issue!, assignee_type: "", assignee_id: null } };
    setup();
    expect(await screen.findByRole("button", { name: "Start minutes issue" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "Assign the minutes issue (new tab)" })).toHaveAttribute("href", "/ws/issues/minutes-1");
    expect(screen.getByRole("link", { name: "Assign the minutes issue (new tab)" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "Prepare meeting materials" })).toHaveAttribute("href", expect.stringContaining("meeting_view=resources"));
    expect(api.releaseCockpitMeetingWorkflow).not.toHaveBeenCalled();
  });

  it("keeps a document with an unfamiliar formal outcome read-only even if its capability flag is true", async () => {
    const version = versionFixture();
    server = workflowFixture({ current_version_id: version.id, versions: [version] });
    vi.mocked(api.getCockpitMinutesVersion).mockResolvedValue({ workspace_id: "ws-1", meeting_id: WORKFLOW_MEETING_ID, workflow_revision: 1,
      version: { ...version, decision: "future-outcome" }, can_review: true, can_publish: false, can_export_nas: false });
    setup();
    const reader = await openCurrentMinutes();
    expect(reader).toHaveTextContent("future-outcome");
    expect(within(reader).queryByRole("button", { name: "Submit review" })).toBeNull();
    expect(api.reviewCockpitMinutesVersion).not.toHaveBeenCalled();
  });

  it("can leave an invalid historical page without losing the first-page recovery control", async () => {
    const versions = Array.from({ length: 30 }, (_, index) => versionFixture({ id: `v${index + 1}`, version_number: index + 1 }));
    server = workflowFixture({ current_version_id: "v30", versions });
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Version history (30)" }));
    const history = screen.getByRole("region", { name: "Minutes history" });
    await within(history).findByRole("button", { name: "Read version 30" });
    vi.mocked(api.getCockpitMinutesVersions).mockRejectedValueOnce(new Error("Invalid cursor"));
    fireEvent.click(within(history).getByRole("button", { name: "Next page" }));
    await within(history).findByRole("alert");
    expect(within(history).queryByText("No records in this view.")).toBeNull();
    fireEvent.click(within(history).getByRole("button", { name: "Return to first page" }));
    await within(history).findByRole("button", { name: "Read version 30" });
    expect(within(history).getByRole("button", { name: "Previous page" })).toBeDisabled();
  });

  it("loads bounded metadata and only the selected body, preserving a historical reader when current work advances", async () => {
    const versions = Array.from({ length: 35 }, (_, index) => versionFixture({ id: `v${index + 1}`, version_number: index + 1,
      content: `# Minutes ${index + 1}\n\n${"Fixed content. ".repeat(200)}`, decision: index === 34 ? "pending" : "approved",
      published_at: index < 34 ? "2026-10-10T10:00:00Z" : null }));
    server = workflowFixture({ current_version_id: "v35", published_version_id: "v34", versions });
    const { client } = setup();
    await screen.findByRole("button", { name: /Read (current|and review) minutes/ });
    expect(api.getCockpitMinutesVersion).not.toHaveBeenCalled();
    expect(api.getCockpitMinutesVersions).not.toHaveBeenCalled();
    expect(api.getCockpitReviewerHandoffs).not.toHaveBeenCalled();
    expect(api.getCockpitNasExports).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Submit review" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Version history (35)" }));
    const history = screen.getByRole("region", { name: "Minutes history" });
    await within(history).findByRole("button", { name: "Read version 35" });
    expect(within(history).getAllByRole("article")).toHaveLength(25);
    expect(api.getCockpitMinutesVersion).not.toHaveBeenCalled();
    fireEvent.click(within(history).getByRole("button", { name: "Next page" }));
    fireEvent.click(await within(history).findByRole("button", { name: "Read version 1" }));
    expect(vi.mocked(api.getCockpitMinutesVersions).mock.lastCall?.[2]).toMatchObject({ page_size: 25, cursor: "25" });
    const reader = await screen.findByRole("dialog", { name: "Minutes version 1" });
    await within(reader).findByRole("heading", { name: "Minutes 1" });
    expect(reader).toHaveTextContent("Previously published");
    expect(within(reader).queryByRole("button", { name: "Submit review" })).toBeNull();
    expect(within(reader).queryByRole("button", { name: "Publish version" })).toBeNull();
    server = { ...server, revision: 2, current_version_id: "v36", versions: [...versions, versionFixture({ id: "v36", version_number: 36, content: "New current text" })] };
    await act(async () => { client.setQueryData(cockpitKeys.workflow("ws-1", WORKFLOW_MEETING_ID), workflowSummary(server)); });
    expect(within(reader).getByRole("heading", { name: "Minutes 1" })).toBeVisible();
    await waitFor(() => expect(reader).toHaveTextContent("current working version is v36"));
    expect(api.getCockpitMinutesVersion).toHaveBeenCalledTimes(1);
    fireEvent.click(within(reader).getByRole("button", { name: "Close" }));
    expect(screen.getByRole("region", { name: "Current minutes version" })).toHaveTextContent("Version 36");
    expect(screen.getByRole("region", { name: "Official minutes" })).toHaveTextContent("Version 34");
  });

  it("withholds formal review until the exact current document is loaded and never carries the form into a new version", async () => {
    const version = versionFixture();
    server = workflowFixture({ current_version_id: version.id, versions: [version] });
    let finish!: (value: Awaited<ReturnType<typeof api.getCockpitMinutesVersion>>) => void;
    vi.mocked(api.getCockpitMinutesVersion).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { client } = setup();
    fireEvent.click(await screen.findByRole("button", { name: /Read (current|and review) minutes/ }));
    const reader = await screen.findByRole("dialog", { name: "Minutes version 1" });
    expect(within(reader).queryByRole("button", { name: "Submit review" })).toBeNull();
    await act(async () => finish({ workspace_id: "ws-1", meeting_id: WORKFLOW_MEETING_ID, workflow_revision: 1, version,
      can_review: true, can_publish: false, can_export_nas: false }));
    await within(reader).findByRole("button", { name: "Submit review" });
    fireEvent.change(within(reader).getByRole("textbox", { name: "Review feedback" }), { target: { value: "Feedback for version 1" } });
    const next = versionFixture({ id: "v2", version_number: 2, content: "A new fixed document" });
    server = { ...server, revision: 2, current_version_id: next.id, versions: [next, version] };
    await act(async () => { client.setQueryData(cockpitKeys.workflow("ws-1", WORKFLOW_MEETING_ID), workflowSummary(server)); });
    await waitFor(() => expect(within(reader).queryByRole("button", { name: "Submit review" })).toBeNull());
    expect(reader).toHaveTextContent("Fixed minutes text");
    expect(within(reader).getByRole("textbox", { name: "Review draft (read-only)" })).toHaveValue("Feedback for version 1");
    expect(within(reader).getByRole("textbox", { name: "Review draft (read-only)" })).toHaveAttribute("readonly");
    expect(api.reviewCockpitMinutesVersion).not.toHaveBeenCalled();
    fireEvent.click(within(reader).getByRole("button", { name: "Close" }));
    await openCurrentMinutes();
    expect(await screen.findByRole("textbox", { name: "Review feedback" })).toHaveValue("");
  });

  it("publishes with the selected NAS destination while an offline export remains a separate pending result", async () => {
    const version = versionFixture({ decision: "approved" });
    const destination = { root_id: "root-1", directory: "/Volumes/team/Meeting" };
    server = workflowFixture({ current_version_id: version.id, versions: [version], nas_destination: destination });
    vi.mocked(api.publishCockpitMinutesVersion).mockImplementationOnce(async () => {
      server = { ...server, revision: 2, published_version_id: version.id,
        versions: [{ ...version, published_at: "2026-10-09T12:00:00Z" }],
        nas_exports: [CockpitNasExportSchema.parse({ id: "nas-1", version_id: version.id, version_number: 1,
          source_issue_id: version.source_issue_id, content_hash: version.content_hash, ...destination,
          target_path: "/Volumes/team/Meeting/已发布纪要/fixed.md", revision: 2, status: "retry_wait", last_error: "NAS share offline" })],
      };
      return structuredClone(server);
    });
    setup();
    expect(await screen.findByRole("checkbox", { name: "Sync published minutes to NAS" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Publish version" }));
    await screen.findByText("Published");
    expect(screen.getByText("Waiting to retry")).toBeTruthy();
    expect(screen.getByText("NAS share offline")).toBeTruthy();
    expect(api.publishCockpitMinutesVersion).toHaveBeenCalledWith(WORKFLOW_MEETING_ID, version.id, 1, destination);
    expect(screen.queryByText("Unpublished")).toBeNull();
  });

  it("uses authorized ledger display names for departed reviewers, before the current member-name fallback", async () => {
    server = workflowFixture({ revision: 2, reviewer_handoffs: [{
      id: "handoff-name", handoff_key: "30000000-0000-4000-8000-000000000001",
      from_reviewer_id: "departed-user", to_reviewer_id: "reviewer-1", created_by: "former-manager",
      from_reviewer_name: "Former Reviewer", to_reviewer_name: "Updated Reviewer Name", created_by_name: "Original Manager",
      reason: "Team responsibility changed", created_at: "2026-10-10T10:00:00Z", revision: 2,
      version_id: null, from_review_issue: null, to_review_issue: null,
    }] });
    setup();
    const history = await openHandoffHistory();
    expect(history).toHaveTextContent("Former Reviewer → Updated Reviewer Name");
    expect(history).toHaveTextContent("Transferred by Original Manager");
    expect(history).not.toHaveTextContent("departed-user");
    expect(history).not.toHaveTextContent("former-manager");
    expect(history).not.toHaveTextContent("Human Reviewer");
  });

  it("recovers a departed reviewer with a required reason, a new review task and visible responsibility history", async () => {
    currentUserId = "manager-1";
    knownMembers = [
      { ...members[0]!, user_id: "manager-1", name: "Package Manager" },
      { ...members[0]!, id: "member-row-2", user_id: "reviewer-2", name: "New Reviewer" },
    ];
    const version = versionFixture();
    server = workflowFixture({ can_reassign_reviewer: true, current_version_id: version.id, versions: [version] });
    const user = userEvent.setup();
    setup();
    expect(await screen.findByText(/The fixed version’s reviewer is no longer/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Transfer review responsibility" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Version 1 keeps its fixed content");
    expect(within(dialog).getByRole("button", { name: "Confirm transfer" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "New reviewer" }));
    await user.click(await screen.findByRole("button", { name: "New Reviewer" }));
    expect(within(dialog).getByRole("button", { name: "Confirm transfer" })).toBeDisabled();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Reason for transfer" }), { target: { value: " Reviewer left the team " } });
    expect(api.reassignCockpitMeetingReviewer).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Confirm transfer" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(api.reassignCockpitMeetingReviewer).toHaveBeenCalledWith(WORKFLOW_MEETING_ID, {
      expected_revision: 1, handoff_key: expect.stringMatching(/^[0-9a-f-]{36}$/), reviewer_id: "reviewer-2", reason: "Reviewer left the team",
    });
    expect(server.versions[0]).toMatchObject({ id: version.id, content: version.content, content_hash: version.content_hash, decision: "pending", review_issue: { id: "review-2" } });
    const history = await openHandoffHistory();
    expect(history).toHaveTextContent("reviewer-1 → New Reviewer");
    expect(history).toHaveTextContent("Transferred by Package Manager");
    expect(history).toHaveTextContent("Reviewer left the team");
    expect(within(history).getByRole("link", { name: /BIO-2/ })).toHaveAttribute("href", "/ws/issues/BIO-2");
    expect(within(history).getByRole("link", { name: /BIO-3/ })).toHaveAttribute("href", "/ws/issues/BIO-3");
    expect(screen.queryByText(/The fixed version’s reviewer is no longer/)).toBeNull();
  });

  it("keeps a network-unknown transfer fixed across remount and retries the same command", async () => {
    knownMembers = [...members, { ...members[0]!, id: "member-row-2", user_id: "reviewer-2", name: "New Reviewer" }];
    server = workflowFixture({ can_reassign_reviewer: true });
    vi.mocked(api.reassignCockpitMeetingReviewer).mockRejectedValueOnce(new Error("Network unavailable"));
    const first = setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Transfer review responsibility" }));
    await user.click(screen.getByRole("button", { name: "New reviewer" }));
    await user.click(await screen.findByRole("button", { name: "New Reviewer" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Reason for transfer" }), { target: { value: "New responsibility" } });
    await user.click(screen.getByRole("button", { name: "Confirm transfer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Network unavailable");
    expect(screen.getByRole("textbox", { name: "Reason for transfer" })).toBeDisabled();
    first.unmount();
    setup();
    await user.click(await screen.findByRole("button", { name: "Retry transfer" }));
    expect(screen.queryByRole("button", { name: "New reviewer" })).toBeNull();
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Retry transfer" }));
    await openHandoffHistory();
    const calls = vi.mocked(api.reassignCockpitMeetingReviewer).mock.calls;
    expect(calls[1]?.[1]).toEqual(calls[0]?.[1]);
    expect(useCockpitReviewerHandoffDraftStore.getState().draft.byMeeting[WORKFLOW_MEETING_ID]).toBeUndefined();
  });

  it("requires reopening to reconfirm when another manager changes responsibility while the dialog is open", async () => {
    knownMembers = [...members, { ...members[0]!, id: "member-row-2", user_id: "reviewer-2", name: "New Reviewer" }];
    server = workflowFixture({ can_reassign_reviewer: true });
    const { client } = setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Transfer review responsibility" }));
    await user.click(screen.getByRole("button", { name: "New reviewer" }));
    await user.click(await screen.findByRole("button", { name: "New Reviewer" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Reason for transfer" }), { target: { value: "Requested coverage" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm transfer" })).toBeEnabled());
    server = { ...server, revision: 2, reviewer_id: "reviewer-3" };
    await act(async () => { client.setQueryData(cockpitKeys.workflow("ws-1", WORKFLOW_MEETING_ID), workflowSummary(server)); });
    expect(await screen.findByRole("alert")).toHaveTextContent("The workflow changed while this dialog was open");
    expect(screen.getByRole("button", { name: "Confirm transfer" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Confirm transfer" }));
    expect(api.reassignCockpitMeetingReviewer).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Transfer review responsibility" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Reviewer: reviewer-3");
    expect(screen.getByRole("textbox", { name: "Reason for transfer" })).toHaveValue("Requested coverage");
    await user.click(screen.getByRole("button", { name: "Confirm transfer" }));
    await waitFor(() => expect(api.reassignCockpitMeetingReviewer).toHaveBeenCalledWith(WORKFLOW_MEETING_ID, expect.objectContaining({ expected_revision: 2, reviewer_id: "reviewer-2" })));
  });

  it("changes only the future reviewer after approval and preserves the fixed version and publication authority", async () => {
    knownMembers = [...members, { ...members[0]!, id: "member-row-2", user_id: "reviewer-2", name: "New Reviewer" }];
    const version = versionFixture({ decision: "approved", reviewed_by: "reviewer-1", reviewed_at: "2026-10-09T11:00:00Z" });
    server = workflowFixture({ can_reassign_reviewer: true, current_version_id: version.id, versions: [version] });
    setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Transfer review responsibility" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Only the reviewer for future submissions will change");
    await user.click(screen.getByRole("button", { name: "New reviewer" }));
    expect(await screen.findByRole("button", { name: "Human Reviewer" })).toBeDisabled();
    await user.click(await screen.findByRole("button", { name: "New Reviewer" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Reason for transfer" }), { target: { value: "Next round coverage" } });
    await user.click(screen.getByRole("button", { name: "Confirm transfer" }));
    await openHandoffHistory();
    expect(server.versions[0]).toEqual(version);
    expect(server.reviewer_handoffs[0]).toMatchObject({ version_id: null, from_review_issue: null, to_review_issue: null });
    expect(screen.getByRole("button", { name: "Publish version" })).toBeEnabled();
    expect(screen.getByText("Reviewer for future submissions: New Reviewer")).toBeTruthy();
  });

  it.each([
    { can_manage: false, can_reassign_reviewer: true, actor: "reviewer-1", readonly: false },
    { can_manage: true, can_reassign_reviewer: false, actor: "reviewer-1", readonly: false },
    { can_manage: true, can_reassign_reviewer: true, actor: "", readonly: false },
    { can_manage: true, can_reassign_reviewer: true, actor: "reviewer-1", readonly: true },
  ])("does not offer a handoff without verified authority: %j", async ({ actor, readonly, ...caps }) => {
    currentUserId = actor;
    readOnly = readonly;
    server = workflowFixture(caps);
    setup();
    await screen.findByText("Minutes issue");
    expect(screen.queryByRole("button", { name: "Transfer review responsibility" })).toBeNull();
  });

  it("keeps the previous assignment's feedback readable and requires a new form after a replacement review issue", async () => {
    const version = versionFixture();
    server = workflowFixture({ current_version_id: version.id, versions: [version] });
    const { client } = setup();
    await openCurrentMinutes();
    fireEvent.change(await screen.findByRole("textbox", { name: "Review feedback" }), { target: { value: "Draft for old responsibility" } });
    server = { ...server, revision: 3, versions: [{ ...version, review_issue: { ...version.review_issue, id: "replacement-review" } }] };
    await act(async () => { client.setQueryData(cockpitKeys.workflow("ws-1", WORKFLOW_MEETING_ID), workflowSummary(server)); });
    await act(async () => { await client.invalidateQueries({ queryKey: cockpitKeys.workflowHistory("ws-1", WORKFLOW_MEETING_ID) }); });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Review draft (read-only)" })).toHaveValue("Draft for old responsibility"));
    expect(screen.queryByRole("button", { name: "Submit review" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await openCurrentMinutes();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Review feedback" })).toHaveValue(""));
  });

  it("does not block an approved current version when only the future reviewer has left", async () => {
    const version = versionFixture({ decision: "approved" });
    server = workflowFixture({ reviewer_id: "departed-future-reviewer", current_version_id: version.id, versions: [version] });
    setup();
    expect(await screen.findByText(/The reviewer for future submissions is no longer/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Publish version" })).toBeEnabled();
  });
  it("renders immutable current and historical minutes as formatted Markdown", async () => {
    const current = versionFixture({ id: "v2", version_number: 2, content: "# Current meeting minutes\n\nA **clear** boundary.", decision: "approved" });
    const previous = versionFixture({ id: "v1", version_number: 1, content: "## Earlier minutes\n\nOriginal text.", decision: "changes_requested" });
    server = workflowFixture({ current_version_id: current.id, versions: [current, previous] });
    setup();
    expect(api.getCockpitMinutesVersion).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: /Read (current|and review) minutes/ }));
    expect(await screen.findByRole("heading", { name: "Current meeting minutes" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Version history (2)" }));
    fireEvent.click(await screen.findByRole("button", { name: "Read version 1" }));
    expect(await screen.findByRole("heading", { name: "Earlier minutes" })).toBeTruthy();
    expect(server.versions[0]?.content).toBe("# Current meeting minutes\n\nA **clear** boundary.");
  });

  it("validates the selected reviewer by identity when the display-only member projection is empty", async () => {
    knownMembers = [];
    vi.mocked(api.searchCockpitScopeMembers).mockImplementation(async (_ws, query) => ({ workspace_id: "ws-1", scope: { q: query?.q ?? "", ids: query?.ids ?? [] },
      items: [{ id: "reviewer-1", title: "Confirmed reviewer", avatar_url: "", role: "member" }], total: 1, filtered_total: 1, next_cursor: null }));
    setup();
    const enable = await screen.findByRole("button", { name: "Enable work package" });
    await waitFor(() => expect(enable).toBeEnabled());
    fireEvent.click(enable);
    await waitFor(() => expect(api.enableCockpitMeetingWorkflow).toHaveBeenCalledWith(WORKFLOW_MEETING_ID, expect.objectContaining({ reviewer_id: "reviewer-1" })));
    expect(api.searchCockpitScopeMembers).toHaveBeenCalledWith("ws-1", { ids: ["reviewer-1"], page_size: 20 }, expect.any(AbortSignal));
  });

  it("requires the selected project and module to be confirmed by the scoped read before creating minutes", async () => {
    vi.mocked(api.getCockpitContext).mockResolvedValue(null);
    setup();
    const enable = await screen.findByRole("button", { name: "Enable work package" });
    await waitFor(() => expect(api.getCockpitContext).toHaveBeenCalled());
    expect(enable).toBeDisabled();
    fireEvent.click(enable);
    expect(api.enableCockpitMeetingWorkflow).not.toHaveBeenCalled();
    expect(api.listProjects).not.toHaveBeenCalled();
    expect(api.listModules).not.toHaveBeenCalled();
  });

  it("does not trust a displayed member or a malformed membership read when enabling a work package", async () => {
    vi.mocked(api.searchCockpitScopeMembers).mockResolvedValue(null);
    setup();
    const enable = await screen.findByRole("button", { name: "Enable work package" });
    await waitFor(() => expect(api.searchCockpitScopeMembers).toHaveBeenCalled());
    expect(enable).toBeDisabled();
    fireEvent.click(enable);
    expect(api.enableCockpitMeetingWorkflow).not.toHaveBeenCalled();
    expect(screen.queryByText(/no longer a workspace member/)).toBeNull();
  });

  it("withholds formal review on an unavailable identity read without falsely declaring the reviewer departed", async () => {
    const version = versionFixture();
    server = workflowFixture({ current_version_id: version.id, versions: [version] });
    vi.mocked(api.searchCockpitScopeMembers).mockRejectedValue(new Error("Member service unavailable"));
    setup();
    await openCurrentMinutes();
    expect(screen.queryByRole("button", { name: "Submit review" })).toBeNull();
    expect(screen.queryByText(/no longer a workspace member/)).toBeNull();
    expect(api.reviewCockpitMinutesVersion).not.toHaveBeenCalled();
  });

  it("warns about an absent designated reviewer only after membership has loaded", async () => {
    server = workflowFixture();
    knownMembers = [];
    membersLoaded = false;
    const first = setup();
    await screen.findByText("Minutes issue");
    expect(screen.queryByText(/no longer a workspace member/)).toBeNull();
    first.unmount();
    membersLoaded = true;
    setup();
    expect(await screen.findByText(/The reviewer for future submissions is no longer a workspace member/)).toHaveTextContent("Reassigning an issue does not transfer formal review authority");
    expect(screen.queryByRole("button", { name: "Transfer review responsibility" })).toBeNull();
  });

  it("adopts an explicitly selected unscoped backlog issue without sending placement or reassignment", async () => {
    placement = { project_id: null, module_id: null, node_id: null };
    vi.mocked(api.searchCockpitAssignees).mockRejectedValue(new Error("New executor lookup is unavailable"));
    links = [{ meeting_id: WORKFLOW_MEETING_ID, issue_id: "legacy-issue", issue_identifier: "BIO-10", issue_number: 10,
      issue_title: "Legacy minutes", issue_status: "backlog", role: "task", roles: [], position: 0 }];
    setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("combobox", { name: "Existing issue" }));
    await user.click(await screen.findByRole("option", { name: "Use an existing issue" }));
    await user.type(await screen.findByRole("textbox", { name: "Search existing issues" }), "BIO-10");
    await user.click(await screen.findByRole("button", { name: "BIO-10 Legacy minutes" }));
    expect(screen.queryByRole("combobox", { name: "Project" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Module" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Minutes assignee picker" })).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Enable work package" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Enable work package" }));
    await waitFor(() => expect(api.enableCockpitMeetingWorkflow).toHaveBeenCalledWith(WORKFLOW_MEETING_ID, {
      reviewer_id: "reviewer-1", existing_issue_id: "legacy-issue",
    }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Enable work package" })).toBeNull());
  });

  it("does not create a new minutes issue when the selected executor is no longer assignable", async () => {
    vi.mocked(api.searchCockpitAssignees).mockResolvedValue({ workspace_id: "ws-1", q: "", kind: "all", selected_type: "member", selected_id: "reviewer-1", items: [], total: 0, next_cursor: null });
    setup();
    await screen.findByRole("button", { name: "Enable work package" });
    await waitFor(() => expect(api.searchCockpitAssignees).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Enable work package" })).toBeDisabled();
    expect(api.enableCockpitMeetingWorkflow).not.toHaveBeenCalled();
  });

  it("checks the actual minutes executor before release and offers the source issue for repair", async () => {
    server = workflowFixture({ ended_at: "2026-10-09T10:00:00Z", materials_ready: true });
    vi.mocked(api.searchCockpitAssignees).mockResolvedValue({ workspace_id: "ws-1", q: "", kind: "all", selected_type: "member", selected_id: "writer-1", items: [], total: 0, next_cursor: null });
    setup();
    await screen.findByText(enCockpit.workflow.executor_unavailable);
    expect(screen.getByRole("button", { name: "Start minutes issue" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "Assign the minutes issue (new tab)" })).toHaveAttribute("href", "/ws/issues/minutes-1");
    expect(api.releaseCockpitMeetingWorkflow).not.toHaveBeenCalled();
  });

  it("retries an unknown release with its original revision despite a later executor lookup failure", async () => {
    server = workflowFixture({ ended_at: "2026-10-09T10:00:00Z", materials_ready: true });
    vi.mocked(api.releaseCockpitMeetingWorkflow).mockRejectedValueOnce(new Error("Network unavailable"));
    const { client } = setup();
    await waitFor(() => expect(screen.getByRole("button", { name: "Start minutes issue" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Start minutes issue" }));
    await screen.findByRole("button", { name: "Retry starting the minutes issue" });
    vi.mocked(api.searchCockpitAssignees).mockRejectedValue(new Error("Executor lookup unavailable"));
    server = { ...server, revision: 2 };
    await act(async () => {
      client.setQueryData(cockpitKeys.workflow("ws-1", WORKFLOW_MEETING_ID), workflowSummary(server));
      await client.invalidateQueries({ queryKey: cockpitScopeSelectorKeys.all("ws-1") });
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry starting the minutes issue" }));
    await waitFor(() => expect(api.releaseCockpitMeetingWorkflow).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.releaseCockpitMeetingWorkflow).mock.calls.map((call) => call[1])).toEqual([1, 1]);
  });

  it("requires explicit readiness and release, keeps done separate from review, and publishes only on request", async () => {
    setup();
    const user = userEvent.setup();
    const enable = await screen.findByRole("button", { name: "Enable work package" });
    await waitFor(() => expect(enable).toBeEnabled());
    await user.click(enable);
    const release = await screen.findByRole("button", { name: "Start minutes issue" });
    expect(release).toBeDisabled();
    expect(api.releaseCockpitMeetingWorkflow).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Mark meeting ended" }));
    await screen.findByText("Meeting ended");
    expect(release).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "Materials ready" }));
    await waitFor(() => expect(release).toBeEnabled());
    expect(api.releaseCockpitMeetingWorkflow).not.toHaveBeenCalled();
    await user.click(release);
    const draft = await screen.findByRole("textbox", { name: "Minutes draft" });
    fireEvent.change(draft, { target: { value: "Fixed minutes text" } });
    await user.click(screen.getByRole("button", { name: "Submit for review" }));
    expect(await screen.findByText("Pending review")).toBeTruthy();
    expect(screen.getByText("Unpublished")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Publish version" })).toBeNull();
    await openCurrentMinutes();
    await user.click(await screen.findByRole("button", { name: "Submit review" }));
    expect(await screen.findByText("Approved")).toBeTruthy();
    expect(screen.getByText("Unpublished")).toBeTruthy();
    expect(api.publishCockpitMinutesVersion).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Publish version" }));
    expect(await screen.findByText("Published")).toBeTruthy();
    expect(api.enableCockpitMeetingWorkflow).toHaveBeenCalledWith(WORKFLOW_MEETING_ID, expect.objectContaining({ reviewer_id: "reviewer-1" }));
  });

  it("retries an unconfirmed submission with the same key and fixed content", async () => {
    server = workflowFixture({ ended_at: "2026-10-09T10:00:00Z", materials_ready: true, released_at: "2026-10-09T10:01:00Z" });
    vi.mocked(api.submitCockpitMinutesVersion).mockRejectedValueOnce(new Error("Network unavailable"));
    setup();
    fireEvent.change(await screen.findByRole("textbox", { name: "Minutes draft" }), { target: { value: "Persistent draft" } });
    await userEvent.click(screen.getByRole("button", { name: "Submit for review" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Network unavailable");
    expect(screen.getByRole("textbox", { name: "Minutes draft" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Retry submission" }));
    await screen.findByText("Pending review");
    const calls = vi.mocked(api.submitCockpitMinutesVersion).mock.calls;
    expect(calls[1]?.[1]).toEqual(calls[0]?.[1]);
    expect(useCockpitMinutesDraftStore.getState().draft.byMeeting[WORKFLOW_MEETING_ID]).toBeUndefined();
  });

  it("requires feedback for changes and keeps the original minutes issue", async () => {
    const version = versionFixture();
    server = workflowFixture({ released_at: "2026-10-09T10:00:00Z", current_version_id: version.id, versions: [version] });
    setup();
    const user = userEvent.setup();
    await openCurrentMinutes();
    await user.click(await screen.findByRole("combobox", { name: "Review decision" }));
    await user.click(await screen.findByRole("option", { name: "Request changes" }));
    expect(screen.getByRole("button", { name: "Submit review" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Review feedback" }), { target: { value: "Clarify the boundary" } });
    await user.click(screen.getByRole("button", { name: "Submit review" }));
    await screen.findByText("Changes requested");
    expect(server.minutes_issue?.id).toBe("minutes-1");
    expect(api.releaseCockpitMeetingWorkflow).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Publish version" })).toBeNull();
  });
});

it("lists minutes bindings with focus and unbind actions", async () => {
  const second = { id: "minutes-2", identifier: "BIO-9", title: "Second writer", status: "backlog", assignee_type: "member", assignee_id: "reviewer-1" };
  server = workflowFixture({ minutes_issues: [
    { issue: { id: "minutes-1", identifier: "BIO-1", title: "Write minutes", status: "backlog", assignee_type: "member", assignee_id: "writer-1" }, is_focus: true, roles: ["minutes"] },
    { issue: second, is_focus: false, roles: ["minutes"] },
  ] });
  const rendered = setup();
  const list = await rendered.findByRole("region", { name: enCockpit.workflow.bindings_title });
  expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  expect(within(list).getByText(enCockpit.workflow.focus_badge)).toBeInTheDocument();
  // The focused row offers unbind only; the other row also offers set-focus.
  expect(within(list).getAllByRole("button", { name: enCockpit.workflow.set_focus })).toHaveLength(1);
  expect(within(list).getAllByRole("button", { name: enCockpit.workflow.unbind })).toHaveLength(2);
  const focusRevision = server.revision;
  fireEvent.click(within(list).getAllByRole("button", { name: enCockpit.workflow.set_focus })[0]!);
  await waitFor(() => expect(api.focusCockpitMinutesIssue).toHaveBeenCalledWith(WORKFLOW_MEETING_ID, "minutes-2", focusRevision));
  const unbindRevision = server.revision;
  fireEvent.click(within(list).getAllByRole("button", { name: enCockpit.workflow.unbind })[1]!);
  await waitFor(() => expect(api.unbindCockpitMinutesIssue).toHaveBeenCalledWith(WORKFLOW_MEETING_ID, "minutes-2", unbindRevision));
});
