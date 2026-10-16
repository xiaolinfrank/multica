import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { CockpitStatusOrbit } from "./cockpit-status-orbit";
import { workOverview } from "./overview-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";

function orbit(counts = workOverview().summary.my_primary_issues) {
  return render(<I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitStatusOrbit counts={counts} /></I18nProvider>);
}

describe("cockpit status instrument", () => {
  it("draws the actual status shares without claiming a completion or acceptance rate", () => {
    const { container } = orbit();
    expect(container.querySelector('[data-status="unstarted"]')).toHaveAttribute("stroke-dasharray", "60 40");
    expect(container.querySelector('[data-status="started"]')).toHaveAttribute("stroke-dashoffset", "-60");
    expect(container.querySelector('[data-status="unknown"]')).toHaveAttribute("stroke-dasharray", "10 90");
    expect(screen.getByText("8")).toBeVisible();
    expect(screen.getByText(enCockpit.work_overview.active_tasks)).toBeVisible();
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps material definitions local when two instruments share a page", () => {
    const counts = workOverview().summary.my_primary_issues;
    const { container } = render(<I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}>
      <CockpitStatusOrbit counts={counts} /><CockpitStatusOrbit counts={counts} />
    </I18nProvider>);
    const ids = [...container.querySelectorAll("defs [id]")].map((element) => element.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(ids.length);
    for (const svg of container.querySelectorAll("svg")) {
      const local = new Set([...svg.querySelectorAll("defs [id]")].map((element) => element.id));
      for (const shape of svg.querySelectorAll('[fill^="url(#"]')) {
        expect(local.has(shape.getAttribute("fill")!.slice(5, -1))).toBe(true);
      }
    }
  });

  it.each([0, 11])("does not invent chart shares when the reported total is %s", (total) => {
    const { container } = orbit({ ...workOverview().summary.my_primary_issues, total });
    expect(container.querySelectorAll(".cockpit-orbit-segment")).toHaveLength(0);
    expect(screen.getByText("8")).toBeVisible();
  });
});
