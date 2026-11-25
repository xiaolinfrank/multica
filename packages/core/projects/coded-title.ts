/**
 * Format a project or module's plan code together with its title
 * ("01 高质量数据集" / "01.01 回顾性队列数据集（JIA）").
 *
 * Avoids duplicating the prefix when an unreconciled title already begins with
 * the same code (e.g. `code="01"`, `title="01高质量数据集"`), while still
 * prefixing when the title starts with a longer numeric token (e.g. `code="01"`
 * and `title="01.02..."`).
 */
export function formatCodedTitle(
  code: string | null | undefined,
  title: string | null | undefined,
): string {
  const cleanCode = code?.trim() ?? "";
  const cleanTitle = title?.trim() ?? "";
  if (!cleanCode) return cleanTitle;
  if (!cleanTitle) return cleanCode;
  if (cleanTitle.startsWith(cleanCode)) {
    const next = cleanTitle[cleanCode.length];
    if (next === undefined || !/[0-9.]/.test(next)) {
      return cleanTitle;
    }
  }
  return `${cleanCode} ${cleanTitle}`;
}

export function formatProjectTitle(
  project: { code?: string | null; title: string } | null | undefined,
): string {
  if (!project) return "";
  return formatCodedTitle(project.code, project.title);
}

export function formatModuleTitle(
  module: { code?: string | null; title: string } | null | undefined,
): string {
  if (!module) return "";
  return formatCodedTitle(module.code, module.title);
}

/**
 * Natural dotted-code comparator placing coded items ahead of uncoded items.
 * Returns 0 when neither item carries a code so callers keep original ordering.
 */
export function compareOptionalCode(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const ca = a?.trim() ?? "";
  const cb = b?.trim() ?? "";
  if (!ca && !cb) return 0;
  if (!ca) return 1;
  if (!cb) return -1;
  return ca.localeCompare(cb, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Return a code-sorted copy when at least one item carries a code, otherwise
 * preserve the input order untouched.
 */
export function sortByCode<T extends { code?: string | null }>(items: readonly T[]): T[] {
  if (items.length <= 1 || !items.some((item) => Boolean(item.code?.trim()))) {
    return items as T[];
  }
  return [...items].sort((a, b) => compareOptionalCode(a.code, b.code));
}
