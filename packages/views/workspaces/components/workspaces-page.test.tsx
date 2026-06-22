import { describe, it, expect, beforeEach, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderWithI18n } from "../../test/i18n";
import type { AgentWorkspacesResponse } from "@multica/core/types";

// Canned response the mocked useQuery returns; each test swaps `current`.
const queryRef = vi.hoisted(() => ({
  current: { data: undefined as AgentWorkspacesResponse | undefined, isLoading: false },
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query",
  );
  return { ...actual, useQuery: () => queryRef.current };
});

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ issueDetail: (id: string) => `/acme/issues/${id}` }),
}));

vi.mock("../../navigation", () => ({
  AppLink: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { WorkspacesPage } from "./workspaces-page";

function ws(partial: Partial<AgentWorkspacesResponse["workspaces"][number]>) {
  return {
    issue_id: "i1",
    issue_identifier: "JIA-1",
    issue_title: "Title",
    issue_status: "in_progress",
    agent_id: "a1",
    agent_name: "Agent One",
    device_name: "agent_2",
    task_short: "abcd1234",
    size_bytes: 1024,
    repo_checkout_bytes: 0,
    file_count: 3,
    age_seconds: 120,
    ...partial,
  };
}

describe("WorkspacesPage", () => {
  beforeEach(() => cleanup());

  it("groups multiple agents under the same issue and shows totals", () => {
    queryRef.current = {
      isLoading: false,
      data: {
        total_size_bytes: 3 * 1024 * 1024,
        total_repo_checkout_bytes: 1024 * 1024,
        workspaces: [
          ws({ issue_id: "i1", issue_title: "Shared issue", agent_name: "Agent One", task_short: "t1" }),
          ws({ issue_id: "i1", issue_title: "Shared issue", agent_name: "Agent Two", task_short: "t2", agent_id: "a2" }),
          ws({ issue_id: "i2", issue_identifier: "JIA-2", issue_title: "Other issue", task_short: "t3", agent_name: "Agent Three", agent_id: "a3" }),
        ],
      },
    };

    renderWithI18n(<WorkspacesPage />);

    // Both issues render once each (grouped), with both agents under the shared one.
    expect(screen.getAllByText("Shared issue")).toHaveLength(1);
    expect(screen.getByText("Other issue")).toBeTruthy();
    expect(screen.getByText("Agent One")).toBeTruthy();
    expect(screen.getByText("Agent Two")).toBeTruthy();
    // NAS total surfaces in the summary.
    expect(screen.getByText("3.0 MB")).toBeTruthy();
    // Open-issue link points at the grouped issue.
    const link = screen.getAllByText("Open issue")[0].closest("a");
    expect(link?.getAttribute("href")).toContain("/issues/i1");
  });

  it("renders the empty state when there are no workspaces", () => {
    queryRef.current = {
      isLoading: false,
      data: { total_size_bytes: 0, total_repo_checkout_bytes: 0, workspaces: [] },
    };
    renderWithI18n(<WorkspacesPage />);
    expect(screen.getByText("No workspaces yet")).toBeTruthy();
  });
});
