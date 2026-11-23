"use client";

import { useWorkspaceId } from "@multica/core/hooks";
import type { UpdateIssueRequest } from "@multica/core/types";
import { IssueScopePicker } from "./pickers/issue-scope-picker";
import { useIssueScopeMove, type ScopeIssue } from "./use-issue-scope-move";

export { scopePatch } from "./use-issue-scope-move";
export type { ScopeIssue } from "./use-issue-scope-move";

/**
 * The issue detail's ownership row: "Project / Module / Work item" in one
 * control. Moving the issue into a project whose workflow hands off the
 * column it lands on first confirms the handoff, like a status change would;
 * a work item inside the same project changes nothing about the workflow.
 *
 * The move itself lives in `useIssueScopeMove`, shared with the cockpit's
 * "assign an existing task" dialog — both write the same filing.
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
  const { current, move, dialog } = useIssueScopeMove({ wsId, issue, onUpdate });

  return (
    <>
      <IssueScopePicker
        value={current}
        onUpdate={move}
        readOnly={readOnly}
        restriction={restriction}
        triggerRender={triggerRender}
        align="start"
      />
      {dialog}
    </>
  );
}
