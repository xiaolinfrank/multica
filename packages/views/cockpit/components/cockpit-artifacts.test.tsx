import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@multica/core/api";
import { I18nProvider } from "@multica/core/i18n/react";
import { useCockpitScopeViewStore } from "@multica/core/cockpit";
import type { CockpitArtifactPage, CockpitArtifactQuery } from "@multica/core/types";
import enCockpit from "../../locales/en/cockpit.json";
import { artifactFixture, artifactVersionFixture } from "./artifact-test-fixtures";
import { CockpitArtifacts } from "./cockpit-artifacts";

vi.mock("@multica/core/api", () => ({ api: { getCockpitArtifacts: vi.fn() } }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ cockpit: () => "/ws/cockpit" }) }));
vi.mock("../../navigation", () => ({ AppLink: ({ children, newTabTitle: _newTabTitle, ...props }: React.ComponentProps<"a"> & { newTabTitle?: string }) => <a {...props}>{children}</a> }));
const scope = { projectId: "project-1", moduleId: "module-1" };
function page(query: CockpitArtifactQuery): CockpitArtifactPage {
  const referenced = query.relation === "referenced";
  return { workspace_id: "ws-1", scope: { project_id: scope.projectId, module_id: scope.moduleId, node_id: query.node_id ?? null, source_issue_id: null, ids: [], q: "", status: "", relation: query.relation ?? "all" },
    items: [artifactFixture({ id: query.cursor ? "artifact-2" : "artifact-1", title: referenced ? "Referenced report" : query.cursor ? "Next report" : "Delivery report", version_count: 2,
      current_version: artifactVersionFixture({ id: "version-2", version_number: 2 }), approved_version: artifactVersionFixture({ decision: "approved" }) })],
    total: 2, filtered_total: 2, next_cursor: query.cursor ? null : "next-artifact", can_create: false };
}
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitArtifacts wsId="ws-1" scope={scope} nodeId="node-1" /></I18nProvider></QueryClientProvider>);
}
beforeEach(() => {
  vi.clearAllMocks();
  useCockpitScopeViewStore.getState().reset();
  vi.mocked(api.getCockpitArtifacts).mockImplementation(async (_ws, query) => page(query ?? {}));
});

describe("artifact register identity and controls", () => {
  it("names the destination by its artifact while exposing ownership, source, status and approved version as its accessible description", async () => {
    setup();
    const link = await screen.findByRole("link", { name: "Delivery report" });
    expect(link).toHaveAccessibleDescription(/Interface delivery.*PMO-1.*Prepare report.*Pending review.*Approved v1.*2 versions/);
    expect(within(link).getByText("Approved v1")).toBeVisible();
    expect(within(link).getByText("2 versions")).toBeVisible();
    const url = new URL(link.getAttribute("href")!, "https://example.test");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ artifact: "artifact-1", project: "project-1", module: "module-1" });
    expect(api.getCockpitArtifacts).toHaveBeenCalledWith("ws-1", expect.objectContaining({ node_id: "node-1", relation: "owned", page_size: 25 }), expect.any(AbortSignal));
  });

  it("keeps relation selection accessible and resets pagination when the relationship changes", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByRole("link", { name: "Delivery report" });
    expect(screen.getByRole("button", { name: "Owned artifacts" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByRole("link", { name: "Next report" });
    expect(api.getCockpitArtifacts).toHaveBeenLastCalledWith("ws-1", expect.objectContaining({ cursor: "next-artifact", relation: "owned", page_size: 25 }), expect.any(AbortSignal));
    await user.click(screen.getByRole("button", { name: "Referenced artifacts" }));
    await screen.findByRole("link", { name: "Referenced report" });
    expect(screen.getByRole("button", { name: "Referenced artifacts" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Owned artifacts" })).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(api.getCockpitArtifacts).toHaveBeenLastCalledWith("ws-1", expect.objectContaining({ cursor: undefined, relation: "referenced", page_size: 25 }), expect.any(AbortSignal)));
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
  });
});
