import type { CockpitDirectoryEntry } from "./cockpit";
export interface CockpitDirectoryPageQuery {
  q?: string; party?: string; parties?: string[]; cursor?: string; page_size?: number;
}
export interface CockpitDirectoryPage {
  workspace_id: string; scope: "workspace"; q: string; party: string | null; parties: string[] | null;
  items: CockpitDirectoryEntry[]; total: number; next_cursor: string | null;
}
export interface CockpitDirectoryNaturalKey { party: string; name: string }
export interface CockpitDirectoryWriteEntry extends CockpitDirectoryNaturalKey { position?: string; clear_position?: boolean }
export interface CockpitDirectoryWrite { entries: CockpitDirectoryWriteEntry[]; only_unknown_names?: boolean }
export interface CockpitDirectoryReceipt {
  workspace_id: string; scope: "workspace"; action: "upserted" | "deleted";
  entries: CockpitDirectoryEntry[]; skipped: CockpitDirectoryNaturalKey[]; deleted: CockpitDirectoryNaturalKey[];
}
