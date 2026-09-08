// @vitest-environment node
// Canonical grouping matrix for the versions panel. The component suite keeps
// the wiring; every boundary case lives here.

import { describe, expect, it } from "vitest";
import type { CockpitSnapshot } from "@multica/core/types/cockpit";
import { groupVersionHistory } from "./group-snapshots";

function snap(over: Partial<CockpitSnapshot>): CockpitSnapshot {
  return {
    id: "id",
    trigger_kind: "auto",
    label: "",
    node_count: 1,
    created_by_type: "member",
    created_by_label: "demo",
    created_at: "2026-09-08T10:00:00+08:00",
    ...over,
  };
}

describe("groupVersionHistory", () => {
  it("returns nothing for an empty history", () => {
    expect(groupVersionHistory([])).toEqual([]);
  });

  it("keeps a lone auto checkpoint as a single row", () => {
    const entries = groupVersionHistory([snap({ id: "a" })]);
    expect(entries).toEqual([{ kind: "single", snapshot: snap({ id: "a" }) }]);
  });

  it("collapses consecutive autos by the same actor into one run, order kept", () => {
    const entries = groupVersionHistory([
      snap({ id: "a", created_at: "10:00" }),
      snap({ id: "b", created_at: "09:55" }),
      snap({ id: "c", created_at: "09:50" }),
    ]);
    expect(entries).toEqual([
      { kind: "run", run: { snapshots: [snap({ id: "a", created_at: "10:00" }), snap({ id: "b", created_at: "09:55" }), snap({ id: "c", created_at: "09:50" })], actor: "demo" } },
    ]);
  });

  it("never collapses non-auto triggers", () => {
    const entries = groupVersionHistory([
      snap({ id: "m1", trigger_kind: "manual" }),
      snap({ id: "m2", trigger_kind: "manual" }),
      snap({ id: "i1", trigger_kind: "import" }),
    ]);
    expect(entries.every((e) => e.kind === "single")).toBe(true);
  });

  it("separates runs by actor", () => {
    const entries = groupVersionHistory([
      snap({ id: "a1", created_by_label: "demo" }),
      snap({ id: "a2", created_by_label: "mika" }),
    ]);
    // Different actors back to back: no run of two.
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.kind === "single")).toBe(true);
  });

  it("breaks a run at a milestone and groups both sides separately", () => {
    const entries = groupVersionHistory([
      snap({ id: "a2" }),
      snap({ id: "m", trigger_kind: "manual", label: "评审前" }),
      snap({ id: "a1" }),
    ]);
    expect(entries).toEqual([
      { kind: "single", snapshot: snap({ id: "a2" }) },
      { kind: "single", snapshot: snap({ id: "m", trigger_kind: "manual", label: "评审前" }) },
      { kind: "single", snapshot: snap({ id: "a1" }) },
    ]);
  });

  it("groups a run that ends the history", () => {
    const entries = groupVersionHistory([
      snap({ id: "m", trigger_kind: "import" }),
      snap({ id: "a1" }),
      snap({ id: "a2" }),
    ]);
    expect(entries.map((e) => e.kind)).toEqual(["single", "run"]);
  });
});
