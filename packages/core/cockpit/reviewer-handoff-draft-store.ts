import { z } from "zod";
import { createDraftStore } from "../drafts/create-draft-store";
import type { CockpitMeetingWorkflow, CockpitReviewerHandoffCommand, CockpitWorkflowCommandResponse } from "../types";
import { acknowledgedCockpitReviewerHandoff } from "./reviewer-handoff";
import { acknowledgedCockpitWorkflowCommand } from "./workflow-history";

export interface CockpitReviewerHandoffDraft {
  reviewer_id: string;
  reason: string;
  handoff_key: string | null;
  pending: CockpitReviewerHandoffCommand | null;
}

export const EMPTY_COCKPIT_REVIEWER_HANDOFF_DRAFT: CockpitReviewerHandoffDraft = {
  reviewer_id: "", reason: "", handoff_key: null, pending: null,
};
const persistedDrafts = z.object({
  byMeeting: z.record(z.string(), z.object({
    reviewer_id: z.string(), reason: z.string(), handoff_key: z.string().uuid().nullable(),
    pending: z.object({ expected_revision: z.number().int().positive(), handoff_key: z.string().uuid(),
      reviewer_id: z.string().min(1), reason: z.string().min(1) }).nullable(),
  })),
});

export const useCockpitReviewerHandoffDraftStore = createDraftStore<{ byMeeting: Record<string, CockpitReviewerHandoffDraft> }>({
  storageKey: "multica_cockpit_reviewer_handoff_drafts",
  emptyData: { byMeeting: {} },
  hasMeaningful: (draft) => Object.values(draft.byMeeting).some((entry) => Boolean(entry.reviewer_id || entry.reason || entry.pending)),
  migrateData: (raw) => {
    const parsed = persistedDrafts.safeParse(raw);
    return parsed.success ? parsed.data : { byMeeting: {} };
  },
});

export function setCockpitReviewerHandoffDraft(meetingId: string, patch: Partial<Pick<CockpitReviewerHandoffDraft, "reviewer_id" | "reason">>) {
  const store = useCockpitReviewerHandoffDraftStore.getState();
  const existing = store.draft.byMeeting[meetingId] ?? EMPTY_COCKPIT_REVIEWER_HANDOFF_DRAFT;
  if (existing.pending) return;
  store.setDraft({ byMeeting: { ...store.draft.byMeeting, [meetingId]: { ...existing, ...patch } } });
}

/** Persist only the user's confirmed command, not a copy of the workflow or its history. */
export function prepareCockpitReviewerHandoff(meetingId: string, revision: number, key: string): CockpitReviewerHandoffCommand {
  const store = useCockpitReviewerHandoffDraftStore.getState();
  const existing = store.draft.byMeeting[meetingId] ?? EMPTY_COCKPIT_REVIEWER_HANDOFF_DRAFT;
  if (existing.pending) return existing.pending;
  const pending = { expected_revision: revision, handoff_key: existing.handoff_key ?? key,
    reviewer_id: existing.reviewer_id, reason: existing.reason.trim() };
  store.setDraft({ byMeeting: { ...store.draft.byMeeting, [meetingId]: { ...existing, handoff_key: pending.handoff_key, pending } } });
  return pending;
}

/** A definite refusal permits revising and reconfirming against the refreshed workflow. */
export function rejectCockpitReviewerHandoff(meetingId: string) {
  const store = useCockpitReviewerHandoffDraftStore.getState();
  const existing = store.draft.byMeeting[meetingId];
  if (!existing?.pending) return;
  store.setDraft({ byMeeting: { ...store.draft.byMeeting, [meetingId]: { ...existing, handoff_key: null, pending: null } } });
}

export function acknowledgeCockpitReviewerHandoff(meetingId: string, workflow: CockpitMeetingWorkflow): boolean {
  const store = useCockpitReviewerHandoffDraftStore.getState();
  const pending = store.draft.byMeeting[meetingId]?.pending;
  if (workflow.meeting_id !== meetingId || !pending || !acknowledgedCockpitReviewerHandoff(workflow, pending)) return false;
  const byMeeting = { ...store.draft.byMeeting };
  delete byMeeting[meetingId];
  store.setDraft({ byMeeting });
  return true;
}

export function acknowledgeCockpitCompactReviewerHandoff(meetingId: string, result: CockpitWorkflowCommandResponse): boolean {
  const store = useCockpitReviewerHandoffDraftStore.getState();
  const pending = store.draft.byMeeting[meetingId]?.pending;
  if (result.meeting_id !== meetingId || !pending || !acknowledgedCockpitWorkflowCommand(result, { action: "reviewer_reassigned", body: pending })) return false;
  const byMeeting = { ...store.draft.byMeeting };
  delete byMeeting[meetingId];
  store.setDraft({ byMeeting });
  return true;
}
