"use client";

/**
 * WorkspaceCodeView — line-numbered, syntax-highlighted read-only view of a
 * workspace text file, built for the file explorer's preview pane.
 *
 * Why not reuse CodeBlockStatic: its `pre.rich-text-editor` gets `overflow-x:
 * auto` from code.css, which fights a viewport-level scroll and parks the
 * horizontal scrollbar at the bottom of a tall block instead of the visible
 * edge. Here the OUTER container owns both scroll axes, a sticky gutter keeps
 * line numbers in place during horizontal scroll, and wrap mode keeps numbers
 * aligned per logical line (each line is its own flex row).
 *
 * Highlighting reuses lowlight + the shared `.hljs-*` palette from
 * editor/styles/code.css. The wrapper carries `rich-text-editor` only to scope
 * those colour classes; every node we render is a <div>/<span>, never an element
 * the prose/code/media rules target, so no editor typography leaks in.
 */

import { useMemo } from "react";
import { createLowlight, common } from "lowlight";
import { toHtml } from "hast-util-to-html";
import { cn } from "@multica/ui/lib/utils";
import "../../editor/styles/code.css";

const lowlight = createLowlight(common);

// Derive the hast node type from lowlight's own return type so we don't take a
// direct dependency on the `hast` package (phantom-dep / no-extraneous rule).
type HastRoot = ReturnType<typeof lowlight.highlight>;
type HastNode = HastRoot["children"][number];

// Split highlighted hast nodes into per-line node lists. An element whose text
// crosses a newline (block comment, multi-line string) is re-emitted on each
// line it spans, so every visual line stays independently styled and closed.
function splitHastLines(nodes: HastNode[]): HastNode[][] {
  const lines: HastNode[][] = [[]];
  const push = (n: HastNode) => lines[lines.length - 1]!.push(n);
  for (const node of nodes) {
    if (node.type === "text") {
      const parts = node.value.split("\n");
      parts.forEach((part, i) => {
        if (i > 0) lines.push([]);
        if (part) push({ type: "text", value: part });
      });
    } else if (node.type === "element") {
      const childLines = splitHastLines(node.children as HastNode[]);
      childLines.forEach((children, i) => {
        if (i > 0) lines.push([]);
        push({ ...node, children } as HastNode);
      });
    }
  }
  return lines;
}

export function WorkspaceCodeView({
  content,
  language,
  wrap,
}: {
  content: string;
  language: string | undefined;
  wrap: boolean;
}) {
  const lines = useMemo(() => {
    // Normalize CRLF so a Windows-encoded file doesn't keep a stray \r on every
    // line, and strip a single trailing newline (matches CodeBlockStatic) so the
    // view doesn't show a spurious empty last line while preserving real blanks.
    const code = content.replace(/\r\n?/g, "\n").replace(/\n$/, "");
    let nodes: HastNode[];
    try {
      const tree = language
        ? lowlight.highlight(language, code)
        : lowlight.highlightAuto(code);
      nodes = tree.children;
    } catch {
      // Unknown language tag — render as a single plain text node.
      nodes = [{ type: "text", value: code }];
    }
    return splitHastLines(nodes).map((line) => toHtml(line));
  }, [content, language]);

  // Gutter width grows with the line count so 4-digit files stay aligned.
  const gutterCh = Math.max(2, String(lines.length).length);

  return (
    <div className="h-full overflow-auto bg-card">
      <div
        className={cn(
          "rich-text-editor py-1 font-mono text-[0.8125rem] leading-[1.6]",
          wrap ? "w-full" : "w-max min-w-full",
        )}
      >
        {lines.map((html, i) => (
          <div key={i} className="flex w-full hover:bg-accent/40">
            <span
              aria-hidden
              className="sticky left-0 z-10 shrink-0 select-none border-r border-border bg-card px-2 text-right text-muted-foreground/60"
              style={{ minWidth: `calc(${gutterCh}ch + 1rem)` }}
            >
              {i + 1}
            </span>
            <span
              className={cn(
                "px-3",
                wrap ? "min-w-0 flex-1 whitespace-pre-wrap break-words" : "whitespace-pre",
              )}
              dangerouslySetInnerHTML={{ __html: html || " " }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
