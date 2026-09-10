// @vitest-environment node

import { beforeEach, describe, expect, it } from "vitest";
import { useAgentProcessFoldStore } from "./agent-process-fold-store";

// Canonical matrix for the override semantics. The component suite
// (packages/views/issues/components/issue-agent-process.test.tsx) only asserts
// that the fold reads and writes this store; the rules live here.

const store = () => useAgentProcessFoldStore.getState();

beforeEach(() => {
  useAgentProcessFoldStore.setState({ overrides: new Map() });
});

describe("agent process fold store", () => {
  it("starts with no opinion so every fold follows its default", () => {
    expect(store().overrides.get("task-1")).toBeUndefined();
  });

  it("records an explicit open and an explicit close separately from absence", () => {
    store().setOpen("task-1", true);
    expect(store().overrides.get("task-1")).toBe(true);

    store().setOpen("task-1", false);
    // Explicitly closed is NOT the same as "no choice yet": a live run defaults
    // to open, so `false` here has to survive as a real value.
    expect(store().overrides.get("task-1")).toBe(false);
    expect(store().overrides.has("task-1")).toBe(true);
  });

  it("keeps tasks independent", () => {
    store().setOpen("task-1", true);
    store().setOpen("task-2", false);

    expect(store().overrides.get("task-1")).toBe(true);
    expect(store().overrides.get("task-2")).toBe(false);
  });

  it("clearOverride returns the task to its default", () => {
    store().setOpen("task-1", true);
    store().clearOverride("task-1");

    expect(store().overrides.has("task-1")).toBe(false);
  });

  it("keeps the same map reference for no-op writes", () => {
    store().setOpen("task-1", true);
    const before = store().overrides;

    store().setOpen("task-1", true);
    store().clearOverride("task-2");

    // Selectors read `overrides` directly, so a fresh Map on every no-op would
    // re-render every mounted fold on the page whenever any one of them is
    // toggled.
    expect(store().overrides).toBe(before);
  });

  it("allocates a new map for real writes so subscribers see the change", () => {
    const before = store().overrides;
    store().setOpen("task-1", true);
    expect(store().overrides).not.toBe(before);
  });
});
