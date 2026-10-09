import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import { cockpitMeetingWorkflowOptions, useCockpitMinutesDraftStore } from "@multica/core/cockpit";
import { EMPTY_COCKPIT_MEETING_WORKFLOW } from "@multica/core/api/schemas";
import type { CockpitMeetingIssueLink, CockpitMeetingWorkflow, MemberWithUser } from "@multica/core/types";
import { workflowFixture, versionFixture, WORKFLOW_MEETING_ID } from "./workflow-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";
import enIssues from "../../locales/en/issues.json";
import { CockpitMeetingWorkflowPanel } from "./cockpit-meeting-workflow";

vi.mock("@multica/core/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/api")>()),
  api: {
    getCockpitMeetingWorkflow: vi.fn(), enableCockpitMeetingWorkflow: vi.fn(), updateCockpitMeetingReadiness: vi.fn(),
    releaseCockpitMeetingWorkflow: vi.fn(), submitCockpitMinutesVersion: vi.fn(), reviewCockpitMinutesVersion: vi.fn(),
    publishCockpitMinutesVersion: vi.fn(), listProjects: vi.fn(), listModules: vi.fn(),
  },
}));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ issueDetail: (id: string) => `/ws/issues/${id}` }) }));
vi.mock("../../navigation", () => ({ AppLink: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("../../issues/components/status-icon", () => ({ StatusIcon: () => <span /> }));
vi.mock("@multica/core/workspace/hooks", () => ({ useActorName: () => ({ getActorName: (_type: string, id: string) => id === "reviewer-1" ? "Human Reviewer" : "Minutes Writer" }) }));
vi.mock("../../issues/components/pickers/assignee-picker", () => ({ AssigneePicker: () => <button type="button">Minutes assignee picker</button> }));

const members = [{ id: "member-row-1", user_id: "reviewer-1", name: "Human Reviewer", email: "reviewer@example.test", role: "owner" }] as MemberWithUser[];
let knownMembers: MemberWithUser[];
let membersLoaded: boolean;
let server: CockpitMeetingWorkflow;
let links: CockpitMeetingIssueLink[];
let placement: { project_id: string | null; module_id: string | null; node_id: string | null };

function Harness() {
  const query = useQuery(cockpitMeetingWorkflowOptions("ws-1", WORKFLOW_MEETING_ID));
  return <CockpitMeetingWorkflowPanel wsId="ws-1" meetingId={WORKFLOW_MEETING_ID} currentUserId="reviewer-1"
    members={knownMembers} membersLoaded={membersLoaded} issueLinks={links} workflow={query.data} loading={query.isPending} loadError={query.isError}
    onReload={() => void query.refetch()} defaultPlacement={placement}
    defaultAssigneeType="member" defaultAssigneeId="reviewer-1" />;
}
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, issues: enIssues } }}><Harness /></I18nProvider></QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  useCockpitMinutesDraftStore.getState().clearDraft();
  server = { ...EMPTY_COCKPIT_MEETING_WORKFLOW, meeting_id: WORKFLOW_MEETING_ID };
  links = [];
  knownMembers = members;
  membersLoaded = true;
  placement = { project_id: "p1", module_id: "m1", node_id: null };
  vi.mocked(api.getCockpitMeetingWorkflow).mockImplementation(async () => structuredClone(server));
  vi.mocked(api.listProjects).mockResolvedValue({ projects: [{ id: "p1", title: "Project" }], total: 1 } as Awaited<ReturnType<typeof api.listProjects>>);
  vi.mocked(api.listModules).mockResolvedValue({ modules: [{ id: "m1", project_id: "p1", title: "Module" }], total: 1 } as Awaited<ReturnType<typeof api.listModules>>);
  vi.mocked(api.enableCockpitMeetingWorkflow).mockImplementation(async (_meetingId, body) => {
    server = workflowFixture({ reviewer_id: body.reviewer_id }); return structuredClone(server);
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
  vi.mocked(api.publishCockpitMinutesVersion).mockImplementation(async (_meetingId, versionId) => {
    server = { ...server, revision: server.revision + 1, published_version_id: versionId, versions: server.versions.map((version) => version.id === versionId
      ? { ...version, published_at: "2026-10-09T10:03:00Z", published_by: "reviewer-1" } : version) };
    return structuredClone(server);
  });
});

describe("meeting work package workflow", () => {
  it("renders immutable current and historical minutes as formatted Markdown", async () => {
    const current = versionFixture({ id: "v2", version_number: 2, content: "# Current meeting minutes\n\nA **clear** boundary.", decision: "approved" });
    const previous = versionFixture({ id: "v1", version_number: 1, content: "## Earlier minutes\n\nOriginal text.", decision: "changes_requested" });
    server = workflowFixture({ current_version_id: current.id, versions: [current, previous] });
    setup();
    expect(await screen.findByRole("heading", { name: "Current meeting minutes" })).toBeTruthy();
    fireEvent.click(screen.getByText("Version 1 · Changes requested"));
    expect(screen.getByRole("heading", { name: "Earlier minutes" })).toBeTruthy();
    expect(server.versions[0]?.content).toBe("# Current meeting minutes\n\nA **clear** boundary.");
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
    expect(await screen.findByText(/The designated reviewer is no longer a workspace member/)).toHaveTextContent("Reassigning the issue does not transfer formal review authority");
    expect(screen.queryByRole("button", { name: /transfer reviewer/i })).toBeNull();
  });

  it("adopts an explicitly selected unscoped backlog issue without sending placement or reassignment", async () => {
    placement = { project_id: null, module_id: null, node_id: null };
    links = [{ meeting_id: WORKFLOW_MEETING_ID, issue_id: "legacy-issue", issue_identifier: "BIO-10", issue_number: 10,
      issue_title: "Legacy minutes", issue_status: "backlog", role: "task", roles: [], position: 0 }];
    setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("combobox", { name: "Existing issue" }));
    await user.click(await screen.findByRole("option", { name: "BIO-10 Legacy minutes" }));
    expect(screen.queryByRole("combobox", { name: "Project" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Module" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Minutes assignee picker" })).toBeNull();
    expect(screen.getByRole("button", { name: "Enable work package" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Enable work package" }));
    await waitFor(() => expect(api.enableCockpitMeetingWorkflow).toHaveBeenCalledWith(WORKFLOW_MEETING_ID, {
      reviewer_id: "reviewer-1", existing_issue_id: "legacy-issue",
    }));
  });

  it("requires explicit readiness and release, keeps done separate from review, and publishes only on request", async () => {
    setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Enable work package" }));
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
    await user.click(screen.getByRole("button", { name: "Submit review" }));
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
