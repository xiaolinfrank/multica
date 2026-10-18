import { z } from "zod";
import { createDraftStore } from "../drafts/create-draft-store";
import type { CockpitMinutesSubmission, CockpitMinutesVersion } from "../types";

export interface CockpitMinutesDraft {
  content: string;
  submission_key: string | null;
  pending: CockpitMinutesSubmission | null;
}

export const EMPTY_COCKPIT_MINUTES_DRAFT: CockpitMinutesDraft = { content: "", submission_key: null, pending: null };
const persistedDrafts = z.object({
  byMeeting: z.record(z.string(), z.object({
    content: z.string(),
    submission_key: z.string().uuid().nullable().default(null),
    pending: z.object({ expected_revision: z.number().int().nonnegative(), submission_key: z.string().uuid(), content: z.string() }).nullable(),
  })),
});

export const useCockpitMinutesDraftStore = createDraftStore<{ byMeeting: Record<string, CockpitMinutesDraft> }>({
  storageKey: "multica_cockpit_minutes_drafts",
  emptyData: { byMeeting: {} },
  hasMeaningful: (draft) => Object.values(draft.byMeeting).some((entry) => Boolean(entry.content || entry.pending)),
  migrateData: (raw) => {
    const parsed = persistedDrafts.safeParse(raw);
    return parsed.success ? parsed.data : { byMeeting: {} };
  },
});

export function setCockpitMinutesDraftContent(meetingId: string, content: string) {
  const store = useCockpitMinutesDraftStore.getState();
  const existing = store.draft.byMeeting[meetingId] ?? EMPTY_COCKPIT_MINUTES_DRAFT;
  if (existing.pending) return;
  store.setDraft({ byMeeting: { ...store.draft.byMeeting, [meetingId]: { ...existing, content } } });
}

/** Capture a retryable user command, never a server-state snapshot. */
export function prepareCockpitMinutesSubmission(meetingId: string, revision: number, submissionKey: string): CockpitMinutesSubmission {
  const store = useCockpitMinutesDraftStore.getState();
  const existing = store.draft.byMeeting[meetingId] ?? EMPTY_COCKPIT_MINUTES_DRAFT;
  if (existing.pending) return existing.pending;
  const pending = { expected_revision: revision, submission_key: existing.submission_key ?? submissionKey, content: existing.content.trim() };
  store.setDraft({ byMeeting: { ...store.draft.byMeeting, [meetingId]: { ...existing, submission_key: pending.submission_key, pending } } });
  return pending;
}

/** A definite validation refusal permits editing again, but does not rotate the idempotency key. */
export function rejectCockpitMinutesSubmission(meetingId: string) {
  const store = useCockpitMinutesDraftStore.getState();
  const existing = store.draft.byMeeting[meetingId];
  if (!existing?.pending) return;
  store.setDraft({ byMeeting: { ...store.draft.byMeeting, [meetingId]: {
    ...existing, submission_key: existing.submission_key ?? existing.pending.submission_key, pending: null,
  } } });
}

/** Only an authoritative matching version can clear an unconfirmed submission. */
export function acknowledgeCockpitMinutesSubmission(meetingId: string, versions: readonly CockpitMinutesVersion[]): boolean {
  const store = useCockpitMinutesDraftStore.getState();
  const pending = store.draft.byMeeting[meetingId]?.pending;
  if (!pending || !versions.some((version) => version.submission_key === pending.submission_key
    && version.content === pending.content && Boolean(version.id && version.content_hash && version.review_issue.id))) return false;
  const byMeeting = { ...store.draft.byMeeting };
  delete byMeeting[meetingId];
  store.setDraft({ byMeeting });
  return true;
}
