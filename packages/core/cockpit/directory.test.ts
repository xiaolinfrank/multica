// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { CockpitDirectoryEntry } from "../types";
import {
  cockpitDirectoryAutoSaveEntries,
  cockpitDirectoryGroups,
  cockpitDirectoryNames,
  cockpitDirectoryParties,
  cockpitDirectoryPosition,
  cockpitDirectoryUnaffiliated,
} from "./directory";

const book: CockpitDirectoryEntry[] = [
  { party: "深圳联通", name: "李明玉", position: "", source: "seed" },
  { party: "深圳联通", name: "冯延虎", position: "数据要素运营经理", source: "seed" },
  { party: "深圳联通", name: "罗沂", position: "医疗 BU 总经理", source: "seed" },
  { party: "华为", name: "黄支学", position: "方案负责人", source: "seed" },
  { party: "华为", name: "刘云珂", position: "", source: "seed" },
  { party: "", name: "黄晓韵", position: "PI", source: "seed" },
  // The same name at two units is legal; the meeting's own parties decide.
  { party: "华大基因", name: "刘欢欢", position: "", source: "user" },
  { party: "复星医药", name: "刘欢欢", position: "项目经理", source: "user" },
];

describe("cockpitDirectoryParties", () => {
  it("lists the units alphabetically, without the unaffiliated bucket", () => {
    expect(cockpitDirectoryParties(book)).toEqual(["复星医药", "华大基因", "华为", "深圳联通"]);
  });
});

describe("cockpitDirectoryNames", () => {
  it("dedupes names across units", () => {
    expect(cockpitDirectoryNames(book)).toContain("刘欢欢");
    expect(cockpitDirectoryNames(book).filter((n) => n === "刘欢欢")).toHaveLength(1);
  });
});

describe("cockpitDirectoryGroups", () => {
  it("puts the meeting's own parties first, in the field's order", () => {
    const groups = cockpitDirectoryGroups(book, ["深圳联通", "华为"]);
    expect(groups.map((g) => g.party)).toEqual(["深圳联通", "华为", "复星医药", "华大基因"]);
    expect(groups[0]?.entries.map((e) => e.name)).toEqual(["冯延虎", "李明玉", "罗沂"]);
  });

  it("skips a chosen party the book does not know", () => {
    const groups = cockpitDirectoryGroups(book, ["数鑫科技", "华为"]);
    expect(groups.map((g) => g.party)).toEqual(["华为", "复星医药", "华大基因", "深圳联通"]);
  });

  it("never groups the unaffiliated contacts", () => {
    const groups = cockpitDirectoryGroups(book, []);
    expect(groups.flatMap((g) => g.entries).map((e) => e.name)).not.toContain("黄晓韵");
    expect(cockpitDirectoryUnaffiliated(book).map((e) => e.name)).toEqual(["黄晓韵"]);
  });
});

describe("cockpitDirectoryPosition", () => {
  it("answers from the meeting's own party when the name is known twice", () => {
    expect(cockpitDirectoryPosition(book, "刘欢欢", ["复星医药"])).toBe("项目经理");
    expect(cockpitDirectoryPosition(book, "刘欢欢", ["华大基因"])).toBe("");
  });

  it("falls back to the first known position without party context", () => {
    expect(cockpitDirectoryPosition(book, "刘欢欢")).toBe("项目经理");
    expect(cockpitDirectoryPosition(book, "李明玉")).toBe("");
    expect(cockpitDirectoryPosition(book, " nobody ")).toBe("");
  });
});

describe("cockpitDirectoryAutoSaveEntries", () => {
  it("files unknown attendees under the meeting's only party", () => {
    const fresh = cockpitDirectoryAutoSaveEntries(book, "深圳联通", "李明玉、王新");
    expect(fresh).toEqual([{ party: "深圳联通", name: "王新", position: "", source: "user" }]);
  });

  it("attributes nothing when two units sat at the table", () => {
    expect(cockpitDirectoryAutoSaveEntries(book, "深圳联通、华为", "王新")).toEqual([]);
  });

  it("never duplicates a name the book already knows under another unit", () => {
    expect(cockpitDirectoryAutoSaveEntries(book, "复星医药", "李明玉")).toEqual([]);
  });
});
