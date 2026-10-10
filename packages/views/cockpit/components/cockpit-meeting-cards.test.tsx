import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { CockpitMeetingSchema } from "@multica/core/api/schemas";
import type { CockpitMeetingCard } from "@multica/core/types";
import { CockpitMeetingCards } from "./cockpit-meeting-cards";
import enCockpit from "../../locales/en/cockpit.json";
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ cockpit: () => "/ws/cockpit" }) }));
vi.mock("../../navigation", () => ({ useNavigation: () => ({ searchParams: new URLSearchParams("from=2026-10-01&to=2026-10-31") }), AppLink: ({ children, newTabTitle: _newTabTitle, ...props }: React.ComponentProps<"a"> & { newTabTitle?: string }) => <a {...props}>{children}</a> }));
const meeting = (patch: Partial<CockpitMeetingCard>): CockpitMeetingCard => ({ ...CockpitMeetingSchema.parse({ id: "meeting-1", title: "Delivery review", status: "Ended", meet_date: "2020-01-01" }), issue_count: 0, node_count: 0, workflow_enabled: false, workflow_stage: "not_enabled", display_excerpt: "", ...patch });
it("separates a custom ended note from authoritative unconfirmed occurrence and links directly to the confirmation workbench", () => {
  render(<I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitMeetingCards scope={{ projectId: "project-1", moduleId: null }} selectedId={null} items={[meeting({ occurrence_state: "unconfirmed" }), meeting({ id: "old-meeting", title: "Older server record", occurrence_state: undefined })]} /></I18nProvider>);
  const rows = screen.getAllByRole("listitem"); const first = within(rows[0]!); expect(first.getByText("Custom note: Ended")).toBeVisible();
  const target = first.getByRole("link", { name: "Record meeting occurrence · Not confirmed" }); const url = new URL(target.getAttribute("href")!, "https://example.test");
  expect(Object.fromEntries(url.searchParams)).toMatchObject({ meeting: "meeting-1", meeting_view: "agenda", project: "project-1", from: "2026-10-01", to: "2026-10-31" });
  expect(within(rows[1]!).queryByRole("link", { name: /Record meeting occurrence/ })).toBeNull(); expect(within(rows[1]!).getByText("Ended")).toBeVisible();
});

describe("future meeting occurrence states", () => {
  it("keeps an unrecognized state visible without inventing an ended or started fact", () => {
    render(<I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitMeetingCards scope={{ projectId: null, moduleId: null }} selectedId={null} items={[meeting({ occurrence_state: "future-state", status: "" })]} /></I18nProvider>);
    expect(screen.getByRole("link", { name: "Record meeting occurrence · Unrecognized state: future-state" })).toBeVisible(); expect(screen.queryByText("Ended")).toBeNull(); expect(screen.queryByText("Started")).toBeNull();
  });
});
