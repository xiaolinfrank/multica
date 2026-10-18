import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { Tabs, TabsContent, TabsList } from "@multica/ui/components/ui/tabs";
import enCockpit from "../../locales/en/cockpit.json";
import { CockpitMeetingStageTabs } from "./cockpit-meeting-stage";
import type { CockpitMeetingStage } from "./meeting-stage";

function StageNavigation({ initial, onChange }: { initial: CockpitMeetingStage; onChange: (value: CockpitMeetingStage) => void }) {
  const [value, setValue] = useState(initial);
  return <Tabs value={value} onValueChange={(next) => { setValue(next); onChange(next); }}>
    <TabsList><CockpitMeetingStageTabs occurrenceState="ended" workflow={undefined} /></TabsList>
    <TabsContent value="preparation">Prepare materials</TabsContent>
    <TabsContent value="recording">Record meeting</TabsContent>
    <TabsContent value="minutes_review">Confirm minutes</TabsContent>
  </Tabs>;
}

function setup(initial: CockpitMeetingStage) {
  const onChange = vi.fn();
  render(<I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><StageNavigation initial={initial} onChange={onChange} /></I18nProvider>);
  return onChange;
}

describe("meeting stage navigation", () => {
  it("keeps the three stage names accessible and permits looking back without changing the occurrence projection", async () => {
    const user = userEvent.setup();
    const onChange = setup("minutes_review");
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.getByRole("tab", { name: "Minutes confirmation" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("tab", { name: "Preparation" }));
    expect(onChange).toHaveBeenCalledWith("preparation");
    expect(screen.getByRole("tab", { name: "Preparation" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Prepare materials");
  });

  it("supports keyboard stage navigation through the existing tab primitive", async () => {
    const user = userEvent.setup();
    const onChange = setup("preparation");
    await user.click(screen.getByRole("tab", { name: "Preparation" }));
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Meeting record" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Preparation" })).toHaveAttribute("aria-selected", "true");
    expect(onChange).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("tab", { name: "Meeting record" })).toHaveAttribute("aria-selected", "true");
    expect(onChange).toHaveBeenLastCalledWith("recording");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Record meeting");
  });
});
