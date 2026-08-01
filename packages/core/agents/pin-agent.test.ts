import { describe, it, expect } from "vitest";
import { pinAgentByName } from "./pin-agent";

const agents = [
  { id: "a1", name: "通用智能体 1" },
  { id: "a2", name: "通用智能体 2" },
  { id: "host", name: "通用智能体（主）" },
  { id: "b1", name: "别的智能体" },
];

describe("pinAgentByName", () => {
  it("moves the named agent to the front, preserving the rest", () => {
    const out = pinAgentByName(agents, "通用智能体（主）");
    expect(out.map((a) => a.id)).toEqual(["host", "a1", "a2", "b1"]);
  });

  it("returns input order when the name is absent", () => {
    const out = pinAgentByName(agents, "通用智能体（不存在）");
    expect(out.map((a) => a.id)).toEqual(["a1", "a2", "host", "b1"]);
  });

  it("returns input order when pinnedName is empty or nullish", () => {
    expect(pinAgentByName(agents, "").map((a) => a.id)).toEqual(["a1", "a2", "host", "b1"]);
    expect(pinAgentByName(agents, undefined).map((a) => a.id)).toEqual(["a1", "a2", "host", "b1"]);
  });

  it("is a no-op when the named agent is already first", () => {
    const out = pinAgentByName(agents, "通用智能体 1");
    expect(out.map((a) => a.id)).toEqual(["a1", "a2", "host", "b1"]);
  });

  it("never mutates the input array", () => {
    const before = agents.map((a) => a.id);
    pinAgentByName(agents, "通用智能体（主）");
    expect(agents.map((a) => a.id)).toEqual(before);
  });

  it("tolerates elements without a name", () => {
    const mixed = [{ id: "x" }, { id: "host", name: "通用智能体（主）" }];
    expect(pinAgentByName(mixed, "通用智能体（主）").map((a) => a.id)).toEqual(["host", "x"]);
  });
});
