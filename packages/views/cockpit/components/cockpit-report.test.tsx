import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@multica/core/api";
import { I18nProvider } from "@multica/core/i18n/react";
import { cockpitKeys } from "@multica/core/cockpit";
import enCockpit from "../../locales/en/cockpit.json";
import { workOverview } from "./overview-test-fixtures";
import { CockpitReport, type CockpitReportProps } from "./cockpit-report";
vi.mock("@multica/core/api", () => ({ api: { getCockpitWorkOverview: vi.fn(), getCockpitPlan: vi.fn() } }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ cockpit: () => "/ws/cockpit", issueDetail: (id: string) => `/ws/issues/${id}` }) }));
vi.mock("../../navigation", () => ({ AppLink: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a> }));
function teamOverview() { const data = workOverview(); return { ...data, attention: { ...data.attention, view: "team", total: data.summary.attention.team_total } }; }
function setup(onPrint?: CockpitReportProps["onPrint"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props: CockpitReportProps = { wsId: "ws-1", scope: { projectId: null, moduleId: null }, asOf: "2026-10-10", returnHref: "/ws/cockpit?tab=meetings&from=2026-10-01&meeting=meeting-1", onPrint };
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}>{children}</I18nProvider></QueryClientProvider>;
  return { ...render(<CockpitReport {...props} />, { wrapper }), client, props };
}

beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.getCockpitWorkOverview).mockResolvedValue(teamOverview()); });
describe("read-only project report", () => {
  it("shows bounded real summaries and returns to the exact work URL without requesting financial plan data", async () => {
    const data = teamOverview(); Object.assign(data, { budget_amount: "private-budget", vendor: "private-vendor" }); Object.assign(data.attention.items[0]!, { description: "private-issue-body" }); vi.mocked(api.getCockpitWorkOverview).mockResolvedValue(data);
    setup(); expect(await screen.findByText("01.01.01 Release verification")).toBeVisible(); expect(screen.getByRole("link", { name: "Return to work" })).toHaveAttribute("href", "/ws/cockpit?tab=meetings&from=2026-10-01&meeting=meeting-1");
    expect(screen.getByText(enCockpit.report.basis)).toBeVisible(); expect(screen.getByText(/8 of 100 shown/)).toBeVisible(); expect(screen.queryByText(/private-budget|private-vendor|private-issue-body/)).toBeNull(); expect(api.getCockpitPlan).not.toHaveBeenCalled(); expect(screen.queryByRole("button", { name: "Print this report" })).toBeNull();
    expect(vi.mocked(api.getCockpitWorkOverview).mock.calls[0]?.[1]).toMatchObject({ attention_view: "team", as_of: "2026-10-10" });
  });
  it("holds the report during background invalidation and retains its original data when explicit refresh fails", async () => {
    const { client } = setup(); await screen.findByText("01.01.01 Release verification"); await act(async () => { await client.invalidateQueries({ queryKey: cockpitKeys.all("ws-1") }); }); expect(api.getCockpitWorkOverview).toHaveBeenCalledTimes(1);
    vi.mocked(api.getCockpitWorkOverview).mockRejectedValueOnce(new Error("offline")); await userEvent.click(screen.getByRole("button", { name: "Refresh report" })); expect(await screen.findByRole("alert")).toHaveTextContent(enCockpit.report.refresh_failed); expect(screen.getByText("01.01.01 Release verification")).toBeVisible(); expect(api.getCockpitWorkOverview).toHaveBeenCalledTimes(2);
  });
  it("exposes printing only through a provided capability and surfaces a real capability failure", async () => {
    const print = vi.fn<NonNullable<CockpitReportProps["onPrint"]>>().mockRejectedValue(new Error("Print capability unavailable")); setup(print); await screen.findByText("01.01.01 Release verification"); await userEvent.click(screen.getByRole("button", { name: "Print this report" }));
    await waitFor(() => expect(print).toHaveBeenCalledOnce()); expect(print.mock.calls[0]?.[0]).toBeInstanceOf(HTMLElement); expect(await screen.findByText("Print capability unavailable")).toBeVisible();
  });
});

  it("keeps the entered reference date through midnight and uses it again on explicit refresh", async () => {
    const view = setup(); await screen.findByText("01.01.01 Release verification"); view.rerender(<CockpitReport {...view.props} asOf="2026-10-11" />);
    expect(api.getCockpitWorkOverview).toHaveBeenCalledTimes(1); await userEvent.click(screen.getByRole("button", { name: "Refresh report" })); await waitFor(() => expect(api.getCockpitWorkOverview).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.getCockpitWorkOverview).mock.calls.map((call) => call[1].as_of)).toEqual(["2026-10-10", "2026-10-10"]);
  });
