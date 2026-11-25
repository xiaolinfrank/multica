// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  compareOptionalCode,
  formatCodedTitle,
  formatModuleTitle,
  formatProjectTitle,
  sortByCode,
} from "./coded-title";

describe("formatCodedTitle", () => {
  it("prefixes code before clean title", () => {
    expect(formatCodedTitle("01", "高质量数据集")).toBe("01 高质量数据集");
    expect(formatCodedTitle("01.01", "回顾性队列数据集（JIA）")).toBe("01.01 回顾性队列数据集（JIA）");
    expect(formatProjectTitle({ code: "06", title: "项目管理与规划" })).toBe("06 项目管理与规划");
    expect(formatModuleTitle({ code: "06.00", title: "平台治理与制度" })).toBe("06.00 平台治理与制度");
  });

  it("returns bare title when code is missing or blank", () => {
    expect(formatCodedTitle(null, "Launch Command Center")).toBe("Launch Command Center");
    expect(formatCodedTitle(undefined, "Launch Command Center")).toBe("Launch Command Center");
    expect(formatCodedTitle("   ", "Launch Command Center")).toBe("Launch Command Center");
    expect(formatProjectTitle(null)).toBe("");
  });

  it("does not duplicate an existing code prefix on unreconciled titles", () => {
    expect(formatCodedTitle("01", "01高质量数据集")).toBe("01高质量数据集");
    expect(formatCodedTitle("01", "01 高质量数据集")).toBe("01 高质量数据集");
    expect(formatCodedTitle("01.02", "01.02 Docking")).toBe("01.02 Docking");
    expect(formatCodedTitle("01", "01")).toBe("01");
  });

  it("still prefixes when title begins with a longer numeric token", () => {
    expect(formatCodedTitle("01", "01.02 子项")).toBe("01 01.02 子项");
    expect(formatCodedTitle("01", "010 编号")).toBe("01 010 编号");
  });
});

describe("sortByCode", () => {
  it("preserves original order when no item carries a code", () => {
    const items: Array<{ id: string; code?: string | null }> = [{ id: "b" }, { id: "a" }];
    expect(sortByCode(items)).toBe(items);
  });

  it("orders coded items naturally ahead of uncoded items", () => {
    const items = [
      { id: "u1", code: null },
      { id: "p10", code: "10" },
      { id: "p2", code: "02" },
      { id: "p1", code: "01" },
      { id: "u2" },
    ];
    expect(sortByCode(items).map((i) => i.id)).toEqual(["p1", "p2", "p10", "u1", "u2"]);
    expect(compareOptionalCode("01.02", "01.10")).toBeLessThan(0);
  });
});
