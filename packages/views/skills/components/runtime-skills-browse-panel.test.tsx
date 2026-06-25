// @vitest-environment jsdom

import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enSkills from "../../locales/en/skills.json";

const TEST_RESOURCES = {
  en: { common: enCommon, skills: enSkills },
};

const mockRuntimeListOptions = vi.hoisted(() => vi.fn());
const mockRuntimeLocalSkillsOptions = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/auth", () => {
  const stateUser = { id: "user-1", email: "u@example.com", name: "User" };
  const useAuthStore = (
    selector?: (s: { user: typeof stateUser }) => unknown,
  ) => {
    const state = { user: stateUser };
    return selector ? selector(state) : state;
  };
  return { useAuthStore };
});

vi.mock("@multica/core/runtimes", () => ({
  runtimeListOptions: (...args: unknown[]) => mockRuntimeListOptions(...args),
  runtimeLocalSkillsOptions: (...args: unknown[]) =>
    mockRuntimeLocalSkillsOptions(...args),
}));

import { RuntimeSkillsBrowsePanel } from "./runtime-skills-browse-panel";

function I18nWrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      {children}
    </I18nProvider>
  );
}

const MOCK_RUNTIME = {
  id: "runtime-1",
  workspace_id: "ws-1",
  daemon_id: "daemon-1",
  name: "Claude (MacBook)",
  runtime_mode: "local",
  provider: "claude",
  launch_header: "",
  status: "online",
  device_info: "",
  metadata: {},
  owner_id: "user-1",
  last_seen_at: null,
  created_at: "2026-04-16T00:00:00Z",
  updated_at: "2026-04-16T00:00:00Z",
};

const MOCK_SKILL = {
  key: "review-helper",
  name: "Review Helper",
  description: "Review pull requests",
  provider: "claude",
  source_path: "~/.claude/skills/review-helper",
  file_count: 2,
};

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <I18nWrapper>
      <QueryClientProvider client={queryClient}>
        <RuntimeSkillsBrowsePanel />
      </QueryClientProvider>
    </I18nWrapper>,
  );
}

describe("RuntimeSkillsBrowsePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockRuntimeListOptions.mockReturnValue({
      queryKey: ["runtimes", "ws-1", "list"],
      queryFn: () => Promise.resolve([MOCK_RUNTIME]),
    });
    mockRuntimeLocalSkillsOptions.mockReturnValue({
      queryKey: ["runtimes", "local-skills", "runtime-1"],
      queryFn: () =>
        Promise.resolve({ supported: true, skills: [MOCK_SKILL] }),
    });
  });

  it("lists a connected runtime's native skills read-only", async () => {
    renderPanel();

    await waitFor(() => {
      expect(screen.getByText("Review Helper")).toBeTruthy();
    });
    // Display metadata: provider badge, source path, file-count badge.
    expect(screen.getByText("claude")).toBeTruthy();
    expect(screen.getByText("~/.claude/skills/review-helper")).toBeTruthy();
    expect(screen.getByText("2 files")).toBeTruthy();
  });

  it("exposes no import or selection affordances (browse only)", async () => {
    renderPanel();

    await waitFor(() => {
      expect(screen.getByText("Review Helper")).toBeTruthy();
    });
    // The import panel's hallmark controls must be absent on the browse view.
    expect(screen.queryByText("Import to Workspace")).toBeNull();
    expect(screen.queryByText(/Select all/)).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("shows an empty state when there are no local runtimes", async () => {
    mockRuntimeListOptions.mockReturnValue({
      queryKey: ["runtimes", "ws-1", "list"],
      queryFn: () => Promise.resolve([]),
    });
    renderPanel();

    await waitFor(() => {
      expect(screen.getByText("No local runtimes available")).toBeTruthy();
    });
    // The discovery query is only ever built with a null runtime (disabled),
    // never against a real runtime id, so nothing is polled.
    for (const call of mockRuntimeLocalSkillsOptions.mock.calls) {
      expect(call[0]).toBeNull();
    }
  });

  it("requires the runtime to be online before browsing", async () => {
    mockRuntimeListOptions.mockReturnValue({
      queryKey: ["runtimes", "ws-1", "list"],
      queryFn: () =>
        Promise.resolve([{ ...MOCK_RUNTIME, status: "offline" }]),
    });
    renderPanel();

    await waitFor(() => {
      expect(
        screen.getByText("Runtime must be online to browse local skills."),
      ).toBeTruthy();
    });
  });
});
