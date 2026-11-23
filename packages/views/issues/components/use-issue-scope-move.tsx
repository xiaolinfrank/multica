"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { projectMoveMayHandOff, resolveProjectWorkflow, useIssueWorkflows } from "@multica/core/issue-workflows";
import { projectListOptions } from "@multica/core/projects/queries";
import type { Project, UpdateIssueRequest } from "@multica/core/types";
import { WorkflowHandoffConfirmDialog } from "../../workflows/handoff-confirm-dialog";
import type { IssueScopeValue } from "./pickers/issue-scope-picker";

/** The filing fields an issue row carries. Kept narrow so the hook works for
 *  a detail row and for a surface that has only a list row in hand. */
export interface ScopeIssue {
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

/** The filing an issue has now, in the picker's shape. */
export function issueScopeValue(issue: ScopeIssue): IssueScopeValue {
  return {
    project_id: issue.project_id ?? null,
    module_id: issue.module_id ?? null,
    work_item_id: issue.work_item_id ?? null,
  };
}

/**
 * Moving an issue's filing, wherever the move starts from: the detail's
 * ownership row, the cockpit's "assign an existing task" dialog. Both need
 * the same three steps — the patch that changed, the handoff check when the
 * destination project hands off, and the confirmed write — so they share them
 * here instead of each keeping a copy that can drift.
 *
 * A move into a project whose workflow hands off the status the issue lands
 * on asks first; a work item inside the same project changes nothing about
 * the workflow and writes straight through.
 */
export function useIssueScopeMove({
  wsId,
  issue,
  onUpdate,
}: {
  wsId: string;
  issue: ScopeIssue;
  onUpdate: (updates: Partial<UpdateIssueRequest>) => void;
}) {
  const { data: projects = [] } = useQuery(projectListOptions(wsId));
  const { workflows } = useIssueWorkflows(wsId);
  const [pending, setPending] = useState<{ target: Project; patch: Partial<UpdateIssueRequest> } | null>(null);

  const current = issueScopeValue(issue);

  const move = (next: IssueScopeValue) => {
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

  const dialog = (
    <WorkflowHandoffConfirmDialog
      issue={pending ? issue : null}
      toStatus=""
      toProject={pending?.target ?? null}
      onCancel={() => setPending(null)}
      onConfirm={({ stopPreviousRuns }: { stopPreviousRuns: boolean }) => {
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
  );

  return { current, move, dialog, pending };
}
