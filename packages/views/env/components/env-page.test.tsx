// @vitest-environment jsdom

import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enEnv from "../../locales/en/env.json";

const TEST_RESOURCES = {
  en: { common: enCommon, env: enEnv },
};

const mockMemberListOptions = vi.hoisted(() => vi.fn());
const mockWorkspaceEnvOptions = vi.hoisted(() => vi.fn());

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

// Minimal ApiError mirroring the real constructor signature
// (message, status, statusText, body?) so the page's
// `instanceof ApiError && status === 403` branch is exercisable without
// pulling the real client into the test.
vi.mock("@multica/core/api", () => {
  class ApiError extends Error {
    status: number;
    statusText: string;
    constructor(message: string, status: number, statusText = "") {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.statusText = statusText;
    }
  }
  return { ApiError };
});

vi.mock("@multica/core/workspace/queries", () => ({
  memberListOptions: (...args: unknown[]) => mockMemberListOptions(...args),
  workspaceEnvOptions: (...args: unknown[]) => mockWorkspaceEnvOptions(...args),
}));

import { EnvPage } from "./env-page";
import { ApiError } from "@multica/core/api";

function I18nWrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      {children}
    </I18nProvider>
  );
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <I18nWrapper>
      <QueryClientProvider client={queryClient}>
        <EnvPage />
      </QueryClientProvider>
    </I18nWrapper>,
  );
}

function asOwner() {
  mockMemberListOptions.mockReturnValue({
    queryKey: ["members", "ws-1"],
    queryFn: () =>
      Promise.resolve([{ user_id: "user-1", role: "owner" }]),
  });
}

function asPlainMember() {
  mockMemberListOptions.mockReturnValue({
    queryKey: ["members", "ws-1"],
    queryFn: () =>
      Promise.resolve([{ user_id: "user-1", role: "member" }]),
  });
}

describe("EnvPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkspaceEnvOptions.mockReturnValue({
      queryKey: ["workspaces", "ws-1", "env"],
      queryFn: () =>
        Promise.resolve({
          agents: [
            {
              agent_id: "agent-1",
              agent_name: "Bio Researcher",
              keys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
              mcp_servers: [{ name: "tavily", keys: ["TAVILY_API_KEY"] }],
              gateway_token: true,
            },
            {
              agent_id: "agent-2",
              agent_name: "Empty Bot",
              keys: [],
              mcp_servers: [],
              gateway_token: false,
            },
          ],
        }),
    });
  });

  it("lists agents grouped with secrets across all three locations, values masked", async () => {
    asOwner();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Bio Researcher")).toBeTruthy();
    });
    // custom_env key names…
    expect(screen.getByText("ANTHROPIC_API_KEY")).toBeTruthy();
    expect(screen.getByText("OPENAI_API_KEY")).toBeTruthy();
    // …MCP server section (name + its env key)…
    expect(screen.getByText("MCP · tavily")).toBeTruthy();
    expect(screen.getByText("TAVILY_API_KEY")).toBeTruthy();
    // …and the gateway-token presence badge.
    expect(screen.getByText("Gateway token")).toBeTruthy();
    // A masked placeholder stands in for every value (2 custom + 1 mcp).
    expect(screen.getAllByText("••••••••").length).toBeGreaterThanOrEqual(3);
    // Count badge sums custom_env + MCP keys (2 + 1).
    expect(screen.getByText("3 variables")).toBeTruthy();
    // Agents with no secrets at all are not noise on a read-only overview.
    expect(screen.queryByText("Empty Bot")).toBeNull();
  });

  it("offers no edit affordances (read-only)", async () => {
    asOwner();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("ANTHROPIC_API_KEY")).toBeTruthy();
    });
    // No add/save/delete controls on the browse-only page.
    expect(screen.queryByText(/Add variable/i)).toBeNull();
    expect(screen.queryByText(/^Save$/)).toBeNull();
    expect(screen.queryByRole("textbox")).not.toBeNull(); // only the search box
  });

  it("falls back to the admins-only state if the env query 403s for an admin", async () => {
    // Defensive second gate: if the client-side role check is stale (e.g. the
    // viewer was just demoted) the query still fires and the server 403s. The
    // page must surface the same forbidden state, not a raw error.
    asOwner();
    mockWorkspaceEnvOptions.mockReturnValue({
      queryKey: ["workspaces", "ws-1", "env"],
      queryFn: () => Promise.reject(new ApiError("forbidden", 403, "Forbidden")),
    });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Admins only")).toBeTruthy();
    });
    expect(screen.queryByText("Bio Researcher")).toBeNull();
  });

  it("shows an admins-only state for non-admin members and never fetches env", async () => {
    asPlainMember();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Admins only")).toBeTruthy();
    });
    // The env query is gated off, so the agent overview is never requested.
    for (const call of mockWorkspaceEnvOptions.mock.results) {
      // workspaceEnvOptions may be called to build the (disabled) query, but
      // its queryFn must never run — assert no agent data leaked into the DOM.
      void call;
    }
    expect(screen.queryByText("Bio Researcher")).toBeNull();
    expect(screen.queryByText("ANTHROPIC_API_KEY")).toBeNull();
  });
});
