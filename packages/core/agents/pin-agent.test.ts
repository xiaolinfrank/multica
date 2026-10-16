// @vitest-environment node
import { describe, it, expect } from "vitest";
import { groupChatAgentsBySeat, orderChatAgentsBySeat, pinAgentByName } from "./pin-agent";

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

describe("orderChatAgentsBySeat", () => {
  const seat = (id: string, name: string, systemKey?: string) => ({
    id,
    name,
    system_key: systemKey ?? null,
  });

  it("puts Mika first, the host generic agent second, and keeps the rest in order", () => {
    const agents = [
      seat("g3", "通用智能体 3"),
      seat("lit", "文献调研员"),
      seat("host", "通用智能体（主）"),
      seat("mika", "Mika", "mika"),
      seat("g1", "通用智能体 1"),
    ];
    expect(orderChatAgentsBySeat(agents).map((a) => a.id)).toEqual([
      "mika",
      "host",
      "g3",
      "lit",
      "g1",
    ]);
  });

  it("keeps Mika first even when the generic agent was pinned first", () => {
    const agents = [
      seat("g3", "通用智能体 3"),
      seat("host", "通用智能体（主）"),
      seat("mika", "Mika", "mika"),
    ];
    const pinnedFirst = orderChatAgentsBySeat(pinAgentByName(agents, "通用智能体（主）"));
    expect(pinnedFirst.map((a) => a.id)).toEqual(["mika", "host", "g3"]);
  });

  it("is a stable no-op-shaped sort when neither seat is present", () => {
    const agents = [seat("a", "Alpha"), seat("b", "Beta")];
    expect(orderChatAgentsBySeat(agents).map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("never mutates the input array", () => {
    const agents = [seat("b", "Beta"), seat("mika", "Mika", "mika")];
    const before = agents.map((a) => a.id);
    orderChatAgentsBySeat(agents);
    expect(agents.map((a) => a.id)).toEqual(before);
  });
});

describe("groupChatAgentsBySeat", () => {
  it("keeps renamed Mika and the generic agent before both ownership groups without duplicating them", () => {
    const agents = [
      { name: "Mine", owner_id: "user" },
      { name: "Other", owner_id: "other" },
      { name: "通用智能体（主）", owner_id: "user" },
      { name: "Chief of Staff", system_key: "mika", owner_id: "other" },
    ];
    const grouped = groupChatAgentsBySeat(agents, "user");
    expect(grouped.preferred.map((a) => a.name)).toEqual(["Chief of Staff", "通用智能体（主）"]);
    expect(grouped.mine.map((a) => a.name)).toEqual(["Mine"]);
    expect(grouped.others.map((a) => a.name)).toEqual(["Other"]);
    expect([...grouped.preferred, ...grouped.mine, ...grouped.others]).toHaveLength(agents.length);
  });

  it("does not promote unrelated agents whose names end with the host suffix", () => {
    const agents = [
      { name: "Reviewer（主）", owner_id: "user" },
      { name: "通用智能体", owner_id: "other" },
    ];
    const grouped = groupChatAgentsBySeat(agents, "user");
    expect(grouped.preferred.map((a) => a.name)).toEqual(["通用智能体"]);
    expect(grouped.mine.map((a) => a.name)).toEqual(["Reviewer（主）"]);
  });
});
