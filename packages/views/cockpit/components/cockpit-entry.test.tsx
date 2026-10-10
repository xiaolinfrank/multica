import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@multica/core/api";
import { cockpitReadKeys, cockpitScope } from "@multica/core/cockpit";
import type { CockpitContextData } from "@multica/core/types";
import { I18nProvider } from "@multica/core/i18n/react";
import enCockpit from "../../locales/en/cockpit.json";
import { CockpitPage } from "./cockpit-entry";

const route = vi.hoisted(() => ({ params: new URLSearchParams(), wsId: "ws-1", artifactsAvailable: true, push: vi.fn() }));
const board = vi.hoisted(() => vi.fn());
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => route.wsId }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ cockpit: () => "/acme/cockpit" }) }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { getCockpitContext: vi.fn(), listCockpitChangePage: vi.fn().mockResolvedValue({ items: [], counts: { pending: 0, decided: 0 }, total: 0, next_cursor: null }) } }));
vi.mock("../../navigation", () => ({ useNavigation: () => ({ pathname: "/acme/cockpit", searchParams: route.params, push: route.push }),
  AppLink: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a> }));
vi.mock("./cockpit-scope-control", () => ({ CockpitScopeControl: () => <button>Project scope</button> }));
vi.mock("./cockpit-work-overview", () => ({ CockpitWorkOverview: ({ wsId, today }: { wsId: string; today: string }) => <section aria-label="Work overview"><span>{wsId}</span><time>{today}</time></section> }));
vi.mock("./cockpit-artifacts", () => ({ CockpitArtifacts: () => <section aria-label="Artifact list" /> }));
vi.mock("./cockpit-artifact-detail", () => ({ CockpitArtifactDetail: ({ artifactId, versionId }: { artifactId: string; versionId: string | null }) => <section aria-label="Artifact reader">{artifactId}:{versionId}</section> }));
vi.mock("./cockpit-report", () => ({ CockpitReport: ({ returnHref, scope }: { returnHref: string; scope: { projectId: string | null; moduleId: string | null } }) => <section aria-label="Report"><a href={returnHref}>Back to work</a><span>{JSON.stringify(scope)}</span></section> }));
vi.mock("./cockpit-page", () => ({ CockpitBoardWorkspace: (props: { initialTab: string; today: string }) => {
  board(props); return <section aria-label="Board workspace"><span>{props.initialTab}</span><time>{props.today}</time></section>;
} }));

function context(): CockpitContextData {
  return { workspace_id: route.wsId, scope: { project_id: route.params.get("project"), module_id: route.params.get("module"), project_title: "Project", module_title: "Module" },
    cockpit: null, actor: { user_id: "person", role: "member", is_human: true }, has_meeting_workflows: false, has_stable_bindings: false,
    capabilities: { artifacts: route.artifactsAvailable, acceptance: false } };
}
function setup(prefill = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  if (prefill) client.setQueryData(cockpitReadKeys.context(route.wsId, cockpitScope(route.params)), context());
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}>{children}</I18nProvider></QueryClientProvider>;
  return { ...render(<CockpitPage />, { wrapper }), client };
}
beforeEach(() => { route.params = new URLSearchParams(); route.wsId = "ws-1"; route.artifactsAvailable = true; route.push.mockReset(); board.mockClear(); vi.mocked(api.getCockpitContext).mockImplementation(async () => context()); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("unified cockpit shell", () => {
  it("opens the report without other surfaces and retains the complete return destination", () => {
    route.params = new URLSearchParams("tab=meetings&meeting=m1&meeting_view=materials&project=p1&module=m2&report=1");
    setup();
    expect(screen.getByRole("region", { name: "Report" })).toHaveTextContent('"projectId":"p1","moduleId":"m2"');
    expect(screen.getByRole("link", { name: "Back to work" })).toHaveAttribute("href", "/acme/cockpit?tab=meetings&meeting=m1&meeting_view=materials&project=p1&module=m2");
    expect(screen.queryByRole("navigation", { name: "Cockpit sections" })).not.toBeInTheDocument();
    expect(board).not.toHaveBeenCalled();
  });
  it("mounts the bounded work overview and available destinations without mounting the complete board", () => {
    setup();
    expect(screen.getByRole("region", { name: "Work overview" })).toBeInTheDocument();
    expect(board).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Execution plan" })).toHaveAttribute("href", "/acme/cockpit?tab=plan");
    expect(screen.getByRole("link", { name: "Meetings" })).toHaveAttribute("href", "/acme/cockpit?tab=meetings");
    expect(screen.getByRole("link", { name: "Artifacts" })).toHaveAttribute("href", "/acme/cockpit?tab=artifacts");
    expect(screen.getByRole("link", { name: "Governance" })).toHaveAttribute("href", "/acme/cockpit?tab=governance");
  });

  it("keeps unavailable services out of navigation and explains an old deep link without issuing their reads", () => {
    route.artifactsAvailable = false;
    route.params = new URLSearchParams("tab=artifacts&artifact=a1");
    setup();
    expect(screen.queryByRole("link", { name: "Artifacts" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Artifact reader" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(enCockpit.feature_availability.unavailable);
    expect(screen.getAllByRole("link", { name: "Execution plan" })).toHaveLength(2);
    expect(board).not.toHaveBeenCalled();
  });

  it("keeps project/module scope across tabs and exposes all original business and finance views", () => {
    route.params = new URLSearchParams("tab=plan&plan_view=finance&project=p1&module=m1");
    setup();
    expect(screen.getByRole("region", { name: "Board workspace" })).toHaveTextContent("finance");
    expect(screen.getByRole("link", { name: "Meetings" })).toHaveAttribute("href", "/acme/cockpit?tab=meetings&project=p1&module=m1");
    expect(screen.getByRole("link", { name: "Business overview" })).toHaveAttribute("href", "/acme/cockpit?tab=plan&plan_view=operations&project=p1&module=m1");
    expect(screen.getByRole("link", { name: "Budget & payments" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Plan table" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Responsibilities" })).toBeVisible();
  });

  it("opens fixed artifact versions without mounting another surface or guessing its body", () => {
    route.params = new URLSearchParams("tab=artifacts&artifact=a1&artifact_version=v1");
    setup(); expect(screen.getByRole("region", { name: "Artifact reader" })).toHaveTextContent("a1:v1");
    expect(board).not.toHaveBeenCalled();
  });

  it("keeps invalid scopes visible and leaves a real route to recover instead of mounting an unfiltered board", async () => {
    route.params = new URLSearchParams("tab=plan&project=deleted&module=foreign");
    vi.mocked(api.getCockpitContext).mockRejectedValue(new Error("scope unavailable"));
    setup(false);
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a valid scope");
    expect(screen.getByRole("button", { name: "Project scope" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Show all projects" })).toHaveAttribute("href", "/acme/cockpit?tab=plan");
    expect(board).not.toHaveBeenCalled();
    await waitFor(() => expect(vi.mocked(api.getCockpitContext).mock.lastCall?.[1]).toEqual({ projectId: "deleted", moduleId: "foreign" }));
  });

  it("preserves existing object deep links and updates the calendar day across midnight", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 10, 23, 59, 30));
    route.params = new URLSearchParams("meeting=m1&action=a1");
    setup(); expect(board.mock.lastCall?.[0]).toMatchObject({ initialTab: "meetings" });
    expect(screen.getByText("2026-10-10")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText("2026-10-11")).toBeInTheDocument();
  });
});
