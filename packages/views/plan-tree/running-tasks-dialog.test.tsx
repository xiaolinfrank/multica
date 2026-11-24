import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import enCockpit from "../locales/en/cockpit.json";
import enCommon from "../locales/en/common.json";
import { RunningTasksDialog } from "./running-tasks-dialog";

function setup(conflict: Parameters<typeof RunningTasksDialog>[0]["conflict"]) {
  const retry = vi.fn();
  const onDismiss = vi.fn();
  render(
    <I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, common: enCommon } }}>
      <RunningTasksDialog conflict={conflict ? { ...conflict, retry } : null} onDismiss={onDismiss} />
    </I18nProvider>,
  );
  return { retry, onDismiss };
}

describe("RunningTasksDialog", () => {
  it("lists the tasks and offers sync-now, sync-later and cancel", () => {
    const { retry } = setup({
      tasks: [{ task_id: "t1", issue_id: "i1", issue_identifier: "TES-7", status: "running" }],
      retry: vi.fn(),
    });
    expect(screen.getByText("TES-7")).toBeInTheDocument();
    expect(screen.getByText(/Status: running/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(retry).toHaveBeenCalledWith("force");
    fireEvent.click(screen.getByRole("button", { name: "Sync later" }));
    expect(retry).toHaveBeenCalledWith("defer");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  });

  it("stays closed without a conflict", () => {
    setup(null);
    expect(screen.queryByText("An agent is working in this folder")).toBeNull();
  });
});
