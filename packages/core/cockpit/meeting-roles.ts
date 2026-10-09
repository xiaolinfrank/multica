export const COCKPIT_MEETING_ISSUE_ROLES = [
  "preparation", "support", "minutes", "review", "action", "delivery", "reference",
] as const;

export type CockpitMeetingIssueRole = typeof COCKPIT_MEETING_ISSUE_ROLES[number];

export function isCockpitMeetingIssueRole(role: string): role is CockpitMeetingIssueRole {
  return COCKPIT_MEETING_ISSUE_ROLES.some((known) => known === role);
}
