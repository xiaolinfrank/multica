// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@multica/core/api";
import type { CockpitIssueArtifactContext, CockpitIssueArtifactContextPage } from "@multica/core/types";
import { WorkspaceSlugProvider } from "@multica/core/paths";
import { NavigationProvider } from "../../navigation";
import type { NavigationAdapter } from "../../navigation/types";
import { renderWithI18n } from "../../test/i18n";
import { CockpitArtifactContexts } from "./cockpit-artifact-contexts";

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/api", () => ({ api: { getCockpitContext: vi.fn(), getCockpitIssueArtifacts: vi.fn() } }));
const adapter: NavigationAdapter = { push: vi.fn(), replace: vi.fn(), back: vi.fn(), pathname: "/", searchParams: new URLSearchParams(), hash: "", getShareableUrl: (path) => path };
const row: CockpitIssueArtifactContext = { kind: "artifact_version", id: "version-1", roles: ["version_producer", "retired_review"], artifact_id: "artifact-1", artifact_title: "Delivery report", version_id: "version-1", version_number: 1,
  node_id: "node-1", node_label: "Interface delivery", request_id: null, decision: "approved", reviewer_id: "reviewer-1", is_current_review: false };
const context = { workspace_id: "ws-1", scope: { project_id: null, module_id: null, project_title: "", module_title: "" }, cockpit: null,
  actor: { user_id: "member-1", role: "member", is_human: true }, has_meeting_workflows: true, has_stable_bindings: true, capabilities: { artifacts: true, acceptance: true } };
let page: CockpitIssueArtifactContextPage;
function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(<QueryClientProvider client={client}><WorkspaceSlugProvider slug="acme"><NavigationProvider value={adapter}><CockpitArtifactContexts issueId="issue-1" /></NavigationProvider></WorkspaceSlugProvider></QueryClientProvider>);
}
beforeEach(() => {
  vi.clearAllMocks();
  page = { workspace_id: "ws-1", issue_id: "issue-1", formal_review: null, items: [row], total: 1, next_cursor: null };
  vi.mocked(api.getCockpitContext).mockResolvedValue(context);
  vi.mocked(api.getCockpitIssueArtifacts).mockImplementation(async () => structuredClone(page));
});
afterEach(cleanup);

it("opens the exact historical version through shared navigation without offering a fake unlink", async () => {
  renderSection();
  const link = await screen.findByRole("link", { name: "Delivery report · Version v1" });
  expect(link).toHaveAttribute("href", "/acme/cockpit?tab=artifacts&artifact=artifact-1&artifact_version=version-1");
  expect(screen.getByText("Version producer · Historical review")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /unlink|approve|remove/i })).toBeNull();
  fireEvent.click(link);
  expect(adapter.push).toHaveBeenCalledWith("/acme/cockpit?tab=artifacts&artifact=artifact-1&artifact_version=version-1");
});

it("pages long histories and targets the precise acceptance request", async () => {
  page.total = 260; page.next_cursor = "next-page";
  vi.mocked(api.getCockpitIssueArtifacts).mockImplementation(async (_ws, _id, query) => query?.cursor ? { ...page, next_cursor: null, items: [{ ...row, kind: "acceptance_request", id: "request-1", artifact_id: null, artifact_title: "", version_id: null, version_number: null, request_id: "request-1", roles: ["acceptance_review"], is_current_review: true }] } : structuredClone(page));
  renderSection();
  await screen.findByRole("link", { name: "Delivery report · Version v1" });
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  const link = await screen.findByRole("link", { name: "Interface delivery · L3 acceptance" });
  expect(link).toHaveAttribute("href", "/acme/cockpit?node=node-1&node_view=acceptance&acceptance=request-1");
  expect(api.getCockpitIssueArtifacts).toHaveBeenLastCalledWith("ws-1", "issue-1", { cursor: "next-page", page_size: 25 }, expect.any(AbortSignal));
  expect(screen.getByText("Current review task")).toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "Artifacts & acceptance" })).queryByRole("button", { name: /approve/i })).toBeNull();
});

it("recovers a failed relation read without showing a false empty result", async () => {
  vi.mocked(api.getCockpitIssueArtifacts).mockRejectedValueOnce(new Error("offline"));
  renderSection();
  await screen.findByRole("alert");
  expect(screen.queryByText("No artifact or acceptance records.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("link", { name: "Delivery report · Version v1" });
});

it("does not query unavailable server capabilities or invent targets for future context kinds", async () => {
  vi.mocked(api.getCockpitContext).mockResolvedValue({ ...context, capabilities: { artifacts: false, acceptance: false } });
  const rendered = renderSection();
  await waitFor(() => expect(api.getCockpitContext).toHaveBeenCalled());
  expect(api.getCockpitIssueArtifacts).not.toHaveBeenCalled();
  rendered.unmount();
  vi.mocked(api.getCockpitContext).mockResolvedValue(context);
  page.items = [{ ...row, kind: "future-kind", roles: ["future-role"] }];
  renderSection();
  expect(await screen.findByText("Other: future-role")).toBeInTheDocument();
  expect(screen.queryByRole("link")).toBeNull();
});
