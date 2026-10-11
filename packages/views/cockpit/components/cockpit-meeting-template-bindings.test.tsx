import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import type { CockpitTemplateApplicationDraft, CockpitTemplateEditorDraft } from "@multica/core/cockpit";
import { CockpitMeetingTemplateBindings, emptyMeetingTemplateBinding } from "./cockpit-meeting-template-bindings";
import enCockpit from "../../locales/en/cockpit.json";
import enIssues from "../../locales/en/issues.json";

// These independently tested pickers do not participate in selecting a
// template dependency. Keep the list, paging and binding form wiring real.
vi.mock("./cockpit-node-issue-picker", () => ({
  CockpitNodeIssuePicker: () => <span>Execution scope picker</span>,
  useCockpitSelectedNodeIssueOption: () => ({ option: null, isError: false, isPending: false }),
}));
vi.mock("./cockpit-reviewer-select", () => ({ CockpitReviewerSelect: () => <span>Facilitator picker</span> }));
vi.mock("./cockpit-assignee-picker", () => ({ CockpitAssigneePicker: () => <span>Assignee picker</span> }));
vi.mock("./cockpit-scope-control", () => ({ CockpitScopePicker: () => <span>Project picker</span> }));

describe("meeting template dependency selection", () => {
  it("locates and selects an agenda on another page without choosing unrelated work or losing the child draft", () => {
    const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const parentId = id(26), childId = id(1);
    const config: CockpitTemplateEditorDraft["config"] = { schema_version: 1, slots: [
      { slot_id: childId, kind: "preparation_issue", label: "Prepare source evidence", agenda_slot_id: parentId, purpose: "", agenda: null,
        new_issue: { title: "Prepare source evidence", description: "Keep the source notes", priority: "high" } },
      ...Array.from({ length: 25 }, (_, index) => ({ slot_id: id(index + 2), kind: "agenda" as const,
        label: index === 24 ? "Review delivery boundary" : `Other agenda ${index + 1}`, agenda_slot_id: null, purpose: "", new_issue: null,
        agenda: { title: index === 24 ? "Review delivery boundary" : `Other agenda ${index + 1}`, purposes: [], desired_outcome: "", notes: "" } })),
    ] };
    const initial = config.slots.map((slot) => ({ ...emptyMeetingTemplateBinding(slot.slot_id),
      ...(slot.slot_id === childId ? { selected: true, due_date: "2026-12-20" } : {}) }));
    let latest: CockpitTemplateApplicationDraft["bindings"] = initial;
    function Harness() {
      const [value, setValue] = useState(initial);
      return <CockpitMeetingTemplateBindings wsId={id(101)} meetingId={id(102)} config={config} value={value} disabled={false}
        resourcesHref="/workspace/cockpit?meeting=meeting&meeting_view=resources" onChange={(next) => { latest = next; setValue(next); }} />;
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, issues: enIssues } }}><Harness /></I18nProvider></QueryClientProvider>);
    expect(screen.getAllByRole("listitem")).toHaveLength(25);
    expect(screen.queryByRole("checkbox", { name: /Review delivery boundary/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: enCockpit.meeting_templates.select_parent }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByRole("checkbox", { name: /Review delivery boundary/ })).toBeChecked();
    const configuration = screen.getByRole("region", { name: enCockpit.meeting_templates.configure_item });
    expect(configuration).toHaveFocus();
    expect(within(configuration).getByRole("heading", { name: "Review delivery boundary" })).toBeVisible();
    expect(latest.filter((item) => item.selected).map((item) => item.slot_id)).toEqual([childId, parentId]);
    expect(latest.find((item) => item.slot_id === childId)?.due_date).toBe("2026-12-20");
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(screen.getByRole("checkbox", { name: /Prepare source evidence/ })).toBeChecked();
    expect(screen.queryByRole("button", { name: enCockpit.meeting_templates.select_parent })).toBeNull();
    client.clear();
  });
});
