"use client";

// Preparation is one bounded job: open the issues that carry the meeting.
// The stage surface is a single action — the platform's own create-issue
// dialog creates the task, and the created issue lands in the linked-task
// list below with the preparation role. Everything material lives in the
// meeting NAS directory by default; anything else is an association.

import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { cockpitKeys, useAppendCockpitMeetingIssue, useSetCockpitMeetingIssueRolesCompact } from "@multica/core/cockpit";
import type { CockpitMeeting, Issue } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { useT } from "../../i18n";
import { openCockpitMeetingIssueCreate } from "./cockpit-meeting-issue-create";

export function CockpitMeetingPreparation({ wsId, currentUserId, meeting, defaultPlacement, defaultAssigneeType, defaultAssigneeId, readOnly }: {
  wsId: string;
  currentUserId: string;
  meeting: Pick<CockpitMeeting, "id">;
  defaultPlacement: { project_id: string | null; module_id: string | null; node_id: string | null };
  defaultAssigneeType: string | null;
  defaultAssigneeId: string | null;
  readOnly?: boolean;
}) {
  const { t } = useT("cockpit");
  const client = useQueryClient();
  const append = useAppendCockpitMeetingIssue(wsId);
  const roles = useSetCockpitMeetingIssueRolesCompact(wsId);
  const create = () => openCockpitMeetingIssueCreate({
    projectId: defaultPlacement.project_id,
    moduleId: defaultPlacement.module_id,
    assigneeType: defaultAssigneeType ?? "member",
    assigneeId: defaultAssigneeId ?? currentUserId,
    onCreated: async (issue: Issue) => {
      try {
        await append.mutateAsync({ meetingId: meeting.id, issueId: issue.id });
        await roles.mutateAsync({ meetingId: meeting.id, issueId: issue.id, roles: ["preparation"] });
        void client.invalidateQueries({ queryKey: cockpitKeys.all(wsId) });
      } catch (cause) {
        // The issue is already committed; a failed link never reads as a
        // failed create. It stays findable in the ordinary issue list and
        // can be linked from the linked-task section below.
        toast.error(cause instanceof Error ? cause.message : t(($) => $.errors.save_failed));
      }
    },
  });
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
    <Button type="button" size="sm" disabled={readOnly} onClick={create}>{t(($) => $.meeting_lifecycle.create_preparation_issue)}</Button>
    <p className="text-caption text-muted-foreground">{t(($) => $.meeting_stage.preparation_hint)}</p>
  </div>;
}
