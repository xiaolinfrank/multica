export const COCKPIT_MEETING_ISSUE_ROLES = [
  "preparation", "support", "minutes", "review", "action", "delivery", "reference",
] as const;

export type CockpitMeetingIssueRole = typeof COCKPIT_MEETING_ISSUE_ROLES[number];

export function isCockpitMeetingIssueRole(role: string): role is CockpitMeetingIssueRole {
  return COCKPIT_MEETING_ISSUE_ROLES.some((known) => known === role);
}

/** Older responses contain direct links only; derived agenda sources never imply a direct link. */
export function cockpitMeetingHasDirectReference(source: {
  has_direct_reference?: boolean;
}): boolean {
  return source.has_direct_reference ?? true;
}
