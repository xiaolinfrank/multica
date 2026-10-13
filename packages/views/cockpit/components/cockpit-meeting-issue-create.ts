"use client";

// The meeting stages never build their own create-task form. Both stage
// buttons hand the create to the platform's own create-issue dialog — title,
// description, attachments and the executor choice stay exactly what the
// platform already offers — and the meeting only receives the created issue
// through the dialog's on_created hook.

import { useModalStore } from "@multica/core/modals";
import type { Issue } from "@multica/core/types";

export function openCockpitMeetingIssueCreate(input: {
  projectId: string | null;
  moduleId: string | null;
  assigneeType: string | null;
  assigneeId: string | null;
  onCreated: (issue: Issue) => unknown;
}) {
  useModalStore.getState().open("create-issue", {
    status: "backlog",
    project_id: input.projectId,
    module_id: input.moduleId,
    assignee_type: input.assigneeType ?? "member",
    assignee_id: input.assigneeId,
    on_created: input.onCreated,
  });
}
