import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
vi.mock("./cockpit-chat", () => ({ CockpitChat: ({ scope }: { scope: unknown }) => <section aria-label="Cockpit chat">{JSON.stringify(scope)}</section> }));
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
    route.params = new URLSearchParams("tab=work");
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

  it("keeps section links and plan views in separate named navigation landmarks with scoped destinations", () => {
    route.params = new URLSearchParams("tab=plan&plan_view=finance&project=p1&module=m1");
    setup();
    const sections = screen.getByRole("navigation", { name: enCockpit.shell.navigation });
    const views = screen.getByRole("navigation", { name: enCockpit.plan_views.navigation });
    expect(sections).not.toContainElement(views);
    expect(within(sections).getAllByRole("link")).toHaveLength(6);
    expect(within(views).getAllByRole("link")).toHaveLength(6);
    expect(within(sections).getByRole("link", { current: "page" })).toHaveAccessibleName("Execution plan");
    expect(within(views).getByRole("link", { current: "page" })).toHaveAccessibleName("Budget & payments");
    const gantt = within(views).getByRole("link", { name: "Gantt" });
    expect(gantt).toHaveAttribute("href", "/acme/cockpit?tab=plan&plan_view=gantt&project=p1&module=m1");
    gantt.focus();
    expect(gantt).toHaveFocus();
    expect(screen.getAllByRole("button", { name: "Project scope" })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: enCockpit.shell.workspace_view })).toBeVisible();
    expect(screen.getByRole("link", { name: enCockpit.report.title })).toHaveAttribute("href", "/acme/cockpit?tab=plan&plan_view=finance&project=p1&module=m1&report=1");
  });

  it("reveals current navigation destinations and keeps keyboard focus moving between links", async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
    try {
      route.params = new URLSearchParams("tab=governance&project=p1&module=m1");
      const { rerender } = setup();
      const sections = screen.getByRole("navigation", { name: enCockpit.shell.navigation });
      const governance = within(sections).getByRole("link", { current: "page" });
      expect(scrollIntoView.mock.contexts).toContain(governance);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
      const links = within(sections).getAllByRole("link");
      links[0]!.focus();
      await userEvent.setup().tab();
      expect(links[1]).toHaveFocus();

      scrollIntoView.mockClear();
      route.params = new URLSearchParams("tab=plan&plan_view=finance&project=p1&module=m1");
      rerender(<CockpitPage />);
      const plan = within(screen.getByRole("navigation", { name: enCockpit.shell.navigation })).getByRole("link", { current: "page" });
      const finance = within(screen.getByRole("navigation", { name: enCockpit.plan_views.navigation })).getByRole("link", { current: "page" });
      expect(scrollIntoView.mock.contexts).toContain(plan);
      expect(scrollIntoView.mock.contexts).toContain(finance);
      expect(finance).toHaveAttribute("href", "/acme/cockpit?tab=plan&plan_view=finance&project=p1&module=m1");
      expect(screen.getByRole("button", { name: enCockpit.saved_views.title })).toBeInTheDocument();
    } finally {
      scrollIntoView.mockRestore();
    }
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

 it("opens explicit Mika chat without downloading the board and keeps overview available", () => {
   route.params = new URLSearchParams("tab=chat&project=p1&module=m1"); setup();
   expect(screen.getByRole("region", { name: "Cockpit chat" })).toHaveTextContent('"projectId":"p1","moduleId":"m1"');
   expect(board).not.toHaveBeenCalled();
   expect(screen.getByRole("link", { name: "Chat" })).toHaveAttribute("aria-current", "page");
   expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("href", "/acme/cockpit?tab=work&project=p1&module=m1");
 });

 it("opens the bare cockpit at overview and keeps Chat first with an explicit destination", () => {
   route.params = new URLSearchParams("project=p1&module=m1"); setup();
   expect(screen.getByRole("region", { name: "Work overview" })).toBeVisible();
   expect(screen.queryByRole("region", { name: "Cockpit chat" })).toBeNull();
   expect(board).not.toHaveBeenCalled();
   const links = within(screen.getByRole("navigation", { name: enCockpit.shell.navigation })).getAllByRole("link");
   expect(links[0]).toHaveTextContent("Chat");
   expect(links[0]).toHaveAttribute("href", "/acme/cockpit?tab=chat&project=p1&module=m1");
   expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
 });
