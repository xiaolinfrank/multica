import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@multica/core/api";
import { I18nProvider } from "@multica/core/i18n/react";
import { cockpitAcceptanceDraftKey, cockpitArtifactsOptions, updateCockpitAcceptanceRequestDraft, useCockpitAcceptanceDraftStore } from "@multica/core/cockpit";
import { acceptanceFixture, artifactFixture, artifactVersionFixture } from "./artifact-test-fixtures";
import type { CockpitAcceptanceHeader, CockpitAcceptanceCriteriaView, CockpitAcceptanceRequestDetail } from "@multica/core/types";
import enCockpit from "../../locales/en/cockpit.json";
import { CockpitAcceptanceRequestForm } from "./cockpit-acceptance-request";

const navigation = vi.hoisted(() => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams("node=node-1&node_view=acceptance"), push: vi.fn() }));
vi.mock("../../navigation", () => ({ useNavigation: () => navigation,
  AppLink: ({ href, children, ...rest }: React.ComponentProps<"a">) => <a href={href} {...rest}>{children}</a> }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ cockpit: () => "/ws/cockpit" }) }));
vi.mock("./cockpit-reviewer-select", () => ({ CockpitReviewerSelect: ({ value, onChange, disabled }: { value: string; onChange: (id: string) => void; disabled: boolean }) =>
  <label>Reviewer<select aria-label="Reviewer" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}><option value="" /><option value="reviewer-1">Reviewer</option></select></label> }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: {
  getCockpitArtifacts: vi.fn(), getCockpitArtifact: vi.fn(), getCockpitArtifactVersion: vi.fn(), searchCockpitScopeMembers: vi.fn(),
  getCockpitAcceptanceRequest: vi.fn(), createCockpitAcceptanceRequest: vi.fn(),
} }));
const scope = { projectId: "project-1", moduleId: "module-1" };
const version = artifactVersionFixture({ decision: "approved", reviewed_at: "2026-10-10T02:00:00Z" });
const artifact = artifactFixture({ approved_version: version, evidence_version: version, current_version: artifactVersionFixture({ id: "version-2", version_number: 2 }), version_count: 2 });
function header(over: Partial<CockpitAcceptanceHeader> = {}): CockpitAcceptanceHeader {
  return { workspace_id: "ws-1", node_id: "node-1", criteria_revision: 1, current_request: null, last_approved_request: null, request_count: 0,
    can_edit_criteria: true, can_reassign_reviewer: true, can_request: true, needs_reacceptance: false, ...over };
}
function definition(over: Partial<CockpitAcceptanceCriteriaView> = {}): CockpitAcceptanceCriteriaView {
  return { workspace_id: "ws-1", node_id: "node-1", revision: 1, items: acceptanceFixture().evidence.map((item) => item.criterion), max_items: 50, can_edit: true, ...over };
}
function seed() {
  updateCockpitAcceptanceRequestDraft(cockpitAcceptanceDraftKey("ws-1", "node-1"), 1,
    { reviewerId: "reviewer-1", note: "Fixed review note", evidence: { "criterion-1": [{ artifactId: "artifact-1", versionId: "version-1" }] } });
}
function setup(initialHeader = header(), initialDefinition = definition()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const contents = (head: CockpitAcceptanceHeader, def: CockpitAcceptanceCriteriaView) => <QueryClientProvider client={client}>
    <I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitAcceptanceRequestForm wsId="ws-1" header={head} definition={def} scope={scope} currentUserId="author-1" disabled={false} /></I18nProvider>
  </QueryClientProvider>;
  const rendered = render(contents(initialHeader, initialDefinition));
  return { ...rendered, client, replace: (head: CockpitAcceptanceHeader, def: CockpitAcceptanceCriteriaView) => rendered.rerender(contents(head, def)) };
}
beforeEach(() => {
  vi.clearAllMocks(); useCockpitAcceptanceDraftStore.getState().clearDraft(); navigation.searchParams = new URLSearchParams("node=node-1&node_view=acceptance");
  vi.mocked(api.getCockpitArtifact).mockResolvedValue(artifact);
  vi.mocked(api.getCockpitArtifacts).mockImplementation(async (_ws, query) => ({ workspace_id: "ws-1", scope: { project_id: null, module_id: null, node_id: query?.node_id ?? null, source_issue_id: null, q: "", status: "", relation: query?.relation ?? "owned", ids: query?.ids ?? [] }, items: [artifact], total: 1, filtered_total: 1, next_cursor: null, can_create: true }));
  vi.mocked(api.searchCockpitScopeMembers).mockResolvedValue({ workspace_id: "ws-1", scope: { q: "", ids: ["reviewer-1"] },
    items: [{ id: "reviewer-1", title: "Reviewer", email: "reviewer@example.test", avatar_url: "", role: "member" }], total: 1, filtered_total: 1, next_cursor: null });
  vi.mocked(api.getCockpitAcceptanceRequest).mockResolvedValue(acceptanceFixture());
  vi.mocked(api.createCockpitAcceptanceRequest).mockImplementation(async (_ws, nodeId, body) => {
    const receipt = acceptanceFixture();
    return { ...receipt, node_id: nodeId, note: body.note, request: { ...receipt.request, node_id: nodeId, request_key: body.request_key,
      reviewer_id: body.reviewer_id, criteria_revision: body.expected_criteria_revision, supersedes_request_id: body.supersedes_request_id ?? null } };
  });
});

describe("acceptance request evidence and recovery", () => {
  it("points empty definitions to criteria editing while preserving an existing draft entry", () => {
    const view = setup(header(), definition({ items: [] }));
    expect(screen.getByRole("button", { name: "Request acceptance" })).toBeDisabled();
    expect(screen.getByText(enCockpit.acceptance_request.edit_criteria_first)).toBeVisible();
    act(() => seed());
    view.replace(header(), definition({ items: [] }));
    fireEvent.click(screen.getByRole("button", { name: "Request acceptance" }));
    expect(screen.getByRole("textbox", { name: "Request note" })).toHaveValue("Fixed review note");
    expect(screen.getByRole("button", { name: "Send acceptance request" })).toBeDisabled();
    expect(api.createCockpitAcceptanceRequest).not.toHaveBeenCalled();
  });

  it("keeps an unknown formal state read-only even when the server advertises can_request", async () => {
    seed(); setup(header({ current_request: { ...acceptanceFixture().request, decision: "future-decision" }, can_request: true }));
    fireEvent.click(screen.getByRole("button", { name: "Request acceptance" }));
    expect(await screen.findByText(enCockpit.acceptance_request.unknown_state)).toBeVisible();
    expect(screen.getByRole("button", { name: "Send acceptance request" })).toBeDisabled();
    expect(api.createCockpitAcceptanceRequest).not.toHaveBeenCalled();
  });

  it("pages candidate headers without body prefetch and allows approved v1 while v2 is pending", async () => {
    const first = Array.from({ length: 25 }, (_, i) => artifactFixture({ id: `draft-${i}`, title: `Draft ${i}` }));
    vi.mocked(api.getCockpitArtifacts).mockImplementation(async (_ws, query) => ({ workspace_id: "ws-1", scope: { project_id: null, module_id: null, node_id: query?.node_id ?? null, source_issue_id: null, q: "", status: "", relation: query?.relation ?? "owned", ids: query?.ids ?? [] },
      items: query?.ids?.length || query?.cursor ? [artifact] : first, total: 26, filtered_total: query?.ids?.length ? 1 : 26, next_cursor: query?.ids?.length || query?.cursor ? null : "page-2", can_create: true }));
    setup(); fireEvent.click(screen.getByRole("button", { name: "Request acceptance" }));
    expect(api.getCockpitArtifacts).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("combobox", { name: "Reviewer" }), { target: { value: "reviewer-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Choose evidence for Interface passes" }));
    expect(await screen.findByRole("button", { name: "Draft 0" })).toBeDisabled();
    expect(api.getCockpitArtifact).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    fireEvent.click(await screen.findByRole("button", { name: /Delivery report.*Version 1/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send acceptance request" })).toBeEnabled());
    expect(api.getCockpitArtifacts).toHaveBeenCalledWith("ws-1", expect.objectContaining({ node_id: "node-1", relation: "all", page_size: 25, cursor: "page-2" }), expect.anything());
    expect(vi.mocked(api.getCockpitArtifacts).mock.calls[0]?.[1]?.status).toBeUndefined();
    expect(api.getCockpitArtifactVersion).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send acceptance request" }));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith(expect.stringContaining("acceptance=acceptance-1")));
    expect(api.createCockpitAcceptanceRequest).toHaveBeenCalledWith("ws-1", "node-1", expect.objectContaining({ evidence: [{ criterion_id: "criterion-1", version_ids: ["version-1"] }] }));
  });

  it("keeps the exact request after an unknown network result and does not navigate a later page on receipt", async () => {
    seed(); const view = setup();
    vi.mocked(api.createCockpitAcceptanceRequest).mockRejectedValueOnce(new Error("Connection lost"));
    fireEvent.click(screen.getByRole("button", { name: "Request acceptance" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send acceptance request" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Send acceptance request" }));
    const retry = await screen.findByRole("button", { name: "Retry the same request" });
    await waitFor(() => expect(retry).toBeEnabled());
    const first = vi.mocked(api.createCockpitAcceptanceRequest).mock.calls[0]![2];
    expect(screen.getByRole("textbox", { name: "Request note" })).toBeDisabled();
    let accept!: (value: CockpitAcceptanceRequestDetail) => void;
    vi.mocked(api.createCockpitAcceptanceRequest).mockImplementationOnce(() => new Promise((resolve) => { accept = resolve; }));
    fireEvent.click(retry);
    await waitFor(() => expect(api.createCockpitAcceptanceRequest).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.createCockpitAcceptanceRequest).mock.calls[1]![2]).toEqual(first);
    navigation.searchParams = new URLSearchParams("node=node-2&node_view=acceptance");
    updateCockpitAcceptanceRequestDraft(cockpitAcceptanceDraftKey("ws-1", "node-2"), 1, { note: "Another page draft" });
    view.replace(header({ node_id: "node-2" }), definition({ node_id: "node-2" }));
    const receipt = acceptanceFixture();
    await act(async () => accept({ ...receipt, note: first.note, request: { ...receipt.request, request_key: first.request_key } }));
    await waitFor(() => expect(useCockpitAcceptanceDraftStore.getState().draft.requests[cockpitAcceptanceDraftKey("ws-1", "node-1")]).toBeUndefined());
    expect(navigation.push).not.toHaveBeenCalled();
    expect(useCockpitAcceptanceDraftStore.getState().draft.requests[cockpitAcceptanceDraftKey("ws-1", "node-2")]?.note).toBe("Another page draft");
  });

  it("requires an explicit criteria rebase and never replaces an outdated evidence selection", async () => {
    seed(); const view = setup(header({ criteria_revision: 2 }), definition({ revision: 2 }));
    fireEvent.click(screen.getByRole("button", { name: "Request acceptance" }));
    expect(await screen.findByText(enCockpit.acceptance_request.criteria_changed)).toBeVisible();
    expect(screen.getByRole("button", { name: "Send acceptance request" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: enCockpit.acceptance_request.rebase }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send acceptance request" })).toBeEnabled());
    await act(async () => view.client.setQueryData(cockpitArtifactsOptions("ws-1", { node_id: "node-1", relation: "all", ids: ["artifact-1"], page_size: 100 }).queryKey,
      { workspace_id: "ws-1", scope: { project_id: null, module_id: null, node_id: "node-1", source_issue_id: null, q: "", status: "", relation: "all", ids: ["artifact-1"] }, items: [{ ...artifact, evidence_version: null, approved_version: { ...version, id: "version-3", version_number: 3 } }], total: 1, filtered_total: 1, next_cursor: null, can_create: true }));
    expect(await screen.findByText(enCockpit.acceptance_request.evidence_changed)).toBeVisible();
    expect(screen.getByRole("button", { name: "Send acceptance request" })).toBeDisabled();
    expect(useCockpitAcceptanceDraftStore.getState().draft.requests[cockpitAcceptanceDraftKey("ws-1", "node-1")]?.evidence["criterion-1"]?.[0]?.versionId).toBe("version-1");
  });

  it("does not replace an active human review when its issue is done, and requires consent for a stale replacement", async () => {
    seed(); const request = acceptanceFixture().request;
    const pending = { ...request, review_issue: { ...request.review_issue, status: "done" } };
    const view = setup(header({ current_request: pending }));
    fireEvent.click(screen.getByRole("button", { name: "Request acceptance" }));
    expect(await screen.findByText(enCockpit.acceptance_request.review_in_progress)).toBeVisible();
    expect(screen.getByRole("link", { name: "Open current acceptance request" })).toHaveAttribute("href", expect.stringContaining("acceptance=acceptance-1"));
    expect(screen.getByRole("button", { name: "Send acceptance request" })).toBeDisabled();
    view.replace(header({ current_request: pending, criteria_revision: 2 }), definition({ revision: 2 }));
    fireEvent.click(screen.getByRole("button", { name: enCockpit.acceptance_request.rebase }));
    expect(screen.getByRole("button", { name: "Send acceptance request" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: enCockpit.acceptance_request.replace_stale }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send acceptance request" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Send acceptance request" }));
    await waitFor(() => expect(api.createCockpitAcceptanceRequest).toHaveBeenCalledWith("ws-1", "node-1", expect.objectContaining({ supersedes_request_id: pending.id, expected_criteria_revision: 2 })));
  });
});
