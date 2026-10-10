import { z } from "zod";
import { createDraftStore } from "../drafts/create-draft-store";
import type { CockpitArtifactCreate, CockpitArtifactSubmit } from "../types/cockpit-artifacts";

const payload = z.discriminatedUnion("kind", [z.object({ kind: z.literal("text"), content: z.string() }), z.object({ kind: z.literal("attachment"), attachment_id: z.string() })]);
const createCommand = z.object({ creation_key: z.string().uuid(), node_id: z.string(), source_issue_id: z.string(), title: z.string(), description: z.string(), reviewer_id: z.string() });
const submissionCommand = z.object({ expected_revision: z.number().int().nonnegative(), submission_key: z.string().uuid(), payload });
const creationDraft = z.object({ title: z.string(), description: z.string(), sourceIssueId: z.string(), reviewerId: z.string(), pending: createCommand.nullable() });
const submissionDraft = z.object({ kind: z.enum(["text", "attachment"]), text: z.string(), attachmentId: z.string(), baseRevision: z.number().int().nonnegative().nullable(), pending: submissionCommand.nullable() });
export type CockpitArtifactCreationDraft = z.infer<typeof creationDraft>;
export type CockpitArtifactSubmissionDraft = z.infer<typeof submissionDraft>;
export const EMPTY_ARTIFACT_CREATION_DRAFT: CockpitArtifactCreationDraft = { title: "", description: "", sourceIssueId: "", reviewerId: "", pending: null };
export const EMPTY_ARTIFACT_SUBMISSION_DRAFT: CockpitArtifactSubmissionDraft = { kind: "text", text: "", attachmentId: "", baseRevision: null, pending: null };
const persisted = z.object({ creations: z.record(z.string(), creationDraft), submissions: z.record(z.string(), submissionDraft), reviews: z.record(z.string(), z.object({ decision: z.enum(["approved", "changes_requested", "rejected"]), feedback: z.string() })) });

/** Only user-authored drafts and retryable command intent. No server objects or lists are stored here. */
export const useCockpitArtifactDraftStore = createDraftStore<z.infer<typeof persisted>>({
  storageKey: "multica_cockpit_artifact_drafts", emptyData: { creations: {}, submissions: {}, reviews: {} },
  hasMeaningful: (draft) => Object.values(draft.creations).some((entry) => Boolean(entry.title || entry.description || entry.sourceIssueId || entry.reviewerId || entry.pending))
    || Object.values(draft.submissions).some((entry) => Boolean(entry.text || entry.attachmentId || entry.pending))
    || Object.values(draft.reviews).some((entry) => Boolean(entry.feedback)),
  migrateData: (raw) => { const parsed = persisted.safeParse(raw); return parsed.success ? parsed.data : { creations: {}, submissions: {}, reviews: {} }; },
});
export const cockpitArtifactDraftKey = (wsId: string, kind: "create" | "submit" | "review", ...ids: string[]) => JSON.stringify([wsId, kind, ...ids]);

export function updateCockpitArtifactCreationDraft(key: string, patch: Partial<Omit<CockpitArtifactCreationDraft, "pending">>) {
  const state = useCockpitArtifactDraftStore.getState(); const current = state.draft.creations[key] ?? EMPTY_ARTIFACT_CREATION_DRAFT;
  if (!current.pending) state.setDraft({ creations: { ...state.draft.creations, [key]: { ...current, ...patch } } });
}
export function prepareCockpitArtifactCreation(key: string, nodeId: string, creationKey: string): CockpitArtifactCreate {
  const state = useCockpitArtifactDraftStore.getState(); const current = state.draft.creations[key] ?? EMPTY_ARTIFACT_CREATION_DRAFT;
  if (current.pending) return current.pending;
  const pending: CockpitArtifactCreate = { creation_key: creationKey, node_id: nodeId, source_issue_id: current.sourceIssueId,
    title: current.title.trim(), description: current.description.trim(), reviewer_id: current.reviewerId };
  state.setDraft({ creations: { ...state.draft.creations, [key]: { ...current, pending } } }); return pending;
}
export function settleCockpitArtifactCreation(key: string, commandKey: string, accepted: boolean) {
  const state = useCockpitArtifactDraftStore.getState(); const current = state.draft.creations[key];
  if (current?.pending?.creation_key !== commandKey) return;
  const creations = { ...state.draft.creations };
  if (accepted) delete creations[key]; else creations[key] = { ...current, pending: null };
  state.setDraft({ creations });
}
export function updateCockpitArtifactSubmissionDraft(key: string, revision: number, patch: Partial<Pick<CockpitArtifactSubmissionDraft, "kind" | "text" | "attachmentId">>) {
  const state = useCockpitArtifactDraftStore.getState(); const current = state.draft.submissions[key] ?? EMPTY_ARTIFACT_SUBMISSION_DRAFT;
  if (!current.pending) state.setDraft({ submissions: { ...state.draft.submissions, [key]: { ...current, ...patch, baseRevision: current.baseRevision ?? revision } } });
}
export function rebaseCockpitArtifactSubmissionDraft(key: string, revision: number) {
  const state = useCockpitArtifactDraftStore.getState(); const current = state.draft.submissions[key];
  if (current && !current.pending) state.setDraft({ submissions: { ...state.draft.submissions, [key]: { ...current, baseRevision: revision } } });
}
export function prepareCockpitArtifactSubmission(key: string, revision: number, submissionKey: string): CockpitArtifactSubmit {
  const state = useCockpitArtifactDraftStore.getState(); const current = state.draft.submissions[key] ?? EMPTY_ARTIFACT_SUBMISSION_DRAFT;
  if (current.pending) return current.pending;
  const pending: CockpitArtifactSubmit = { expected_revision: current.baseRevision ?? revision, submission_key: submissionKey,
    payload: current.kind === "text" ? { kind: "text", content: current.text } : { kind: "attachment", attachment_id: current.attachmentId } };
  state.setDraft({ submissions: { ...state.draft.submissions, [key]: { ...current, pending } } }); return pending;
}
export function settleCockpitArtifactSubmission(key: string, commandKey: string, accepted: boolean) {
  const state = useCockpitArtifactDraftStore.getState(); const current = state.draft.submissions[key];
  if (current?.pending?.submission_key !== commandKey) return;
  const submissions = { ...state.draft.submissions };
  if (accepted) delete submissions[key]; else submissions[key] = { ...current, pending: null };
  state.setDraft({ submissions });
}
export function updateCockpitArtifactReviewDraft(key: string, patch: Partial<{ decision: "approved" | "changes_requested" | "rejected"; feedback: string }>) {
  const state = useCockpitArtifactDraftStore.getState();
  const previous = state.draft.reviews[key] ?? { decision: "approved" as const, feedback: "" };
  state.setDraft({ reviews: { ...state.draft.reviews, [key]: { ...previous, ...patch } } });
}

export function clearCockpitArtifactReviewDraft(key: string, observed: { decision: "approved" | "changes_requested" | "rejected"; feedback: string }) {
  const state = useCockpitArtifactDraftStore.getState();
  if (JSON.stringify(state.draft.reviews[key] ?? { decision: "approved", feedback: "" }) !== JSON.stringify(observed)) return;
  const reviews = { ...state.draft.reviews }; delete reviews[key]; state.setDraft({ reviews });
}
