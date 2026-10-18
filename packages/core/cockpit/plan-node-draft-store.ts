import { z } from "zod";
import { createDraftStore } from "../drafts/create-draft-store";
const command = z.object({ creation_key: z.string().uuid(), auto_code: z.literal(true), name: z.string(), parent_id: z.string().nullable(), project_id: z.string().nullable(), module_id: z.string().nullable(), status: z.string() });
const draft = z.object({ kind: z.enum(["project", "module", "task"]), name: z.string(), projectId: z.string(), moduleId: z.string(), parentId: z.string(), pending: command.nullable(), uncertain: z.boolean() });
const schema = z.object({ byScope: z.record(z.string(), draft) });
export type CockpitPlanNodeDraft = z.infer<typeof draft>;
export const EMPTY_COCKPIT_PLAN_NODE_DRAFT: CockpitPlanNodeDraft = { kind: "project", name: "", projectId: "", moduleId: "", parentId: "", pending: null, uncertain: false };
export const useCockpitPlanNodeDraftStore = createDraftStore<z.infer<typeof schema>>({ storageKey: "multica_cockpit_plan_node_drafts", emptyData: { byScope: {} },
  hasMeaningful: (value) => Object.values(value.byScope).some((entry) => Boolean(entry.name || entry.projectId || entry.moduleId || entry.parentId || entry.pending)),
  migrateData: (raw) => { const parsed = schema.safeParse(raw); return parsed.success ? parsed.data : { byScope: {} }; } });
export function updateCockpitPlanNodeDraft(key: string, patch: Partial<CockpitPlanNodeDraft>) {
  const state = useCockpitPlanNodeDraftStore.getState(); state.setDraft({ byScope: { ...state.draft.byScope, [key]: { ...(state.draft.byScope[key] ?? EMPTY_COCKPIT_PLAN_NODE_DRAFT), ...patch } } });
}
export function clearCockpitPlanNodeDraft(key: string, expected: CockpitPlanNodeDraft) {
  const state = useCockpitPlanNodeDraftStore.getState(); if (JSON.stringify(state.draft.byScope[key]) !== JSON.stringify(expected)) return;
  const byScope = { ...state.draft.byScope }; delete byScope[key]; state.setDraft({ byScope });
}
export function rejectCockpitPlanNodeDraft(key: string, expectedCommand: NonNullable<CockpitPlanNodeDraft["pending"]>, definite: boolean) {
  const state = useCockpitPlanNodeDraftStore.getState(); const current = state.draft.byScope[key];
  if (!current?.pending || JSON.stringify(current.pending) !== JSON.stringify(expectedCommand)) return;
  updateCockpitPlanNodeDraft(key, { pending: definite && !current.uncertain ? null : current.pending, uncertain: current.uncertain || !definite });
}
