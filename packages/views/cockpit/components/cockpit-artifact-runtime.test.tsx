import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@multica/core/api";
import { I18nProvider } from "@multica/core/i18n/react";
import { cockpitArtifactKeys, cockpitArtifactDraftKey, cockpitArtifactCommandDraftKey, prepareCockpitArtifactCommand, prepareCockpitArtifactSubmission, updateCockpitArtifactSubmissionDraft, useCockpitArtifactDraftStore, useCockpitArtifactCommandStore } from "@multica/core/cockpit";
import type { CockpitArtifactHeader, CockpitArtifactVersionDetail } from "@multica/core/types";
import { CockpitArtifactDetail } from "./cockpit-artifact-detail";
import { CockpitArtifactSubmitForm } from "./cockpit-artifact-submit";
import { CockpitArtifactReviewerTransfer } from "./cockpit-artifact-reviewer-transfer";
import { CockpitArtifactResponsibilities } from "./cockpit-artifact-responsibilities";
import { artifactFixture, artifactVersionDetailFixture, artifactVersionFixture } from "./artifact-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";

const navigation = vi.hoisted(() => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams("artifact=artifact-1&version=version-1"), push: vi.fn() }));
vi.mock("../../navigation", () => ({ useNavigation: () => navigation, AppLink: ({ children, href, newTabTitle: _newTabTitle, ...props }: React.ComponentProps<"a"> & { newTabTitle?: string }) => <a href={href} {...props}>{children}</a> }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ cockpit: () => "/ws/cockpit", issueDetail: (id: string) => `/ws/issues/${id}` }) }));
vi.mock("./cockpit-workflow-issue-link", () => ({ WorkflowIssueLink: ({ issue }: { issue: { title: string } }) => <p>{issue.title}</p> }));
vi.mock("./cockpit-reviewer-select", () => ({ CockpitReviewerSelect: ({ value, label, onChange, disabled }: { value: string; label: string; onChange: (id: string) => void; disabled: boolean }) => <label>{label}<select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}><option value="" /><option value="reviewer-2">Second reviewer</option></select></label> }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: {
  getCockpitInputManifestVersion: vi.fn(), getCockpitIssueInputManifest: vi.fn(), getCockpitContext: vi.fn(), getCockpitArtifact: vi.fn(), getCockpitArtifactVersion: vi.fn(), reviewCockpitArtifactVersion: vi.fn(), submitCockpitArtifactVersion: vi.fn(),
  searchCockpitScopeMembers: vi.fn(), reassignCockpitArtifactReviewer: vi.fn(),
  searchCockpitAssignees: vi.fn(), assignCockpitArtifactProducer: vi.fn(),
  getAttachment: vi.fn(), getCockpitArtifactSourceAttachments: vi.fn(),
} }));
let header: CockpitArtifactHeader; let detail: CockpitArtifactVersionDetail;
const scope = { projectId: "project-1", moduleId: "module-1" };
function shell(children: React.ReactNode, client: QueryClient) { return <QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}>{children}</I18nProvider></QueryClientProvider>; }
function client() { return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } }); }
beforeEach(() => {
  vi.clearAllMocks(); useCockpitArtifactDraftStore.getState().clearDraft(); useCockpitArtifactCommandStore.getState().clearDraft();
  navigation.searchParams = new URLSearchParams("artifact=artifact-1&version=version-1"); header = artifactFixture(); detail = artifactVersionDetailFixture();
  vi.mocked(api.getCockpitContext).mockResolvedValue({ workspace_id: "ws-1", scope: { project_id: "project-1", module_id: "module-1", project_title: "", module_title: "" }, cockpit: null,
    actor: { user_id: "author-1", role: "member", is_human: true }, has_meeting_workflows: false, has_stable_bindings: false, capabilities: { artifacts: true, acceptance: true, run_input_manifests: false } });
  vi.mocked(api.getCockpitArtifact).mockImplementation(async () => structuredClone(header));
  vi.mocked(api.getCockpitArtifactVersion).mockImplementation(async () => structuredClone(detail));
  vi.mocked(api.searchCockpitScopeMembers).mockResolvedValue({ workspace_id: "ws-1", scope: { q: "", ids: ["reviewer-2"] }, items: [{ id: "reviewer-2", title: "Second reviewer", email: "second@example.test", avatar_url: "", role: "member" }], total: 1, filtered_total: 1, next_cursor: null });
  vi.mocked(api.searchCockpitAssignees).mockResolvedValue({ workspace_id: "ws-1", q: "", kind: "all", selected_type: "member", selected_id: "author-1", items: [{ id: "author-1", type: "member", title: "Writer", email: "writer@example.test", avatar_url: "", status: "active", runtime_bound: null, can_assign: true, reason: "" }], total: 1, next_cursor: null });
  vi.mocked(api.getAttachment).mockRejectedValue(new Error("Original attachment unavailable"));
  vi.mocked(api.getCockpitArtifactSourceAttachments).mockResolvedValue({ workspace_id: "ws-1", artifact_id: "artifact-1", producer_issue_id: "source-1", q: "", items: [], total: 0, filtered_total: 0, next_cursor: null });
  vi.mocked(api.reviewCockpitArtifactVersion).mockImplementation(async (_ws, _artifactId, _versionId, body) => ({ workspace_id: "ws-1", artifact: header, version: { ...detail, feedback: body.feedback, version: { ...detail.version, decision: body.decision, revision: 2 } } }));
});

describe("artifact runtime workflow", () => {
  it.each([true, false])("confirms a human artifact submission only when its explicit cross-Issue manifest is acknowledged (matching: %s)", async (matching) => {
    const sourceIssue = "b6000000-0000-4000-8000-000000000001";
    const sourceManifest = "b6000000-0000-4000-8000-000000000002";
    const manifest = { workspaceId: "ws-1", issueId: sourceIssue, id: sourceManifest, versionNumber: 3, commandKey: sourceManifest, manifestHash: "a".repeat(64), itemTotal: 2, requiredTotal: 1, createdBy: "author-1", createdByName: "Author", createdAt: "2026-10-11T00:00:00Z", hasNote: false };
    vi.mocked(api.getCockpitInputManifestVersion).mockResolvedValue({ ...manifest, note: "" });
    vi.mocked(api.getCockpitIssueInputManifest).mockResolvedValue({ workspaceId: "ws-1", issue: { id: sourceIssue, identifier: "PMO-30", title: "Source research", status: "todo", statusCategory: "unstarted", priority: "none", assigneeType: null, assigneeId: null, assigneeName: "", dueDate: null, projectId: null, moduleId: null, primaryNodeId: null, primaryNodeCode: "", primaryNodeName: "", primaryRevision: 0, creationKey: null }, revision: 1, currentVersion: manifest, counts: { total: 2, required: 1, availableRequired: 1, unknownRequired: 0, unavailableRequired: 0 }, canEdit: true, blockedReasons: [] });
    header = { ...header, status: "draft", current_version: null, can_submit: true };
    const key = cockpitArtifactDraftKey("ws-1", "submit", "artifact-1");
    updateCockpitArtifactSubmissionDraft(key, { revision: header.revision, producerIssueId: header.producer_issue.id }, { text: "Human delivery", inputManifestIssueId: sourceIssue, inputManifestVersionId: sourceManifest });
    vi.mocked(api.submitCockpitArtifactVersion).mockImplementation(async (_ws, _artifact, body) => ({ workspace_id: "ws-1", artifact: header,
      version: { ...detail, content: "Human delivery", version: { ...detail.version, submission_key: body.submission_key, input_manifest_version_id: matching ? sourceManifest : null, input_manifest_issue_id: matching ? sourceIssue : null } } }));
    const cache = client(); const view = render(shell(<CockpitArtifactSubmitForm wsId="ws-1" artifact={header} scope={scope} disabled={false} />, cache));
    try {
      const submit = screen.getByRole("button", { name: enCockpit.artifacts.submit_version }); await waitFor(() => expect(submit).toBeEnabled()); fireEvent.click(submit);
      await waitFor(() => expect(api.submitCockpitArtifactVersion).toHaveBeenCalledTimes(1));
      const body = vi.mocked(api.submitCockpitArtifactVersion).mock.calls[0]![2]; expect(body.input_manifest_version_id).toBe(sourceManifest);
      if (matching) {
        await waitFor(() => expect(navigation.push).toHaveBeenCalledOnce());
        expect(useCockpitArtifactDraftStore.getState().draft.submissions[key]).toBeUndefined();
      } else {
        await screen.findByText(enCockpit.task_flow.unconfirmed);
        expect(useCockpitArtifactDraftStore.getState().draft.submissions[key]?.pending?.submission_key).toBe(body.submission_key);
        expect(navigation.push).not.toHaveBeenCalled();
      }
    } finally { view.unmount(); cache.clear(); }
  });

  it("keeps text submission and a production-issue recovery link when private file capture is unavailable", () => {
    header = { ...header, status: "draft", current_version: null, can_submit: true, file_capture_available: false, file_capture_unavailable_reason: "private_storage_required" };
    render(shell(<CockpitArtifactSubmitForm wsId="ws-1" artifact={header} scope={scope} disabled={false} />, client()));
    fireEvent.click(screen.getByRole("button", { name: "Submit a new version" }));
    expect(screen.getByRole("button", { name: "File" })).toBeDisabled(); expect(screen.getByText(enCockpit.artifact_runtime.private_storage_required)).toBeVisible();
    expect(screen.getByRole("link", { name: /Open production issue/ })).toHaveAttribute("href", "/ws/issues/source-1");
    fireEvent.change(screen.getByRole("textbox", { name: "Version text" }), { target: { value: "Fixed textual evidence" } });
    expect(screen.getByRole("button", { name: enCockpit.artifacts.submit_version })).toBeEnabled();
  });

  it("can confirm an original pending file submission after private-storage capability is withdrawn", async () => {
    const key = cockpitArtifactDraftKey("ws-1", "submit", "artifact-1"); const context = { revision: 2, producerIssueId: "source-1" };
    updateCockpitArtifactSubmissionDraft(key, context, { kind: "attachment", attachmentId: "original-file" });
    const body = prepareCockpitArtifactSubmission(key, context, "10000000-0000-4000-8000-000000000009");
    vi.mocked(api.submitCockpitArtifactVersion).mockRejectedValueOnce(new Error("Still unconfirmed"));
    header = { ...header, file_capture_available: false, file_capture_unavailable_reason: "private_storage_required", can_submit: false };
    render(shell(<CockpitArtifactSubmitForm wsId="ws-1" artifact={header} scope={scope} disabled={false} />, client()));
    const retry = screen.getByRole("button", { name: enCockpit.workflow.retry_submission }); expect(retry).toBeEnabled(); fireEvent.click(retry);
    await waitFor(() => expect(api.submitCockpitArtifactVersion).toHaveBeenCalledWith("ws-1", "artifact-1", body));
    expect(useCockpitArtifactDraftStore.getState().draft.submissions[key]?.pending).toEqual(body);
  });
  it("recovers the same atomic revision-issue command after reopening an archived artifact", async () => {
    vi.mocked(api.assignCockpitArtifactProducer).mockRejectedValueOnce(new Error("Connection lost"));
    const cache = client();
    const view = render(shell(<CockpitArtifactResponsibilities wsId="ws-1" artifact={header} scope={scope} currentUserId="author-1" disabled={false} />, cache));
    fireEvent.click(screen.getByRole("button", { name: "Change production issue" })); fireEvent.click(screen.getByRole("button", { name: "Create revision issue" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Issue title" }), { target: { value: "Revise interface evidence" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), { target: { value: "Separate the correction work" } });
    fireEvent.click(screen.getByRole("checkbox", { name: enCockpit.artifact_runtime.confirm_responsibility }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm transfer" })).toBeEnabled()); fireEvent.click(screen.getByRole("button", { name: "Confirm transfer" }));
    await screen.findByRole("button", { name: "Retry original command" });
    const original = vi.mocked(api.assignCockpitArtifactProducer).mock.calls[0]![2];
    expect(original).toMatchObject({ new_issue: { title: "Revise interface evidence", assignee_type: "member", assignee_id: "author-1" }, reason: "Separate the correction work" });
    view.unmount();
    render(shell(<CockpitArtifactResponsibilities wsId="ws-1" artifact={{ ...header, archived_at: "2026-10-11T02:00:00Z", can_assign_producer: false }} scope={scope} currentUserId="author-1" disabled={false} />, cache));
    fireEvent.click(screen.getByRole("button", { name: "Change production issue" }));
    expect(screen.getByRole("textbox", { name: "Issue title" })).toHaveValue("Revise interface evidence");
    expect(screen.getByRole("textbox", { name: "Issue title" })).toBeDisabled();
    const toIssue = { ...header.producer_issue, id: "new-issue", identifier: "PMO-20", title: "Revise interface evidence", status: "backlog" };
    vi.mocked(api.assignCockpitArtifactProducer).mockResolvedValueOnce({ workspace_id: "ws-1", artifact: { ...header, producer_issue: toIssue }, to_issue: toIssue,
      assignment: { id: "assignment-1", artifact_id: header.id, command_key: original.command_key, from_issue_id: header.producer_issue.id, to_issue_id: toIssue.id, reason: original.reason, created_by: "author-1", created_at: "2026-10-11T01:00:00Z", revision: original.expected_revision + 1 } });
    fireEvent.click(screen.getByRole("button", { name: "Retry original command" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(vi.mocked(api.assignCockpitArtifactProducer).mock.calls[1]![2]).toEqual(original);
  });
  it("restores a reopened pending handoff's fields after a definite refusal instead of losing the original intent", async () => {
    const key = cockpitArtifactCommandDraftKey("ws-1", "artifact_reviewer", "artifact-1");
    const body = { expected_revision: 2, handoff_key: "10000000-0000-4000-8000-000000000002", reviewer_id: "reviewer-2", reason: "Keep the original review coverage request" };
    prepareCockpitArtifactCommand(key, { kind: "artifact_reviewer", artifactId: "artifact-1", body });
    vi.mocked(api.reassignCockpitArtifactReviewer).mockRejectedValueOnce(new ApiError("Review changed", 409, "Conflict"));
    render(shell(<CockpitArtifactReviewerTransfer wsId="ws-1" target={{ kind: "artifact_reviewer", artifactId: "artifact-1" }} revision={3} signature="latest" reviewerId="reviewer-1" hint="Fixed context" canTransfer disabled={false} />, client()));
    fireEvent.click(screen.getByRole("button", { name: "Transfer review responsibility" }));
    expect(screen.getByRole("textbox", { name: "Reason" })).toHaveValue(body.reason);
    fireEvent.click(screen.getByRole("button", { name: "Retry original command" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Reason" })).toBeEnabled());
    expect(screen.getByRole("textbox", { name: "Reason" })).toHaveValue(body.reason);
    expect(screen.getByRole("combobox", { name: "New reviewer" })).toHaveValue("reviewer-2");
    expect(screen.getByText(enCockpit.artifact_runtime.command_changed)).toBeVisible();
    expect(screen.getByRole("button", { name: "Confirm transfer" })).toBeDisabled();
    expect(useCockpitArtifactCommandStore.getState().draft.pending[key]).toBeUndefined();
    expect(api.reassignCockpitArtifactReviewer).toHaveBeenCalledWith("ws-1", "artifact-1", body);
  });
  it("keeps the original source, current producer and immutable version producer distinct", async () => {
    header = { ...header, producer_issue: { ...header.producer_issue, id: "producer-2", identifier: "PMO-20", title: "New revision task" } };
    render(shell(<CockpitArtifactDetail wsId="ws-1" artifactId={header.id} versionId="version-1" scope={scope} currentUserId="reviewer-1" />, client()));
    expect(await screen.findByText(enCockpit.artifact_runtime.version_producer)).toBeVisible();
    expect(screen.getByRole("link", { name: /Original source: PMO-1/ })).toHaveAttribute("href", "/ws/issues/source-1");
    expect(screen.getByRole("link", { name: /PMO-20.*New revision task/ })).toHaveAttribute("href", "/ws/issues/producer-2");
    expect(screen.getByRole("link", { name: "PMO-1 · Prepare report" })).toHaveAttribute("href", "/ws/issues/source-1");
  });

  it("allows a reasoned return when fixed content is unavailable without enabling approval", async () => {
    detail = { ...detail, content_available: false, content_unavailable_reason: "Stored object unavailable", content: null };
    render(shell(<CockpitArtifactDetail wsId="ws-1" artifactId={header.id} versionId="version-1" scope={scope} currentUserId="reviewer-1" />, client()));
    const submit = await screen.findByRole("button", { name: "Submit review" }); expect(submit).toBeDisabled();
    expect(screen.getByText(enCockpit.artifact_runtime.content_missing)).toBeVisible();
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: enCockpit.workflow.decision })); await user.click(screen.getByRole("option", { name: "Changes requested" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: enCockpit.workflow.decision })).toHaveTextContent("Changes requested"));
    expect(submit).toBeDisabled(); fireEvent.change(screen.getByRole("textbox", { name: enCockpit.workflow.feedback }), { target: { value: "Please upload a verifiable replacement." } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Submit review" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Submit review" }));
    await waitFor(() => expect(api.reviewCockpitArtifactVersion).toHaveBeenCalledWith("ws-1", "artifact-1", "version-1", { expected_revision: 1, decision: "changes_requested", feedback: "Please upload a verifiable replacement." }));
  });

  it("pauses a stale same-version reader and preserves feedback when the header observes a newer responsibility revision", async () => {
    const cache = client(); render(shell(<CockpitArtifactDetail wsId="ws-1" artifactId={header.id} versionId="version-1" scope={scope} currentUserId="reviewer-1" />, cache));
    fireEvent.change(await screen.findByRole("textbox", { name: enCockpit.workflow.feedback }), { target: { value: "My reviewed observations" } });
    await act(async () => { cache.setQueryData(cockpitArtifactKeys.artifact("ws-1", "artifact-1"), { ...header, current_version: { ...header.current_version!, revision: 2 } }); });
    expect(await screen.findByText(enCockpit.artifact_runtime.version_changed)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Submit review" })).toBeNull();
    expect(screen.getByText("My reviewed observations")).toBeVisible(); expect(api.reviewCockpitArtifactVersion).not.toHaveBeenCalled();
  });

  it("requires an explicit producer rebase while retaining text and clearing a previous issue attachment", async () => {
    const key = cockpitArtifactDraftKey("ws-1", "submit", "artifact-1");
    updateCockpitArtifactSubmissionDraft(key, { revision: 2, producerIssueId: "source-1" }, { text: "Unsubmitted revision", attachmentId: "attachment-old" });
    header = { ...header, revision: 3, status: "approved", can_submit: true, current_version: artifactVersionFixture({ decision: "approved" }), producer_issue: { ...header.producer_issue, id: "producer-2" } };
    render(shell(<CockpitArtifactSubmitForm wsId="ws-1" artifact={header} scope={scope} disabled={false} />, client()));
    expect(screen.getByRole("textbox", { name: "Version text" })).toHaveValue("Unsubmitted revision");
    expect(screen.getByRole("button", { name: enCockpit.artifacts.submit_version })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: enCockpit.artifacts.rebase_draft }));
    expect(useCockpitArtifactDraftStore.getState().draft.submissions[key]).toMatchObject({ text: "Unsubmitted revision", attachmentId: "", producerIssueId: "producer-2", baseRevision: 3 });
    expect(screen.getByRole("button", { name: enCockpit.artifacts.submit_version })).toBeEnabled();
  });

  it("does not silently rebase an open reviewer handoff and retains the original key on an unknown response", async () => {
    const cache = client(); const target = { kind: "artifact_reviewer" as const, artifactId: "artifact-1" };
    const content = (revision: number) => shell(<CockpitArtifactReviewerTransfer wsId="ws-1" target={target} revision={revision} signature={`revision-${revision}`} reviewerId="reviewer-1" hint="Fixed content stays unchanged." canTransfer disabled={false} />, cache);
    const view = render(content(2)); fireEvent.click(screen.getByRole("button", { name: "Transfer review responsibility" }));
    fireEvent.change(screen.getByRole("combobox", { name: "New reviewer" }), { target: { value: "reviewer-2" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), { target: { value: "Review coverage" } });
    fireEvent.click(screen.getByRole("checkbox", { name: enCockpit.artifact_runtime.confirm_responsibility }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm transfer" })).toBeEnabled());
    view.rerender(content(3)); expect(screen.getByRole("button", { name: "Confirm transfer" })).toBeDisabled();
    expect(screen.getByText(enCockpit.artifact_runtime.command_changed)).toBeVisible(); expect(api.reassignCockpitArtifactReviewer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" })); fireEvent.click(screen.getByRole("button", { name: "Transfer review responsibility" }));
    fireEvent.click(screen.getByRole("checkbox", { name: enCockpit.artifact_runtime.confirm_responsibility }));
    vi.mocked(api.reassignCockpitArtifactReviewer).mockRejectedValue(new Error("Connection lost"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm transfer" }));
    const retry = await screen.findByRole("button", { name: "Retry original command" }); await waitFor(() => expect(retry).toBeEnabled());
    const original = vi.mocked(api.reassignCockpitArtifactReviewer).mock.calls[0]![2];
    view.rerender(content(4)); fireEvent.click(retry);
    await waitFor(() => expect(api.reassignCockpitArtifactReviewer).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.reassignCockpitArtifactReviewer).mock.calls[1]![2]).toEqual(original); expect(original.expected_revision).toBe(3);
  });
});
