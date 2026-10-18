import type { CockpitInputListQuery } from "../types/cockpit-input";

/** Translate typed command fields, never the contents of strings or files. */
export function cockpitInputBody(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cockpitInputBody);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [
    key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), cockpitInputBody(item),
  ]));
}

export function cockpitInputSearch(query: CockpitInputListQuery = {}): string {
  const search = new URLSearchParams();
  const size = query.pageSize ?? 25;
  search.set("page_size", String(Number.isInteger(size) ? Math.min(100, Math.max(1, size)) : 25));
  for (const [key, value] of Object.entries(query)) {
    if (key === "pageSize" || value === undefined || value === "") continue;
    const name = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    if (Array.isArray(value)) value.forEach((id) => search.append(name, id));
    else search.set(name, String(value));
  }
  return `?${search}`;
}
