import { describe, it, expect, beforeEach, vi } from "vitest";
import { cleanup, screen, fireEvent } from "@testing-library/react";
import { renderWithI18n } from "../../test/i18n";
import type { AgentWorkspacesResponse } from "@multica/core/types";

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

// The browser pulls in lowlight + RPC query options; this section test only
// covers the list/collapse behavior, so stub it to a marker.
vi.mock("../../workspaces/components/workspace-file-browser", () => ({
  WorkspaceFileBrowser: () => <div data-testid="browser" />,
}));

import { WorkspaceFilesSection } from "./workspace-files-section";

function ws(partial: Partial<AgentWorkspacesResponse["workspaces"][number]>) {
  return {
    issue_id: "i1",
    issue_identifier: "JIA-1",
    issue_title: "Title",
    issue_status: "in_progress",
    agent_id: "a1",
    agent_name: "Agent One",
    device_name: "mac-mini",
    task_short: "abcd1234",
    size_bytes: 2048,
    repo_checkout_bytes: 0,
    file_count: 5,
    age_seconds: 60,
    ...partial,
  };
}

describe("WorkspaceFilesSection", () => {
  beforeEach(() => cleanup());

  it("renders nothing when the issue has no workspace on disk", () => {
    queryRef.current = {
      isLoading: false,
      data: {
        total_size_bytes: 0,
        total_repo_checkout_bytes: 0,
        workspaces: [ws({ issue_id: "other" })],
      },
    };
    const { container } = renderWithI18n(<WorkspaceFilesSection issueId="i1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists the issue's workspaces and reveals the browser on expand", () => {
    queryRef.current = {
      isLoading: false,
      data: {
        total_size_bytes: 2048,
        total_repo_checkout_bytes: 0,
        workspaces: [ws({ issue_id: "i1", agent_name: "Agent One" })],
      },
    };
    renderWithI18n(<WorkspaceFilesSection issueId="i1" />);

    // Header is shown; the tree stays unmounted until expanded.
    expect(screen.getByText("Workspace files")).toBeTruthy();
    expect(screen.queryByTestId("browser")).toBeNull();

    fireEvent.click(screen.getByText("Workspace files"));
    expect(screen.getByText("Agent One")).toBeTruthy();
    expect(screen.getByTestId("browser")).toBeTruthy();
  });
});
