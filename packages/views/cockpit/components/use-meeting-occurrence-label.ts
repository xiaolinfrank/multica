"use client";
import { useT } from "../../i18n";
export function useMeetingOccurrenceLabel() {
  const { t } = useT("cockpit");
  const labels: Record<string, string> = { unconfirmed: t(($) => $.meeting_lifecycle.unconfirmed), scheduled: t(($) => $.meeting_lifecycle.scheduled), in_progress: t(($) => $.meeting_lifecycle.in_progress), ended: t(($) => $.meeting_lifecycle.ended) };
  return (state: string) => labels[state] ?? t(($) => $.meeting_lifecycle.unknown, { state });
}
