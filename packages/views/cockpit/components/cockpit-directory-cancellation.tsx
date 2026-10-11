"use client";

import { useQuery } from "@tanstack/react-query";
import { cockpitLifecycleCommandOptions, cockpitMeetingDirectoryPath } from "@multica/core/cockpit";
import type { CockpitDirectoryCancellationImpact } from "@multica/core/types";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { AppLink, useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { CockpitFlowError } from "./cockpit-task-flow";

function DirectoryOperationsLink({ meetingId }: { meetingId: string }) {
  const { t } = useT("cockpit"); const navigation = useNavigation();
  return <AppLink target="_blank" rel="noopener noreferrer" className="text-primary underline" href={cockpitMeetingDirectoryPath(navigation.pathname, meetingId, null, navigation.searchParams)}>{t(($) => $.meeting_directory.view_all)} {t(($) => $.action_flow.new_tab)}</AppLink>;
}

export function CockpitDirectoryCancellationPreview({ meetingId, value }: { meetingId: string; value: CockpitDirectoryCancellationImpact }) {
  const { t } = useT("cockpit");
  return <section className="space-y-2 rounded-lg border border-border p-3 text-caption" aria-label={t(($) => $.meeting_directory.title)}>
    <p>{t(($) => $.meeting_directory.cancel_preview, { count: value.will_pause_total })}</p>
    <p className="text-muted-foreground">{t(($) => $.meeting_directory.cancel_boundary)}</p>
    {value.unfinished_total > 0 && <DirectoryOperationsLink meetingId={meetingId} />}
  </section>;
}

export function CockpitDirectoryCancellationReceipt({ wsId, meetingId, operationId, commandKey }: { wsId: string; meetingId: string; operationId: string; commandKey: string }) {
  const { t } = useT("cockpit");
  const query = useQuery(cockpitLifecycleCommandOptions(wsId, meetingId, commandKey));
  const preparation = query.data?.receipt.preparation;
  if (query.isPending) return <Spinner />;
  if (query.isError || !query.data || preparation?.operation_id !== operationId) return <CockpitFlowError onRetry={() => void query.refetch()} />;
  const value = preparation.directory_effect;
  if (!value) return null;
  return <section className="space-y-2 rounded-lg border border-border p-3 text-caption" aria-label={t(($) => $.meeting_directory.cancel_result)}>
    <p>{t(($) => $.meeting_directory.cancel_paused, { count: value.paused_total })}</p><p className="text-muted-foreground">{t(($) => $.meeting_directory.cancel_boundary)}</p>
    <DirectoryOperationsLink meetingId={meetingId} />
  </section>;
}
