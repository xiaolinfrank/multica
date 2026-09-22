// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cockpitNodeIssueFiling, type CockpitFilingModule } from "./node-filing";

const MODULES: CockpitFilingModule[] = [
  { id: "m-0101", project_id: "p-01", title: "01.01 回顾性队列数据集（JIA）" },
  { id: "m-0102", project_id: "p-01", title: "01.02 前瞻性队列数据集（JIA）" },
  { id: "m-0401", project_id: "p-04", title: "04.01 确权线" },
  { id: "m-0600", project_id: "p-06", title: "06.00 平台治理与制度" },
  { id: "m-none", project_id: "p-01", title: "会议相关" },
];

describe("cockpitNodeIssueFiling", () => {
  it("files a task row into the module its number names", () => {
    expect(cockpitNodeIssueFiling("01.01.03", MODULES)).toEqual({
      project_id: "p-01",
      module_id: "m-0101",
      title: "01.01.03",
    });
  });

  it("seeds the title with the row's own code, not the module's", () => {
    expect(cockpitNodeIssueFiling("04.01.01", MODULES)?.title).toBe("04.01.01");
  });

  it("keeps a governance line's published number", () => {
    // "06.00" is a stored code the display numbering honors, so its tasks read
    // 06.00.01 and belong to the module of the same name.
    expect(cockpitNodeIssueFiling("06.00.02", MODULES)?.module_id).toBe("m-0600");
  });

  it("does not file a direction row, whose number names a project", () => {
    expect(cockpitNodeIssueFiling("01.01", MODULES)).toBeNull();
  });

  it("does not file a mainline row", () => {
    expect(cockpitNodeIssueFiling("01", MODULES)).toBeNull();
  });

  it("does not guess when the number names no module", () => {
    expect(cockpitNodeIssueFiling("09.09.01", MODULES)).toBeNull();
  });

  it("does not guess when the number names more than one module", () => {
    const ambiguous = [...MODULES, { id: "m-dup", project_id: "p-09", title: "01.01 旧版" }];
    expect(cockpitNodeIssueFiling("01.01.03", ambiguous)).toBeNull();
  });

  it("ignores codes the programme numbers some other way", () => {
    expect(cockpitNodeIssueFiling("L3-01-08", MODULES)).toBeNull();
    expect(cockpitNodeIssueFiling("AI-05-01", MODULES)).toBeNull();
    expect(cockpitNodeIssueFiling("", MODULES)).toBeNull();
  });
});
