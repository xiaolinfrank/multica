import { describe, it, expect } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { WorkspaceCodeView } from "./workspace-code-view";

afterEach(() => cleanup());

describe("WorkspaceCodeView", () => {
  it("renders one gutter row per logical line — blanks and multi-line spans included", () => {
    // The block comment is a single highlighted span that crosses two lines;
    // the splitter must re-emit it per line so the count stays correct.
    const content = "const a = 1;\n/* multi\nline */\n\nconst b = 2;";
    const { container } = render(
      <WorkspaceCodeView content={content} language="javascript" wrap={false} />,
    );
    const rows = container.querySelectorAll(".rich-text-editor > div");
    expect(rows.length).toBe(5);
    expect(container.textContent).toContain("const a = 1;");
    expect(container.textContent).toContain("const b = 2;");
  });

  it("normalizes CRLF and keeps genuine trailing blank lines (strips only one)", () => {
    // CRLF endings + two trailing blank lines. After CRLF→LF and stripping a
    // single trailing newline, the logical lines are: "a", "b", "" → 3 rows,
    // and no stray carriage return survives in the text.
    const content = "a\r\nb\r\n\r\n";
    const { container } = render(
      <WorkspaceCodeView content={content} language="plaintext" wrap={false} />,
    );
    expect(container.querySelectorAll(".rich-text-editor > div").length).toBe(3);
    expect(container.textContent).not.toContain("\r");
  });

  it("falls back to plain text (no crash) on an unknown language", () => {
    const { container } = render(
      <WorkspaceCodeView content={"x\ny"} language="not-a-real-lang" wrap />,
    );
    expect(container.querySelectorAll(".rich-text-editor > div").length).toBe(2);
  });
});
