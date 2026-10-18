// @vitest-environment node
import { describe, expect, it } from "vitest";
import { canChooseCockpitAssignee } from "./assignee-availability";
const activeAgent = { type: "agent", status: "idle", runtime_bound: true, can_assign: true, reason: "" };
describe("cockpit planning assignee eligibility", () => {
  it("keeps scheduling distinct from immediate runtime availability", () => {
    expect(canChooseCockpitAssignee({ ...activeAgent, status: "offline" })).toBe(true);
    expect(canChooseCockpitAssignee({ ...activeAgent, status: "working" })).toBe(true);
    expect(canChooseCockpitAssignee({ type: "member", status: "active", runtime_bound: null, can_assign: true, reason: "" })).toBe(true);
  });
  it("requires corroborating identity, status, runtime and permission facts instead of trusting a single capability flag", () => {
    for (const patch of [{ runtime_bound: false }, { runtime_bound: null }, { status: "future_status" }, { type: "future_type" }, { reason: "invocation_denied" }, { can_assign: false }]) expect(canChooseCockpitAssignee({ ...activeAgent, ...patch })).toBe(false);
    expect(canChooseCockpitAssignee({ ...activeAgent, type: "member", status: "archived" })).toBe(false);
    expect(canChooseCockpitAssignee({ ...activeAgent, type: "squad", status: "active", runtime_bound: null })).toBe(false);
    expect(canChooseCockpitAssignee({ ...activeAgent, type: "squad", status: "active", runtime_bound: true })).toBe(true);
  });
});
