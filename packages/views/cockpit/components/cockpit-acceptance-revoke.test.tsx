import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@multica/core/api";
import { I18nProvider } from "@multica/core/i18n/react";
import type { CockpitAcceptanceHeader, CockpitAcceptanceRequestMetadata } from "@multica/core/types";
import { CockpitAcceptance } from "./cockpit-acceptance";
import { acceptanceFixture } from "./artifact-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";

// The revoke keys land in the locale bundles in the same change that collects
// the R2 key list; until then the tests supply the copy so the component
// behavior stays asserted without editing locale files here.
const enCockpitRevoke = { ...enCockpit, acceptance: { ...enCockpit.acceptance,
  revoke_approval: "Revoke approval",
  revoke_hint: "Revoking returns this L3 to awaiting acceptance. The prior approval and its reason stay on record.",
  revoke_confirm: "Confirm revocation",
  revoke_reason_required: "A revocation reason of 1-16000 characters is required.",
  approval_revoked: "The approval was revoked; this L3 needs a fresh acceptance. Historical decisions are retained.",
} };

const navigation = vi.hoisted(() => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams("node=node-1&node_view=acceptance"), push: vi.fn() }));
vi.mock("../../navigation", () => ({ useNavigation: () => navigation, AppLink: ({ href, children, ...props }: React.ComponentProps<"a">) => <a href={href} {...props}>{children}</a> }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ cockpit: () => "/ws/cockpit", issueDetail: (id: string) => `/ws/issues/${id}` }) }));
vi.mock("./cockpit-workflow-issue-link", () => ({ WorkflowIssueLink: ({ issue }: { issue: { title: string } }) => <p>{issue.title}</p> }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: {
  getCockpitAcceptance: vi.fn(), getCockpitAcceptanceCriteria: vi.fn(), getCockpitAcceptanceRequest: vi.fn(), revokeCockpitAcceptanceApproval: vi.fn(),
} }));

let detail = acceptanceFixture();
let approved = approvedHeader();
function approvedMetadata(): CockpitAcceptanceRequestMetadata {
  return { ...detail.request, decision: "approved", reviewed_at: "2026-10-10T04:00:00Z", can_review: false };
}
function approvedHeader(manager = true): CockpitAcceptanceHeader {
  const request = approvedMetadata();
  return { workspace_id: "ws-1", node_id: "node-1", criteria_revision: 1, current_request: request, last_approved_request: request,
    request_count: 1, can_edit_criteria: manager, can_request: false, needs_reacceptance: false, can_reassign_reviewer: false };
}
function revokedHeader(): CockpitAcceptanceHeader {
  return { ...approvedHeader(), current_request: { ...approvedMetadata(), decision: "pending", reviewed_at: null, can_review: true }, last_approved_request: null, needs_reacceptance: true };
}
function setup() {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  render(<QueryClientProvider client={cache}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpitRevoke } }}><CockpitAcceptance wsId="ws-1" nodeId="node-1" scope={{ projectId: "project-1", moduleId: "module-1" }} currentUserId="manager-1" /></I18nProvider></QueryClientProvider>);
  return cache;
}
beforeEach(() => {
  vi.clearAllMocks(); detail = acceptanceFixture(); approved = approvedHeader();
  vi.mocked(api.getCockpitAcceptance).mockImplementation(async () => structuredClone(approved));
  vi.mocked(api.getCockpitAcceptanceCriteria).mockResolvedValue({ workspace_id: "ws-1", node_id: "node-1", revision: 1, items: detail.evidence.map((item) => item.criterion), max_items: 50, can_edit: true });
});

describe("acceptance approval revocation", () => {
  it("revokes the approval in force through a required-reason confirmation", async () => {
    let header = approved;
    vi.mocked(api.getCockpitAcceptance).mockImplementation(async () => structuredClone(header));
    vi.mocked(api.revokeCockpitAcceptanceApproval).mockImplementation(async () => {
      // Settle with the full post-revoke row instead of an optimistic patch.
      header = revokedHeader();
      return undefined;
    });
    setup();
    const card = await screen.findByRole("region", { name: enCockpit.acceptance.last_approved });
    const button = await within(card).findByRole("button", { name: enCockpitRevoke.acceptance.revoke_approval });
    const user = userEvent.setup();
    await user.click(button);
    const confirm = screen.getByRole("button", { name: enCockpitRevoke.acceptance.revoke_confirm });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: enCockpit.artifact_runtime.reason }), "Boundary audit narrowed the accepted scope");
    await waitFor(() => expect(confirm).toBeEnabled());
    await user.click(confirm);
    await waitFor(() => expect(api.revokeCockpitAcceptanceApproval).toHaveBeenCalledWith("ws-1", "node-1", "acceptance-1", "Boundary audit narrowed the accepted scope"));
    await waitFor(() => expect(screen.getByText(enCockpitRevoke.acceptance.approval_revoked)).toBeVisible());
    expect(screen.queryByRole("button", { name: enCockpitRevoke.acceptance.revoke_approval })).toBeNull();
  });

  it("keeps the dialog open with the reason when the revoke is rejected", async () => {
    setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: enCockpitRevoke.acceptance.revoke_approval }));
    await user.type(screen.getByRole("textbox", { name: enCockpit.artifact_runtime.reason }), "Retry this revocation");
    vi.mocked(api.revokeCockpitAcceptanceApproval).mockRejectedValueOnce(new ApiError("the request is not the acceptance approval currently in force", 409, "Conflict", { error: "conflict" }));
    await user.click(screen.getByRole("button", { name: enCockpitRevoke.acceptance.revoke_confirm }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("the request is not the acceptance approval currently in force"));
    expect(screen.getByRole("textbox", { name: enCockpit.artifact_runtime.reason })).toHaveValue("Retry this revocation");
  });

  it("presents a revoked approval as needing reacceptance without offering another revoke", async () => {
    vi.mocked(api.getCockpitAcceptance).mockImplementation(async () => structuredClone(revokedHeader()));
    setup();
    expect(await screen.findByText(enCockpitRevoke.acceptance.approval_revoked)).toBeVisible();
    expect(screen.queryByText(enCockpit.acceptance.changed_since_approval)).toBeNull();
    expect(screen.queryByRole("button", { name: enCockpitRevoke.acceptance.revoke_approval })).toBeNull();
    expect(api.revokeCockpitAcceptanceApproval).not.toHaveBeenCalled();
  });

  it("offers the revoke only to acceptance managers", async () => {
    vi.mocked(api.getCockpitAcceptance).mockImplementation(async () => structuredClone(approvedHeader(false)));
    setup();
    await screen.findByRole("region", { name: enCockpit.acceptance.last_approved });
    expect(screen.queryByRole("button", { name: enCockpitRevoke.acceptance.revoke_approval })).toBeNull();
    expect(api.revokeCockpitAcceptanceApproval).not.toHaveBeenCalled();
  });
});
