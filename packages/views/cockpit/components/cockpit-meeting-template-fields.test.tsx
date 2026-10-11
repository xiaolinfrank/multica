import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import type { CockpitTemplateEditorDraft } from "@multica/core/cockpit";
import { CockpitMeetingTemplateFields } from "./cockpit-meeting-template-fields";
import enCockpit from "../../locales/en/cockpit.json";
import enIssues from "../../locales/en/issues.json";

const draft = (): CockpitTemplateEditorDraft => ({ kind: "template", observedRevision: 2, title: "Boundary preparation", description: "", active: true, config: { schema_version: 1, slots: [] } });
function show(initial: CockpitTemplateEditorDraft, observe = vi.fn()) {
  function Harness() { const [value, setValue] = useState(initial); return <CockpitMeetingTemplateFields value={value} disabled={false} onChange={(next) => { observe(next); setValue(next); }} />; }
  return render(<I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, issues: enIssues } }}><Harness /></I18nProvider>);
}
describe("meeting preparation template form", () => {
  it("edits agenda and preparation fields with stable identities and explicitly removes dependent draft items", () => {
    const observe = vi.fn(); show(draft(), observe);
    expect(screen.getByRole("button", { name: "New preparation issue" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "New agenda" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Agenda title" }), { target: { value: "Clarify scope" } });
    const agendaId = observe.mock.lastCall![0].config.slots[0].slot_id;
    fireEvent.click(screen.getByRole("button", { name: "New preparation issue" }));
    fireEvent.change(screen.getByRole("textbox", { name: enCockpit.task_flow.title }), { target: { value: "Prepare source notes" } });
    expect(observe.mock.lastCall![0].config.slots[1]).toMatchObject({ kind: "preparation_issue", agenda_slot_id: agendaId, new_issue: { title: "Prepare source notes" } });
    fireEvent.click(screen.getByRole("button", { name: /1\. Clarify scope/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Agenda title" }), { target: { value: "Confirm boundaries" } });
    expect(observe.mock.lastCall![0].config.slots[0].slot_id).toBe(agendaId);
    fireEvent.click(screen.getByRole("button", { name: "Remove item" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Remove 2 item(s) from this draft?");
    expect(observe.mock.lastCall![0].config.slots).toHaveLength(2);
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Remove item" }));
    expect(observe.mock.lastCall![0].config.slots).toHaveLength(0);
  });
  it("bounds the item list to 25 and opens only the selected form", () => {
    const initial = draft(); initial.config.slots = Array.from({ length: 26 }, (_, index) => ({ slot_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, kind: "agenda", label: `Topic ${index + 1}`, agenda_slot_id: null, purpose: "", new_issue: null,
      agenda: { title: `Topic ${index + 1}`, purposes: [], desired_outcome: "", notes: `Private draft ${index + 1}` } }));
    show(initial);
    expect(screen.getAllByRole("listitem")).toHaveLength(25); expect(screen.getAllByRole("textbox", { name: "Agenda title" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /26\. Topic 26/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1); fireEvent.click(screen.getByRole("button", { name: /26\. Topic 26/ }));
    expect(screen.getByRole("textbox", { name: "Initial working notes" })).toHaveValue("Private draft 26");
  });
});
