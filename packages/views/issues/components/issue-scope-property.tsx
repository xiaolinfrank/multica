"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { projectMoveMayHandOff, resolveProjectWorkflow, useIssueWorkflows } from "@multica/core/issue-workflows";
import { projectListOptions } from "@multica/core/projects/queries";
import type { Project, UpdateIssueRequest } from "@multica/core/types";
import { WorkflowHandoffConfirmDialog } from "../../workflows/handoff-confirm-dialog";
import {
  IssueScopePicker,
  type IssueScopeValue,
} from "./pickers/issue-scope-picker";

/** The filing fields an issue row carries. Kept narrow so the element works
 *  for a detail row and for a surface that has only a list row in hand. */
interface ScopeIssue {
  id: string;
  identifier: string;
  status: string;
  project_id: string | null;
  module_id?: string | null;
  work_item_id?: string | null;
}

/** Only what the user actually changed. A named work item already supplies
 *  its module and project, and naming all three would just repeat — or
 *  contradict — what the server reads from the node. */
export function scopePatch(current: IssueScopeValue, next: IssueScopeValue): Partial<UpdateIssueRequest> | null {
  const patch: Partial<UpdateIssueRequest> = {};
  if (next.work_item_id !== current.work_item_id) patch.work_item_id = next.work_item_id;
  if (next.module_id !== current.module_id) patch.module_id = next.module_id;
  if (next.project_id !== current.project_id) patch.project_id = next.project_id;
  if (Object.keys(patch).length === 0) return null;
  if (patch.work_item_id) {
    delete patch.module_id;
    delete patch.project_id;
  }
  return patch;
}

/**
 * The issue detail's ownership row: "Project / Module / Work item" in one
 * control. Moving the issue into a project whose workflow hands off the
 * column it lands on first confirms the handoff, like a status change would;
 * a work item inside the same project changes nothing about the workflow.
 */
export function IssueScopeProperty({
  issue,
  onUpdate,
  readOnly = false,
  restriction,
  triggerRender,
}: {
  issue: ScopeIssue;
  onUpdate: (updates: Partial<UpdateIssueRequest>) => void;
  readOnly?: boolean;
  restriction?: React.ReactNode;
  /** The board's peek row passes its pill; the sidebar keeps the default. */
  triggerRender?: React.ReactElement;
}) {
  const wsId = useWorkspaceId();
  const { data: projects = [] } = useQuery(projectListOptions(wsId));
  const { workflows } = useIssueWorkflows(wsId);
  const [pending, setPending] = useState<{ target: Project; patch: Partial<UpdateIssueRequest> } | null>(null);

  const current: IssueScopeValue = {
    project_id: issue.project_id ?? null,
    module_id: issue.module_id ?? null,
    work_item_id: issue.work_item_id ?? null,
  };

  const update = (next: IssueScopeValue) => {
    const patch = scopePatch(current, next);
    if (!patch) return;
    const target = next.project_id ? projects.find((project) => project.id === next.project_id) : undefined;
    if (
      target &&
      target.id !== issue.project_id &&
      projectMoveMayHandOff(resolveProjectWorkflow(workflows, target), issue.status)
    ) {
      setPending({ target, patch });
      return;
    }
    onUpdate(patch);
  };

  return (
    <>
      <IssueScopePicker
        value={current}
        onUpdate={update}
        readOnly={readOnly}
        restriction={restriction}
        triggerRender={triggerRender}
        align="start"
      />
      <WorkflowHandoffConfirmDialog
        issue={pending ? issue : null}
        toStatus=""
        toProject={pending?.target ?? null}
        onCancel={() => setPending(null)}
        onConfirm={({ stopPreviousRuns }) => {
          const move = pending;
          setPending(null);
          if (move) {
            onUpdate({
              ...move.patch,
              enter_workflow_step: true,
              ...(stopPreviousRuns ? { stop_previous_assignee_runs: true } : {}),
            });
          }
        }}
      />
    </>
  );
}
