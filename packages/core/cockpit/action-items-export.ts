import type { CockpitActionPage, CockpitMeetingAction } from "../types";

/** Collect one exact published version, not just the currently visible page. */
export async function collectCockpitActionItems(meetingId: string, versionId: string,
  load: (cursor?: string) => Promise<CockpitActionPage | null>): Promise<CockpitMeetingAction[]> {
  const items: CockpitMeetingAction[] = []; const seen = new Set<string>(); const cursors = new Set<string>();
  let cursor: string | undefined; let expected: number | undefined;
  do {
    const page = await load(cursor);
    if (!page || page.meeting_id !== meetingId || expected !== undefined && expected !== page.filtered_total) throw new Error("Action list changed; reload and export again.");
    expected = page.filtered_total;
    for (const item of page.items) {
      if (item.meeting_id !== meetingId || item.version_id !== versionId || seen.has(item.id)) throw new Error("Action export could not confirm its source.");
      seen.add(item.id); items.push(item);
    }
    cursor = page.next_cursor ?? undefined;
    if (cursor && (cursors.has(cursor) || page.items.length === 0)) throw new Error("Action export received an invalid continuation.");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  if (items.length !== expected) throw new Error("Action list changed; reload and export again.");
  return items;
}

/** CSV escaping also prevents user-authored titles becoming spreadsheet formulas. */
export function cockpitActionItemsCsv(items: CockpitMeetingAction[], headers: string[]): string {
  const cell = (value: string | number | null | undefined) => {
    const text = String(value ?? "");
    return `"${(/^[\s]*[=+\-@]/.test(text) ? "'" + text : text).replaceAll('"', '""')}"`;
  };
  const rows = items.map((item) => [item.title, item.description, item.source_quote, item.version_number,
    item.node_code, item.issue?.identifier, item.issue?.assignee_name, item.issue?.due_date, item.status]);
  return "﻿" + [headers, ...rows].map((row) => row.map(cell).join(",")).join("\r\n");
}
