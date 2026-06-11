import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentRuntime } from "@multica/core/types";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enOnboarding from "../../locales/en/onboarding.json";

const TEST_RESOURCES = { en: { common: enCommon, onboarding: enOnboarding } };

const mocks = vi.hoisted(() => ({
  pickerState: {
    runtimes: [] as AgentRuntime[],
    selected: null as AgentRuntime | null,
    selectedId: null as string | null,
    setSelectedId: vi.fn<(id: string) => void>(),
    hasRuntimes: false,
  },
}));

// Swap out the runtime picker so tests can drive runtimes / selection
// without a real TanStack Query + WS stack.
vi.mock("../components/use-runtime-picker", () => ({
  useRuntimePicker: () => mocks.pickerState,
}));

import { StepPlatformFork } from "./step-platform-fork";

function makeRuntime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    id: "rt_test",
    workspace_id: "ws_test",
    name: "Claude Code",
    provider: "claude",
    status: "online",
    runtime_mode: "local",
    runtime_config: {},
    device_info: "",
    metadata: {},
    daemon_id: null,
    visibility: "public",
    last_seen_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as unknown as AgentRuntime;
}

function renderFork(
  overrides: Partial<React.ComponentProps<typeof StepPlatformFork>> = {},
) {
  const onNext = vi.fn();
  render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <StepPlatformFork wsId="ws_test" onNext={onNext} {...overrides} />
    </I18nProvider>,
  );
  return { onNext };
}

function resetPicker(patch: Partial<typeof mocks.pickerState> = {}) {
  mocks.pickerState.runtimes = patch.runtimes ?? [];
  mocks.pickerState.selected = patch.selected ?? null;
  mocks.pickerState.selectedId = patch.selectedId ?? null;
  mocks.pickerState.hasRuntimes = patch.hasRuntimes ?? false;
  mocks.pickerState.setSelectedId = vi.fn();
}

describe("StepPlatformFork (cloud-direct)", () => {
  beforeEach(() => {
    resetPicker();
    vi.restoreAllMocks();
  });

  it("with no shared runtime: shows the waiting state, no install guidance", () => {
    renderFork();
    expect(
      screen.getByText(/setting up your cloud computer/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/waiting for a shared runtime to come online/i),
    ).toBeInTheDocument();
    // The old install paths must be gone entirely.
    expect(screen.queryByText(/use this computer/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/connect from the terminal/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();
    // Continue is disabled until a shared runtime exists.
    expect(
      screen.getByRole("button", { name: /start exploring/i }),
    ).toBeDisabled();
  });

  it("Skip is always enabled and calls onNext(null)", async () => {
    const user = userEvent.setup();
    const { onNext } = renderFork();
    await user.click(screen.getByRole("button", { name: /skip for now/i }));
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledWith(null);
  });

  it("lists public runtimes and continues with the selected one", async () => {
    const rt = makeRuntime({ id: "rt_claude", name: "Claude Code" });
    resetPicker({
      runtimes: [rt],
      selected: rt,
      selectedId: rt.id,
      hasRuntimes: true,
    });
    const user = userEvent.setup();
    const { onNext } = renderFork();

    expect(
      screen.getByText(/your cloud computer is ready/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 computer connected/i)).toBeInTheDocument();
    expect(screen.getByText(/selected: claude code/i)).toBeInTheDocument();

    const connect = screen.getByRole("button", { name: /start exploring/i });
    expect(connect).toBeEnabled();
    await user.click(connect);
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledWith(rt);
  });

  it("private runtimes are filtered out of the shared list", () => {
    const priv = makeRuntime({
      id: "rt_private",
      name: "Someone's laptop",
      visibility: "private",
    });
    resetPicker({
      runtimes: [priv],
      selected: priv,
      selectedId: priv.id,
      hasRuntimes: true,
    });
    renderFork();
    // Only private runtimes exist → behaves like the empty state.
    expect(
      screen.getByText(/setting up your cloud computer/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/someone's laptop/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /start exploring/i }),
    ).toBeDisabled();
  });
});
