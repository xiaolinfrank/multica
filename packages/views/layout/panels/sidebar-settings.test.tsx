import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueViewPreference } from "@multica/core/api/schemas";
import { issueViewPreferenceOptions } from "@multica/core/issue-views/preferences";
import { buildIssueStatusCatalog } from "@multica/core/issue-statuses/queries";
import { SIDEBAR_PROJECTS_SCOPE } from "@multica/core/issues/sidebar-project-prefs";
import {
  DEFAULT_SIDEBAR_ISSUE_SETTINGS,
  DEFAULT_SIDEBAR_PROJECT_SETTINGS,
} from "@multica/core/issues/stores/sidebar-tree-store";
import { renderWithI18n } from "../../test/i18n";
import { ProjectsSectionSettings } from "./sidebar-settings";

const server = vi.hoisted(() => ({
  doc: null as unknown as IssueViewPreference,
  getIssueViewPreference: vi.fn(),
  putIssueViewPreference: vi.fn(),
}));
vi.mock("@multica/core/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/api")>()),
  api: {
    getIssueViewPreference: server.getIssueViewPreference,
    putIssueViewPreference: server.putIssueViewPreference,
  },
}));
vi.mock("@multica/core/issue-statuses/hooks", () => ({
  useIssueStatuses: () =>
    buildIssueStatusCatalog(
      [
        ["todo", "Todo", "unstarted"],
        ["in_progress", "In Progress", "started"],
        ["done", "Done", "done"],
      ].map(([key, name, category], position) => ({
        id: key!,
        workspace_id: "ws-1",
        key: key!,
        name: name!,
        description: "",
        category: category as "unstarted",
        color: "",
        is_system: true,
        position,
        archived_at: null,
        created_at: "",
        updated_at: "",
      })),
    ),
}));
vi.mock("../../issues/components/status-icon", () => ({ StatusIcon: () => <span /> }));

const saved = (prefs: Record<string, unknown>): IssueViewPreference => ({
  scope_type: "sidebar_projects",
  scope_id: "u1",
  updated_at: "2026-10-31T00:00:00Z",
  prefs: { hidden: [], order: [], ...prefs },
});

let qc: QueryClient;

beforeEach(() => {
  server.doc = saved({});
  server.getIssueViewPreference.mockReset().mockImplementation(async () => server.doc);
  server.putIssueViewPreference
    .mockReset()
    .mockImplementation(async ({ prefs }: { prefs: Record<string, unknown> }) => (server.doc = saved(prefs)));
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(issueViewPreferenceOptions("ws-1", SIDEBAR_PROJECTS_SCOPE).queryKey, server.doc);
});

function openSettings() {
  renderWithI18n(
    <QueryClientProvider client={qc}>
      <ProjectsSectionSettings wsId="ws-1" />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Project display" }));
}

const chip = (name: string) => screen.getByRole("button", { name });
const lastSaved = () => server.putIssueViewPreference.mock.lastCall![0].prefs;

describe("ProjectsSectionSettings", () => {
  // The "Issues in projects" group is gone with the issue lists themselves
  // (S6 batch 3): a project's tree is modules and work items, which have no
  // statuses or assignee to configure. What stays is the project list's own
  // group, so its three tests below replace the five that covered both.
  it("covers the project list only — the issue-list group is gone", () => {
    openSettings();

    expect(screen.getByRole("heading", { name: "Projects" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Issues in projects" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Assignee" })).toBeNull();
  });

  it("toggles a project status for every device", async () => {
    openSettings();

    expect(chip("Completed")).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(chip("Completed"));
    await waitFor(() => expect(chip("Completed")).toHaveAttribute("aria-pressed", "true"));
    expect(lastSaved().projects.statuses).toContain("completed");
  });

  it("resets the project list at once", async () => {
    openSettings();

    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
    fireEvent.click(chip("Completed"));
    await waitFor(() => expect(chip("Completed")).toHaveAttribute("aria-pressed", "true"));

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Reset" })).toBeNull());
    // The reset is the last write to go out.
    await waitFor(() => expect(lastSaved().projects).toEqual(DEFAULT_SIDEBAR_PROJECT_SETTINGS));
    // The update spreads the saved document, so the stored issue-list
    // fields ride along untouched: the panel no longer offers them, but an
    // older client that still reads them keeps a valid payload. The reset
    // itself writes the default project list.
    expect(lastSaved().projects).toEqual(DEFAULT_SIDEBAR_PROJECT_SETTINGS);
    expect(lastSaved().issues).toEqual(DEFAULT_SIDEBAR_ISSUE_SETTINGS);
  });
});
