import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@multica/core/api";
import { I18nProvider } from "@multica/core/i18n/react";
import { cockpitArtifactKeys, useCockpitArtifactDraftStore, useCockpitAcceptanceDraftStore } from "@multica/core/cockpit";
import type { CockpitAcceptanceHeader, CockpitAcceptanceRequestDetail } from "@multica/core/types";
import { CockpitAcceptance } from "./cockpit-acceptance";
import { acceptanceFixture } from "./artifact-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";

const navigation = vi.hoisted(() => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams("node=node-1&node_view=acceptance&acceptance=acceptance-1"), push: vi.fn() }));
vi.mock("../../navigation", () => ({ useNavigation: () => navigation, AppLink: ({ href, children, ...props }: React.ComponentProps<"a">) => <a href={href} {...props}>{children}</a> }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ cockpit: () => "/ws/cockpit", issueDetail: (id: string) => `/ws/issues/${id}` }) }));
vi.mock("./cockpit-workflow-issue-link", () => ({ WorkflowIssueLink: ({ issue }: { issue: { title: string } }) => <p>{issue.title}</p> }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: {
  getCockpitAcceptance: vi.fn(), getCockpitAcceptanceCriteria: vi.fn(), getCockpitAcceptanceRequest: vi.fn(), reviewCockpitAcceptanceRequest: vi.fn(),
} }));
let detail: CockpitAcceptanceRequestDetail; let header: CockpitAcceptanceHeader;
function setup() {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  render(<QueryClientProvider client={cache}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitAcceptance wsId="ws-1" nodeId="node-1" scope={{ projectId: "project-1", moduleId: "module-1" }} currentUserId="reviewer-1" /></I18nProvider></QueryClientProvider>);
  return cache;
}
beforeEach(() => {
  vi.clearAllMocks(); useCockpitArtifactDraftStore.getState().clearDraft(); useCockpitAcceptanceDraftStore.getState().clearDraft();
  detail = acceptanceFixture(); header = { workspace_id: "ws-1", node_id: "node-1", criteria_revision: 1, current_request: detail.request, last_approved_request: null,
    request_count: 1, can_edit_criteria: false, can_request: false, needs_reacceptance: false, can_reassign_reviewer: false };
  vi.mocked(api.getCockpitAcceptance).mockImplementation(async () => structuredClone(header));
  vi.mocked(api.getCockpitAcceptanceRequest).mockImplementation(async () => structuredClone(detail));
  vi.mocked(api.getCockpitAcceptanceCriteria).mockResolvedValue({ workspace_id: "ws-1", node_id: "node-1", revision: 1, items: detail.evidence.map((item) => item.criterion), max_items: 50, can_edit: false });
  vi.mocked(api.reviewCockpitAcceptanceRequest).mockImplementation(async (_ws, _nodeId, _requestId, body) => ({ ...detail, feedback: body.feedback, request: { ...detail.request, decision: body.decision, revision: 2 } }));
});

describe("acceptance decision availability", () => {
  it("keeps a pending review actionable for a reasoned rejection when evidence is unavailable and the issue is done", async () => {
    detail = { ...detail, evidence_available: false, evidence_unavailable_reason: "Fixed file unavailable", request: { ...detail.request, review_issue: { ...detail.request.review_issue, status: "done" } } };
    header.current_request = detail.request; setup();
    const submit = await screen.findByRole("button", { name: enCockpit.acceptance.submit_review }); expect(submit).toBeDisabled();
    expect(screen.getByText(enCockpit.artifact_runtime.evidence_missing)).toBeVisible();
    expect(screen.getByRole("button", { name: "Verify again" })).toBeEnabled();
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: enCockpit.workflow.decision })); await user.click(screen.getByRole("option", { name: "Rejected" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: enCockpit.workflow.decision })).toHaveTextContent("Rejected"));
    expect(submit).toBeDisabled(); fireEvent.change(screen.getByRole("textbox", { name: enCockpit.workflow.feedback }), { target: { value: "Replace the unavailable evidence." } });
    await waitFor(() => expect(screen.getByRole("button", { name: enCockpit.acceptance.submit_review })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: enCockpit.acceptance.submit_review }));
    await waitFor(() => expect(api.reviewCockpitAcceptanceRequest).toHaveBeenCalledWith("ws-1", "node-1", "acceptance-1", { expected_revision: 1, decision: "rejected", feedback: "Replace the unavailable evidence." }));
  });

  it("holds the fixed evidence and typed feedback when the current request pin advances before its detail", async () => {
    const cache = setup(); fireEvent.change(await screen.findByRole("textbox", { name: enCockpit.workflow.feedback }), { target: { value: "Retained acceptance notes" } });
    await act(async () => cache.setQueryData(cockpitArtifactKeys.acceptance("ws-1", "node-1"), { ...header, current_request: { ...header.current_request!, revision: 2 } }));
    expect(await screen.findByText(enCockpit.artifact_runtime.version_changed)).toBeVisible();
    expect(screen.queryByRole("button", { name: enCockpit.acceptance.submit_review })).toBeNull();
    expect(screen.getByText("Retained acceptance notes")).toBeVisible(); expect(within(screen.getByRole("region", { name: enCockpit.acceptance.packet })).getByText("Interface passes")).toBeVisible();
    expect(api.reviewCockpitAcceptanceRequest).not.toHaveBeenCalled();
  });
});
