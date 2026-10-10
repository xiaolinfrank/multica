import { create } from "zustand";
import { z } from "zod";
import { defaultStorage } from "../platform/storage";
import type { StorageAdapter } from "../types/storage";
import { registerDraftCleanup } from "../drafts/cleanup-registry";
import { CockpitSavedViewDefinitionSchema, type CockpitSavedViewDefinition } from "./saved-views";

export const COCKPIT_SAVED_VIEW_LIMIT = 30;
const entry = z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(80), definition: CockpitSavedViewDefinitionSchema, updatedAt: z.string().datetime() });
const envelope = z.object({ version: z.literal(1), items: z.array(entry).max(COCKPIT_SAVED_VIEW_LIMIT) });
export type CockpitSavedView = z.infer<typeof entry>;
export class CockpitSavedViewError extends Error {
  constructor(readonly code: "load" | "write" | "invalid" | "limit" | "duplicate" | "not_loaded") { super(code); }
}
const prefix = "multica_cockpit_saved_views";
export const cockpitSavedViewStorageKey = (userId: string, wsId: string) => `${prefix}:${encodeURIComponent(userId)}:${encodeURIComponent(wsId)}`;
interface SavedViewsState {
  namespaces: Record<string, { items: CockpitSavedView[]; loadFailed: boolean }>; generation: number;
  load: (userId: string, wsId: string) => void;
  save: (userId: string, wsId: string, name: string, definition: CockpitSavedViewDefinition, id?: string) => CockpitSavedView;
  rename: (userId: string, wsId: string, id: string, name: string) => void;
  remove: (userId: string, wsId: string, id: string) => void;
  reset: () => void;
}

/** Account/workspace namespaces can coexist across desktop tabs. Storage writes precede visible success. */
export function createCockpitSavedViewStore(storage: StorageAdapter) {
  return create<SavedViewsState>((set, get) => {
    const current = (userId: string, wsId: string) => {
      const key = cockpitSavedViewStorageKey(userId, wsId); const state = get().namespaces[key];
      if (!userId || !wsId || !state || state.loadFailed) throw new CockpitSavedViewError("not_loaded");
      return { key, items: state.items };
    };
    const write = (key: string, items: CockpitSavedView[]) => {
      const generation = get().generation;
      try { storage.setItem(key, JSON.stringify(envelope.parse({ version: 1, items }))); } catch { throw new CockpitSavedViewError("write"); }
      if (get().generation !== generation || !get().namespaces[key]) throw new CockpitSavedViewError("not_loaded");
      set((state) => ({ namespaces: { ...state.namespaces, [key]: { items, loadFailed: false } } }));
    };
    return { namespaces: {}, generation: 0,
      load: (userId, wsId) => {
        if (!userId || !wsId) return;
        const key = cockpitSavedViewStorageKey(userId, wsId);
        try { const raw = storage.getItem(key); const parsed = raw ? envelope.parse(JSON.parse(raw)) : { items: [] };
          set((state) => ({ namespaces: { ...state.namespaces, [key]: { items: parsed.items, loadFailed: false } } }));
        } catch { set((state) => ({ namespaces: { ...state.namespaces, [key]: { items: [], loadFailed: true } } })); }
      },
      save: (userId, wsId, name, definition, id) => {
        const { key, items } = current(userId, wsId); const parsed = entry.safeParse({ id: id ?? crypto.randomUUID(), name, definition, updatedAt: new Date().toISOString() });
        if (!parsed.success || (id && !items.some((item) => item.id === id))) throw new CockpitSavedViewError("invalid");
        if (items.some((item) => item.id !== id && item.name.toLowerCase() === parsed.data.name.toLowerCase())) throw new CockpitSavedViewError("duplicate");
        if (!id && items.length >= COCKPIT_SAVED_VIEW_LIMIT) throw new CockpitSavedViewError("limit");
        const next = id ? items.map((item) => item.id === id ? parsed.data : item) : [...items, parsed.data]; write(key, next); return parsed.data;
      },
      rename: (userId, wsId, id, name) => {
        const { items } = current(userId, wsId); const existing = items.find((item) => item.id === id); if (!existing) throw new CockpitSavedViewError("invalid");
        get().save(userId, wsId, name, existing.definition, id);
      },
      remove: (userId, wsId, id) => { const { key, items } = current(userId, wsId); write(key, items.filter((item) => item.id !== id)); },
      reset: () => set((state) => ({ namespaces: {}, generation: state.generation + 1 })),
    };
  });
}
export const useCockpitSavedViewStore = createCockpitSavedViewStore(defaultStorage);
// This registration resets memory only. Account-keyed preferences deliberately survive logout on this device.
registerDraftCleanup({ storageKey: prefix, workspaceScoped: false, resetInMemory: () => useCockpitSavedViewStore.getState().reset() });
