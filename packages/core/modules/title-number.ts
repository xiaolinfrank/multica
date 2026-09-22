/**
 * The outline number a module's title starts with, or "" when it has none.
 *
 * Teams that number their modules ("01.01 采样流程") number the work inside them
 * the same way ("01.01.03 …"), so creating an issue under such a module starts
 * the title from the module's number instead of from an empty field. The user
 * types the separator and the rest, which is why no trailing dot is added: the
 * seed is a number, not a half-typed one.
 *
 * The rule is deliberately plain — a leading run of digits, optionally dotted,
 * that is not the start of a longer number. A title like "2026 年计划" therefore
 * seeds "2026", which is a wrong guess but one keystroke to undo; the
 * alternative, demanding a shape, would fail the unspaced titles ("01.01采样")
 * that are just as common.
 */
export function moduleTitleNumberPrefix(title: string): string {
  const match = /^\s*(\d+(?:\.\d+)*)\.?(?!\d)/.exec(title);
  return match ? match[1]! : "";
}
