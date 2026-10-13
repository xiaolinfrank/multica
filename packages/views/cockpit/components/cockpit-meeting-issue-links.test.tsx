import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import type { CockpitMeetingIssueLink } from "@multica/core/types";
import enCockpit from "../../locales/en/cockpit.json";
import { CockpitMeetingIssueLinks } from "./cockpit-meeting-issue-links";

vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ cockpit: () => "/ws/cockpit", issueDetail: (id: string) => `/ws/issues/${id}` }),
}));
vi.mock("../../navigation", () => ({
  AppLink: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("../../issues/components/status-icon", () => ({ StatusIcon: () => <span /> }));

const link: CockpitMeetingIssueLink = {
  meeting_id: "m1", issue_id: "i1", role: "task", roles: [], issue_number: 1,
  issue_identifier: "BIO-1", issue_title: "Check material", issue_status: "todo", position: 0,
};

function setup(roles: string[] = [], save = vi.fn().mockResolvedValue(undefined), disabled = false, requiredRolesByIssue?: ReadonlyMap<string, readonly string[]>) {
  render(<I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}>
    <CockpitMeetingIssueLinks wsId="ws-1" links={[{ ...link, roles }]} onLink={vi.fn()} onUnlink={vi.fn()}
      onSaveRoles={save} disabled={disabled} requiredRolesByIssue={requiredRolesByIssue} />
  </I18nProvider>);
  return save;
}

describe("meeting issue purposes", () => {

  it("retains the workflow-owned relation and required purpose while allowing additional purposes", async () => {
    const save = setup(["minutes"], undefined, false, new Map([["i1", ["minutes"]]]));
    expect(screen.queryByRole("button", { name: "Unlink BIO-1" })).toBeNull();
    expect(screen.getByText("Managed by the meeting workflow; its required purpose and link are retained.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit purposes for BIO-1" }));
    expect(screen.getByRole("checkbox", { name: "Minutes" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Minutes" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("checkbox", { name: "Minutes" }));
    expect(screen.getByRole("checkbox", { name: "Minutes" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "Reference" }));
    fireEvent.click(screen.getByRole("button", { name: "Save purposes" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("i1", ["minutes", "reference"]));
  });

  it("keeps the old provisioning link unclassified instead of inferring minutes", () => {
    setup();
    expect(screen.getByText("Created with meeting (unclassified)")).toBeTruthy();
    expect(screen.queryByText("Minutes")).toBeNull();
    expect(screen.getByRole("link", { name: "BIO-1 Check material" }).getAttribute("href")).toBe("/ws/issues/BIO-1");
  });

  it("preserves multiple and future purposes while a failed save keeps the user's selection for retry", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("Connection lost")).mockResolvedValueOnce(undefined);
    setup(["preparation", "future-role"], save);
    fireEvent.click(screen.getByRole("button", { name: "Edit purposes for BIO-1" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Save purposes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection lost");
    expect(screen.getByRole("checkbox", { name: "Preparation" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Review" })).toBeChecked();
    expect(save).toHaveBeenLastCalledWith("i1", ["preparation", "future-role", "review"]);
    fireEvent.click(screen.getByRole("button", { name: "Save purposes" }));
    await waitFor(() => expect(screen.queryByRole("checkbox", { name: "Review" })).toBeNull());
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("shows all purposes but offers no mutations on a read-only record", () => {
    setup(["minutes", "review", "future-role"], undefined, true);
    expect(screen.getByText("Minutes")).toBeTruthy();
    expect(screen.getByText("Review")).toBeTruthy();
    expect(screen.getByText("Other: future-role")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
