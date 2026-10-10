import { z } from "zod";
import { createDraftStore } from "../drafts/create-draft-store";
import type { CockpitAcceptanceCriterionInput, CockpitAcceptanceRequestCreate } from "../types/cockpit-artifacts";

const criterion = z.object({ id: z.string(), title: z.string(), description: z.string() });
const evidence = z.object({ artifactId: z.string(), versionId: z.string() });
const command = z.object({ request_key: z.string().uuid(), expected_criteria_revision: z.number().int().nonnegative(), reviewer_id: z.string(),
  evidence: z.array(z.object({ criterion_id: z.string(), version_ids: z.array(z.string()) })), note: z.string(), supersedes_request_id: z.string().optional() });
const schema = z.object({ criteria: z.record(z.string(), z.object({ baseRevision: z.number().int().nonnegative(), items: z.array(criterion) })),
  requests: z.record(z.string(), z.object({ criteriaRevision: z.number().int().nonnegative(), reviewerId: z.string(), note: z.string(),
    evidence: z.record(z.string(), z.array(evidence)), supersedesRequestId: z.string(), pending: command.nullable() })) });
export type CockpitAcceptanceRequestDraft = z.infer<typeof schema>["requests"][string];
export type CockpitAcceptanceEvidenceSelection = z.infer<typeof evidence>;

export const useCockpitAcceptanceDraftStore = createDraftStore<z.infer<typeof schema>>({
  storageKey: "multica_cockpit_acceptance_drafts", emptyData: { criteria: {}, requests: {} },
  hasMeaningful: (draft) => Object.keys(draft.criteria).length > 0 || Object.keys(draft.requests).length > 0,
  migrateData: (raw) => { const parsed = schema.safeParse(raw); return parsed.success ? parsed.data : { criteria: {}, requests: {} }; },
});
export const cockpitAcceptanceDraftKey = (wsId: string, nodeId: string) => JSON.stringify([wsId, nodeId]);

export function saveCockpitCriteriaDraft(key: string, baseRevision: number, items: CockpitAcceptanceCriterionInput[]) {
  const state = useCockpitAcceptanceDraftStore.getState();
  state.setDraft({ criteria: { ...state.draft.criteria, [key]: { baseRevision, items } } });
}
export function clearCockpitCriteriaDraft(key: string, observed: { baseRevision: number; items: CockpitAcceptanceCriterionInput[] }) {
  const state = useCockpitAcceptanceDraftStore.getState();
  if (JSON.stringify(state.draft.criteria[key]) !== JSON.stringify(observed)) return;
  const criteria = { ...state.draft.criteria }; delete criteria[key]; state.setDraft({ criteria });
}
export function updateCockpitAcceptanceRequestDraft(key: string, revision: number, patch: Partial<Omit<CockpitAcceptanceRequestDraft, "pending" | "criteriaRevision">>) {
  const state = useCockpitAcceptanceDraftStore.getState(); const current = state.draft.requests[key];
  if (current?.pending) return;
  const previous: CockpitAcceptanceRequestDraft = current ?? { criteriaRevision: revision, reviewerId: "", note: "", evidence: {}, supersedesRequestId: "", pending: null };
  state.setDraft({ requests: { ...state.draft.requests, [key]: { ...previous, ...patch } } });
}
export function rebaseCockpitAcceptanceRequestDraft(key: string, revision: number, criterionIds: string[]) {
  const state = useCockpitAcceptanceDraftStore.getState(); const current = state.draft.requests[key];
  if (!current || current.pending) return;
  const evidence = Object.fromEntries(Object.entries(current.evidence).filter(([id]) => criterionIds.includes(id)));
  state.setDraft({ requests: { ...state.draft.requests, [key]: { ...current, criteriaRevision: revision, evidence } } });
}
export function prepareCockpitAcceptanceRequest(key: string, requestKey: string): CockpitAcceptanceRequestCreate | null {
  const state = useCockpitAcceptanceDraftStore.getState(); const current = state.draft.requests[key];
  if (!current) return null;
  if (current.pending) return current.pending;
  const pending: CockpitAcceptanceRequestCreate = { request_key: requestKey, expected_criteria_revision: current.criteriaRevision, reviewer_id: current.reviewerId,
    evidence: Object.entries(current.evidence).map(([criterion_id, references]) => ({ criterion_id, version_ids: references.map((reference) => reference.versionId) })),
    note: current.note.trim(), ...(current.supersedesRequestId ? { supersedes_request_id: current.supersedesRequestId } : {}) };
  state.setDraft({ requests: { ...state.draft.requests, [key]: { ...current, pending } } }); return pending;
}
export function settleCockpitAcceptanceRequest(key: string, requestKey: string, accepted: boolean) {
  const state = useCockpitAcceptanceDraftStore.getState(); const current = state.draft.requests[key];
  if (current?.pending?.request_key !== requestKey) return;
  const requests = { ...state.draft.requests };
  if (accepted) delete requests[key]; else requests[key] = { ...current, pending: null };
  state.setDraft({ requests });
}
