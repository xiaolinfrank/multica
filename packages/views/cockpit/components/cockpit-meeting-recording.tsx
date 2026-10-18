"use client";

// Recording opens the minutes task and nothing else. One button hands the
// create to the platform's own create-issue dialog; the created issue is
// then adopted as this meeting's minutes task with the opener as reviewer.
// Occurrence confirmation lives with the meeting facts below, and
// readiness/release no longer gate submission.

import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { cockpitKeys, useEnableCockpitMeetingWorkflow } from "@multica/core/cockpit";
import type { CockpitMeetingWorkflowSummary, Issue } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useT } from "../../i18n";
import { CockpitMinutesTaskCard } from "./cockpit-meeting-workflow";
import { openCockpitMeetingIssueCreate } from "./cockpit-meeting-issue-create";

export function CockpitMeetingRecording({ wsId, meetingId, workflow, loading, loadError, onReload, currentUserId, defaultPlacement, defaultAssigneeType, defaultAssigneeId, readOnly }: {
  wsId: string;
  meetingId: string;
  workflow: CockpitMeetingWorkflowSummary | null | undefined;
  loading: boolean;
  loadError: boolean;
  onReload: () => void;
  currentUserId: string;
  defaultPlacement: { project_id: string | null; module_id: string | null; node_id: string | null };
  defaultAssigneeType: string | null;
  defaultAssigneeId: string | null;
  readOnly?: boolean;
}) {
  const { t } = useT("cockpit");
  const client = useQueryClient();
  const enable = useEnableCockpitMeetingWorkflow(wsId);
  if (loading) return <div role="status" className="flex items-center gap-2 text-caption text-muted-foreground"><Spinner />{t(($) => $.workflow.loading)}</div>;
  if (loadError) return <div role="alert" className="space-y-2 text-caption text-destructive">
    <p>{t(($) => $.workflow.load_failed)}</p>
    <Button type="button" size="sm" variant="outline" onClick={onReload}>{t(($) => $.binding.retry)}</Button>
  </div>;
  if (workflow && workflow.meeting_id === meetingId && workflow.enabled) return <CockpitMinutesTaskCard workflow={workflow} />;
  const create = () => openCockpitMeetingIssueCreate({
    projectId: defaultPlacement.project_id,
    moduleId: defaultPlacement.module_id,
    assigneeType: defaultAssigneeType ?? "member",
    assigneeId: defaultAssigneeId ?? currentUserId,
    onCreated: async (issue: Issue) => {
      try {
        await enable.mutateAsync({ meetingId, body: { reviewer_id: currentUserId, existing_issue_id: issue.id } });
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : t(($) => $.workflow.command_failed));
      } finally {
        // A lost enable reply must heal on its own: the server may have
        // adopted the issue even though the client never saw the receipt.
        void client.invalidateQueries({ queryKey: cockpitKeys.workflow(wsId, meetingId) });
      }
    },
  });
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
    <Button type="button" size="sm" disabled={readOnly || !currentUserId || enable.isPending} aria-busy={enable.isPending} onClick={create}>
      {t(($) => $.workflow.setup_title)}</Button>
    <p className="text-caption text-muted-foreground">{t(($) => $.meeting_stage.recording_hint)}</p>
  </div>;
}
