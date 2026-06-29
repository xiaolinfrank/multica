// @vitest-environment jsdom

import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enEnv from "../../locales/en/env.json";
import { SharedEnvCard } from "./shared-env-card";

const TEST_RESOURCES = { en: { common: enCommon, env: enEnv } };

const mockGet = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/api", () => ({
  api: {
    getWorkspaceSharedEnv: (...a: unknown[]) => mockGet(...a),
    updateWorkspaceSharedEnv: (...a: unknown[]) => mockUpdate(...a),
  },
}));

vi.mock("@multica/core/workspace/queries", () => ({
  workspaceKeys: { env: (wsId: string) => ["workspaces", wsId, "env"] },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function renderCard(keyNames: string[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <QueryClientProvider client={queryClient}>
        <SharedEnvCard wsId="ws-1" keyNames={keyNames} />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe("SharedEnvCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows masked key names pre-reveal and does not fetch values", () => {
    renderCard(["TAVILY_API_KEY"]);
    expect(screen.getByText("Workspace shared")).toBeTruthy();
    expect(screen.getByText("TAVILY_API_KEY")).toBeTruthy();
    // No reveal until the user clicks — the reveal is an audited server call.
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("reveals values on click, then saves the edited map", async () => {
    mockGet.mockResolvedValue({ shared_env: { TAVILY_API_KEY: "tvly-secret" } });
    mockUpdate.mockResolvedValue({
      shared_env: { TAVILY_API_KEY: "tvly-secret", NEW_KEY: "v" },
    });
    renderCard(["TAVILY_API_KEY"]);

    fireEvent.click(screen.getByText("Reveal & edit"));

    // The revealed value lands in an editable input.
    await waitFor(() => {
      expect(screen.getByDisplayValue("tvly-secret")).toBeTruthy();
    });
    expect(mockGet).toHaveBeenCalledTimes(1);

    // Add a row and fill it in, then save.
    fireEvent.click(screen.getByText("Add"));
    const keyInputs = screen.getAllByPlaceholderText("KEY");
    const valueInputs = screen.getAllByPlaceholderText("value");
    fireEvent.change(keyInputs[keyInputs.length - 1], { target: { value: "NEW_KEY" } });
    fireEvent.change(valueInputs[valueInputs.length - 1], { target: { value: "v" } });

    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledTimes(1);
    });
    expect(mockUpdate).toHaveBeenCalledWith({
      shared_env: { TAVILY_API_KEY: "tvly-secret", NEW_KEY: "v" },
    });
  });
});
