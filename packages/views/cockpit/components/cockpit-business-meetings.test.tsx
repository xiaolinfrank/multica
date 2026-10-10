import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@multica/core/api";
import { I18nProvider } from "@multica/core/i18n/react";
import type { CockpitMeetingCard, CockpitMeetingRegisterQuery } from "@multica/core/types";
import enCockpit from "../../locales/en/cockpit.json";
import { CockpitBusinessMeetings } from "./cockpit-business-meetings";

vi.mock("@multica/core/api", () => ({ api: { getCockpitMeetingRegister: vi.fn(), getCockpit: vi.fn() } }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ cockpit: () => "/ws/cockpit" }) }));
vi.mock("../../navigation", () => ({ AppLink: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a> }));
const scope = { projectId: "project-1", moduleId: "module-1" };
function meeting(number: number, date = "2026-10-10"): CockpitMeetingCard {
  return { id: `meeting-${number}`, title: `Review ${number}`, meet_date: date, time_range: "", start_time: "09:00", end_time: "10:00", code: `M${number}`,
    kind: "", status: "", track: "", parties: "", organizer: "", location: "", attendees: "", meet_no: "", link: "", nas_dir: "", detected: false,
    issue_count: 0, node_count: 1, workflow_enabled: false, workflow_stage: "not_enabled", display_excerpt: "" };
}
function page(query: CockpitMeetingRegisterQuery, items: CockpitMeetingCard[], total: number, next: string | null = null, days = [{ date: "2026-10-10", total }]) {
  return { workspace_id: "ws-1", scope: { project_id: scope.projectId, module_id: scope.moduleId, project_title: "Project", module_title: "Module" }, node_id: null, node_ids: [],
    date_from: query.date_from ?? null, date_to: query.date_to ?? null, items, total, next_cursor: next, day_counts: days };
}
function setup() {
  const onOpenMeeting = vi.fn(), onCreate = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}>
    <CockpitBusinessMeetings wsId="ws-1" scope={scope} today="2026-10-10" onOpenMeeting={onOpenMeeting} onCreate={onCreate} />
  </I18nProvider></QueryClientProvider>);
  return { onOpenMeeting, onCreate };
}
beforeEach(() => vi.clearAllMocks());

describe("bounded business meeting card", () => {
  it("uses complete day counts, pages six cards, and keeps real register/edit/create destinations", async () => {
    vi.mocked(api.getCockpitMeetingRegister).mockImplementation(async (_ws, _scope, query) => query.page_size === 1
      ? page(query, [meeting(31)], 31)
      : page(query, Array.from({ length: query.cursor ? 1 : 6 }, (_, i) => meeting(query.cursor ? 7 : i + 1)), 31, query.cursor ? null : "more"));
    const { onOpenMeeting, onCreate } = setup();
    const region = await screen.findByRole("region", { name: "Business overview meetings" });
    expect(await within(region).findByText("This week · 31 meetings")).toBeVisible();
    expect(await within(region).findByRole("link", { name: "Review 6" })).toBeVisible();
    expect(within(region).queryByRole("link", { name: "Review 7" })).toBeNull();
    expect(api.getCockpit).not.toHaveBeenCalled();
    const calls = vi.mocked(api.getCockpitMeetingRegister).mock.calls;
    expect(calls[0]?.[2]).toMatchObject({ date_from: "2026-10-05", date_to: "2026-11-10", page_size: 1 });
    expect(calls[1]?.[2]).toMatchObject({ date_from: "2026-10-05", date_to: "2026-10-11", page_size: 6 });
    expect(screen.getByRole("link", { name: enCockpit.meetings.open_register })).toHaveAttribute("href", "/ws/cockpit?tab=meetings&project=project-1&module=module-1");
    expect(within(region).getAllByRole("link", { name: enCockpit.meeting.edit })[0]).toHaveAttribute("href", "/ws/cockpit?meeting=meeting-1&meeting_view=details&project=project-1&module=module-1");
    fireEvent.click(within(region).getByRole("link", { name: "Review 1" })); expect(onOpenMeeting).toHaveBeenCalledWith("meeting-1");
    fireEvent.click(screen.getByRole("button", { name: enCockpit.meeting.new })); expect(onCreate).toHaveBeenCalledOnce();
    fireEvent.click(within(region).getByRole("button", { name: "Next page" }));
    expect(await within(region).findByRole("link", { name: "Review 7" })).toBeVisible();
    expect(api.getCockpitMeetingRegister).toHaveBeenLastCalledWith("ws-1", scope, expect.objectContaining({ page_size: 6, cursor: "more" }), expect.anything());
  });

  it("finds the nearest future date from all day counts rather than the returned sample card", async () => {
    vi.mocked(api.getCockpitMeetingRegister).mockImplementation(async (_ws, _scope, query) => query.page_size === 1
      ? page(query, [meeting(99, "2026-11-09")], 2, null, [{ date: "2026-11-09", total: 1 }, { date: "2026-10-15", total: 1 }])
      : page(query, [meeting(1, "2026-10-15")], 1));
    setup();
    expect(await screen.findByText("Next up · 2026-10-15")).toBeVisible();
    expect(await screen.findByRole("link", { name: "Review 1" })).toBeVisible();
    expect(api.getCockpitMeetingRegister).toHaveBeenLastCalledWith("ws-1", scope, expect.objectContaining({ date_from: "2026-10-15", date_to: "2026-10-15", page_size: 6 }), expect.anything());
    expect(screen.queryByRole("link", { name: "Review 99" })).toBeNull();
  });

  it("keeps a failed continuation distinct from an empty week and offers a first-page recovery", async () => {
    vi.mocked(api.getCockpitMeetingRegister).mockImplementation(async (_ws, _scope, query) => {
      if (query.cursor) throw new Error("Expired cursor");
      return page(query, [meeting(1)], 9, query.page_size === 1 ? null : "more");
    });
    setup(); const region = await screen.findByRole("region", { name: "Business overview meetings" });
    await within(region).findByRole("link", { name: "Review 1" });
    fireEvent.click(within(region).getByRole("button", { name: "Next page" }));
    fireEvent.click(await within(region).findByRole("button", { name: "Return to first page" }));
    expect(await within(region).findByRole("link", { name: "Review 1" })).toBeVisible();
    await waitFor(() => expect(within(region).getByRole("button", { name: "Next page" })).toBeEnabled());
    expect(screen.queryByText(enCockpit.business_meetings.empty)).toBeNull();
  });
});
