// @vitest-environment node
import { describe, expect, it } from "vitest";
import { moduleTitleNumberPrefix } from "./title-number";

describe("moduleTitleNumberPrefix", () => {
  it("takes the dotted outline number a title opens with", () => {
    expect(moduleTitleNumberPrefix("01.01 采样流程")).toBe("01.01");
    expect(moduleTitleNumberPrefix("1.2.3 Parser rewrite")).toBe("1.2.3");
  });

  it("does not need a space after the number", () => {
    expect(moduleTitleNumberPrefix("01.01采样流程")).toBe("01.01");
  });

  it("seeds a number, not a half-typed one", () => {
    expect(moduleTitleNumberPrefix("01.01. 采样流程")).toBe("01.01");
  });

  it("is empty for a title that carries no number", () => {
    expect(moduleTitleNumberPrefix("采样流程")).toBe("");
    expect(moduleTitleNumberPrefix("Parser rewrite")).toBe("");
    expect(moduleTitleNumberPrefix("")).toBe("");
    // The number has to open the title; one inside it is part of a sentence.
    expect(moduleTitleNumberPrefix("Phase 01.01")).toBe("");
  });

  it("tolerates leading whitespace", () => {
    expect(moduleTitleNumberPrefix("  02 需求")).toBe("02");
  });
});
