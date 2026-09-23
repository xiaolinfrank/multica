// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cockpitNodeIssueFiling, cockpitStoredDirectionCode, type CockpitFilingModule } from "./node-filing";
import type { CockpitNode } from "../types";

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
    // Regression: a stored key naming the same-numbered module must not reopen
    // the row — a direction is never a work item.
    expect(cockpitNodeIssueFiling("01.01", MODULES, "01.01")).toBeNull();
    expect(cockpitNodeIssueFiling("06.00", MODULES, "06.00")).toBeNull();
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
  // The v1.2 summary merge renumbers the display tree without touching stored
  // direction codes; the module list follows the shipped display numbering.
  describe("with the stored direction code as cross-check", () => {
    // The shipped numbering after the 02.02-09 merge: one module per L2 row.
    const MERGED: CockpitFilingModule[] = [
      { id: "m-0201", project_id: "p-02", title: "02.01 基础设施与算力服务" },
      { id: "m-0202", project_id: "p-02", title: "02.02 平台架构与开发" },
      { id: "m-0203", project_id: "p-02", title: "02.03 院端一体机与部署" },
      { id: "m-0204", project_id: "p-02", title: "02.04 测试与质量保障" },
    ];

    it("files a merged-group task into the group module (display key wins, stored side merged away)", () => {
      // A task stored under direction 02.05 displays as 02.02.05; its stored
      // module is gone after the merge, so the display number files it.
      expect(cockpitNodeIssueFiling("02.02.05", MERGED, "02.05")).toEqual({
        project_id: "p-02",
        module_id: "m-0202",
        title: "02.02.05",
      });
    });

    it("files a renamed-direction task by its display number", () => {
      // Stored 02.10 displays as 02.03.01; the merged module list titles 02.03.
      expect(cockpitNodeIssueFiling("02.03.01", MERGED, "02.10")?.module_id).toBe("m-0203");
    });

    it("withholds when the two keys name different modules (numbering drifted)", () => {
      // Pre-alignment drift: display 02.03.01 → module 02.03 (数据资产), while
      // the row's true direction 02.10 → module 02.10 (院端). Filing either way
      // could be silently wrong, so the entry point withdraws.
      const drifted = [
        ...MERGED.filter((m) => m.id !== "m-0203"),
        { id: "m-0203-old", project_id: "p-02", title: "02.03 数据与资产管理平台" },
        { id: "m-0210", project_id: "p-02", title: "02.10 院端节点与部署" },
      ];
      expect(cockpitNodeIssueFiling("02.03.01", drifted, "02.10")).toBeNull();
    });

    it("falls back to the stored direction code when the display number names nothing", () => {
      // A module list not yet re-cut: only the original numbering exists.
      const original = [
        { id: "m-0210", project_id: "p-02", title: "02.10 院端节点与部署" },
      ];
      expect(cockpitNodeIssueFiling("02.03.01", original, "02.10")?.module_id).toBe("m-0210");
    });

    it("lets the unambiguous key answer when the other is ambiguous", () => {
      const ambiguous = [
        { id: "m-0203a", project_id: "p-02", title: "02.03 一版" },
        { id: "m-0203b", project_id: "p-02", title: "02.03 二版" },
        { id: "m-0210", project_id: "p-02", title: "02.10 院端节点与部署" },
      ];
      // Display number 02.03 names two modules; the stored direction 02.10
      // names one — the unambiguous key answers.
      expect(cockpitNodeIssueFiling("02.03.01", ambiguous, "02.10")?.module_id).toBe("m-0210");
    });

    it("keeps agreeing rows exactly as before (no stored code needed)", () => {
      expect(cockpitNodeIssueFiling("02.01.01", MERGED, "02.01")?.module_id).toBe("m-0201");
      expect(cockpitNodeIssueFiling("02.01.01", MERGED)?.module_id).toBe("m-0201");
    });
  });
});

describe("cockpitStoredDirectionCode", () => {
  const n = (id: string, code: string, parent_id: string | null): CockpitNode => ({
    id,
    code,
    parent_id,
    cockpit_id: "cp",
    name: code,
    position: 0,
    color: "",
    owner: "",
    collaborators: "",
    start_date: null,
    end_date: null,
    status: "",
    progress: 0,
    deliverable: "",
    dependencies: "",
    note: "",
    current_progress: "",
    vendor: "",
    budget_category: "",
    budget_amount: null,
    exec_status: "",
    contract: "",
    source: "",
    updated_by_type: "",
    updated_by_id: null,
    created_at: "",
    updated_at: "",
  });
  const nodes = [
    n("l1", "L1-02", null),
    n("dir", "02.10", "l1"),
    n("task", "L3-02-16", "dir"),
    n("deep", "L4-02-16-01", "task"),
  ];
  const byId = new Map(nodes.map((x) => [x.id, x]));

  it("climbs from a task to its direction's stored code", () => {
    expect(cockpitStoredDirectionCode(nodes[2]!, byId)).toBe("02.10");
  });

  it("climbs through deeper nesting", () => {
    expect(cockpitStoredDirectionCode(nodes[3]!, byId)).toBe("02.10");
  });

  it("gives a direction row itself null — it hangs under a mainline, not a direction", () => {
    expect(cockpitStoredDirectionCode(nodes[1]!, byId)).toBeNull();
    expect(cockpitStoredDirectionCode(nodes[0]!, byId)).toBeNull();
  });

  it("terminates on a parent cycle instead of spinning", () => {
    const loop = [n("x", "L3-99-01", "y"), n("y", "L3-99-02", "x")];
    const loopById = new Map(loop.map((x) => [x.id, x]));
    expect(cockpitStoredDirectionCode(loop[0]!, loopById)).toBeNull();
  });
});

