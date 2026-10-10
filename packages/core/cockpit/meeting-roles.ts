export const COCKPIT_MEETING_ISSUE_ROLES = [
  "preparation", "support", "minutes", "review", "action", "delivery", "reference",
] as const;

export type CockpitMeetingIssueRole = typeof COCKPIT_MEETING_ISSUE_ROLES[number];

export function isCockpitMeetingIssueRole(role: string): role is CockpitMeetingIssueRole {
  return COCKPIT_MEETING_ISSUE_ROLES.some((known) => known === role);
}

/** Older responses contain direct links only; derived agenda sources never imply a direct link. */
export function cockpitMeetingHasDirectReference(source: {
  has_direct_reference?: boolean; has_agenda_reference?: boolean; agenda_id?: string | null; agenda_total?: number;
}): boolean {
  return source.has_direct_reference ?? !(source.has_agenda_reference || source.agenda_id || (source.agenda_total ?? 0) > 0);
}
