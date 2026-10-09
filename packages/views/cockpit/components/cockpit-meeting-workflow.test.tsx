import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import { cockpitKeys, cockpitMeetingWorkflowOptions, useCockpitMinutesDraftStore, useCockpitReviewerHandoffDraftStore } from "@multica/core/cockpit";
import { CockpitNasExportSchema, EMPTY_COCKPIT_MEETING_WORKFLOW } from "@multica/core/api/schemas";
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
    publishCockpitMinutesVersion: vi.fn(), reassignCockpitMeetingReviewer: vi.fn(), listProjects: vi.fn(), listModules: vi.fn(),
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
let currentUserId: string;
let readOnly: boolean;
let links: CockpitMeetingIssueLink[];
let placement: { project_id: string | null; module_id: string | null; node_id: string | null };

function Harness() {
  const query = useQuery(cockpitMeetingWorkflowOptions("ws-1", WORKFLOW_MEETING_ID));
  return <CockpitMeetingWorkflowPanel wsId="ws-1" meetingId={WORKFLOW_MEETING_ID} currentUserId={currentUserId} readOnly={readOnly}
    members={knownMembers} membersLoaded={membersLoaded} issueLinks={links} workflow={query.data} loading={query.isPending} loadError={query.isError}
    onReload={() => void query.refetch()} defaultPlacement={placement}
    defaultAssigneeType="member" defaultAssigneeId="reviewer-1" />;
}
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const rendered = render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, issues: enIssues } }}><Harness /></I18nProvider></QueryClientProvider>);
  return { ...rendered, client };
}

beforeEach(() => {
  vi.clearAllMocks();
  useCockpitMinutesDraftStore.getState().clearDraft();
  useCockpitReviewerHandoffDraftStore.getState().clearDraft();
  currentUserId = "reviewer-1";
  readOnly = false;
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
    const history = await screen.findByRole("region", { name: "Review responsibility history" });
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
    await user.click(within(dialog).getByRole("combobox", { name: "New reviewer" }));
    await user.click(await screen.findByRole("option", { name: "New Reviewer" }));
    expect(within(dialog).getByRole("button", { name: "Confirm transfer" })).toBeDisabled();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Reason for transfer" }), { target: { value: " Reviewer left the team " } });
    expect(api.reassignCockpitMeetingReviewer).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Confirm transfer" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(api.reassignCockpitMeetingReviewer).toHaveBeenCalledWith(WORKFLOW_MEETING_ID, {
      expected_revision: 1, handoff_key: expect.stringMatching(/^[0-9a-f-]{36}$/), reviewer_id: "reviewer-2", reason: "Reviewer left the team",
    });
    expect(server.versions[0]).toMatchObject({ id: version.id, content: version.content, content_hash: version.content_hash, decision: "pending", review_issue: { id: "review-2" } });
    const history = screen.getByRole("region", { name: "Review responsibility history" });
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
    await user.click(screen.getByRole("combobox", { name: "New reviewer" }));
    await user.click(await screen.findByRole("option", { name: "New Reviewer" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Reason for transfer" }), { target: { value: "New responsibility" } });
    await user.click(screen.getByRole("button", { name: "Confirm transfer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Network unavailable");
    expect(screen.getByRole("textbox", { name: "Reason for transfer" })).toBeDisabled();
    first.unmount();
    setup();
    await user.click(await screen.findByRole("button", { name: "Retry transfer" }));
    expect(screen.queryByRole("combobox", { name: "New reviewer" })).toBeNull();
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Retry transfer" }));
    await screen.findByRole("region", { name: "Review responsibility history" });
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
    await user.click(screen.getByRole("combobox", { name: "New reviewer" }));
    await user.click(await screen.findByRole("option", { name: "New Reviewer" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Reason for transfer" }), { target: { value: "Requested coverage" } });
    expect(screen.getByRole("button", { name: "Confirm transfer" })).toBeEnabled();
    server = { ...server, revision: 2, reviewer_id: "reviewer-3" };
    await act(async () => { client.setQueryData(cockpitKeys.workflow("ws-1", WORKFLOW_MEETING_ID), server); });
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
    await user.click(screen.getByRole("combobox", { name: "New reviewer" }));
    expect(screen.queryByRole("option", { name: "Human Reviewer" })).toBeNull();
    await user.click(await screen.findByRole("option", { name: "New Reviewer" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Reason for transfer" }), { target: { value: "Next round coverage" } });
    await user.click(screen.getByRole("button", { name: "Confirm transfer" }));
    await screen.findByRole("region", { name: "Review responsibility history" });
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

  it("resets local review feedback when the same fixed version gains a replacement review issue", async () => {
    const version = versionFixture();
    server = workflowFixture({ current_version_id: version.id, versions: [version] });
    const { client } = setup();
    fireEvent.change(await screen.findByRole("textbox", { name: "Review feedback" }), { target: { value: "Draft for old responsibility" } });
    server = { ...server, revision: 3, versions: [{ ...version, review_issue: { ...version.review_issue, id: "replacement-review" } }] };
    await act(async () => { client.setQueryData(cockpitKeys.workflow("ws-1", WORKFLOW_MEETING_ID), server); });
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
    expect(await screen.findByText(/The reviewer for future submissions is no longer a workspace member/)).toHaveTextContent("Reassigning an issue does not transfer formal review authority");
    expect(screen.queryByRole("button", { name: "Transfer review responsibility" })).toBeNull();
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
