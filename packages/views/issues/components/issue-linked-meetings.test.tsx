// The section is a filter over the workspace-cached cockpit board: these
// tests pin the filtering (only THIS issue's links), the sort (by date), the
// deep links (?meeting=), and the empty-state self-hiding.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import enIssues from "../../locales/en/issues.json";
import type { CockpitBoard } from "@multica/core/types";

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({
    cockpit: () => "/ws/cockpit",
  }),
}));

vi.mock("../../navigation", () => ({
  AppLink: ({ children, href, ...rest }: React.ComponentProps<"a">) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

vi.mock("@multica/core/api", () => ({
  api: {
    getCockpit: vi.fn(),
  },
}));

import { api } from "@multica/core/api";
import { IssueLinkedMeetings } from "./issue-linked-meetings";

const board: Pick<CockpitBoard, "meetings" | "meeting_issues"> = {
  meetings: [
    { id: "m2", code: "20260908-01", title: "Weekly W37", meet_date: "2026-09-08" },
    { id: "m1", code: "20260901-01", title: "Kickoff", meet_date: "2026-09-01" },
    { id: "m3", code: "20260915-01", title: "Unrelated", meet_date: "2026-09-15" },
  ],
  meeting_issues: [
    // Deliberately unordered: the section sorts by meet_date.
    { meeting_id: "m2", issue_id: "issue-1", role: "", issue_number: 2, issue_identifier: "TES-2" },
    { meeting_id: "m1", issue_id: "issue-1", role: "task", issue_number: 1, issue_identifier: "TES-1" },
    { meeting_id: "m3", issue_id: "issue-2", role: "", issue_number: 3, issue_identifier: "TES-3" },
  ],
} as Pick<CockpitBoard, "meetings" | "meeting_issues">;

function renderSection(issueId = "issue-1") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en" resources={{ en: { issues: enIssues } }}>
        <IssueLinkedMeetings issueId={issueId} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("IssueLinkedMeetings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getCockpit).mockResolvedValue(board as CockpitBoard);
  });

  it("lists this issue's meetings sorted by date, linking to the cockpit deep link", async () => {
    renderSection();
    const section = await screen.findByTestId("issue-linked-meetings");
    expect(section).toHaveTextContent("Linked meetings");

    const links = await screen.findAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/ws/cockpit?meeting=m1",
      "/ws/cockpit?meeting=m2",
    ]);
    expect(links[0]).toHaveTextContent("Kickoff");
    expect(links[1]).toHaveTextContent("Weekly W37");
    // m3 is linked to a different issue and never appears.
    expect(section).not.toHaveTextContent("Unrelated");
  });

  it("hides itself entirely when the issue has no linked meetings", () => {
    const { container } = renderSection("issue-without-meetings");
    expect(container).toBeEmptyDOMElement();
  });

  it("collapses and re-expands from the header", async () => {
    renderSection();
    await screen.findByTestId("issue-linked-meetings");
    fireEvent.click(screen.getByRole("button", { name: /Linked meetings/ }));
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Linked meetings/ }));
    expect(await screen.findAllByRole("link")).toHaveLength(2);
  });
});
