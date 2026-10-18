import type { CockpitDirectoryPageQuery, CockpitDirectoryReceipt, CockpitDirectoryWrite } from "../types/cockpit-directory";
export function normalizedCockpitDirectoryQuery(query: CockpitDirectoryPageQuery) {
  if (query.party !== undefined && query.parties !== undefined) throw new Error("Choose party or parties");
  return { q: query.q?.trim() ?? "", party: query.party?.trim() ?? null,
    parties: !query.parties?.length ? null : [...new Set(query.parties.map((value) => value.trim()))].sort(),
    page_size: query.page_size ?? 25 };
}
export const cockpitDirectoryNaturalKey = (entry: { party: string; name: string }) => JSON.stringify([entry.party, entry.name]);
export function cockpitDirectoryWriteAcknowledged(receipt: CockpitDirectoryReceipt | null, wsId: string, body: CockpitDirectoryWrite) {
  if (!receipt || receipt.workspace_id !== wsId || receipt.scope !== "workspace" || receipt.action !== "upserted" || receipt.deleted.length) return false;
  const expected = new Map<string, string | undefined>();
  for (const entry of body.entries) {
    const key = cockpitDirectoryNaturalKey({ party: entry.party.trim(), name: entry.name.trim() });
    const position = entry.position?.trim();
    if (!expected.has(key)) expected.set(key, undefined);
    if (entry.clear_position) expected.set(key, "");
    else if (position) expected.set(key, position);
  }
  const seen = new Set<string>();
  for (const entry of receipt.entries) {
    const key = cockpitDirectoryNaturalKey(entry);
    if (!expected.has(key) || seen.has(key) || (expected.get(key) !== undefined && expected.get(key) !== entry.position)) return false;
    seen.add(key);
  }
  for (const entry of receipt.skipped) {
    const key = cockpitDirectoryNaturalKey(entry);
    if (!body.only_unknown_names || !expected.has(key) || seen.has(key)) return false;
    seen.add(key);
  }
  return seen.size === expected.size;
}
