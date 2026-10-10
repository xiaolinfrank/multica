"use client";

import { useWorkspaceId } from "@multica/core/hooks";
import { issueOperationAllowed, useIssueOperationBasis } from "@multica/core/issues";
import type { Issue, UpdateIssueRequest } from "@multica/core/types";
import { AssigneePicker } from "./pickers";
import { IssueOperationRestriction } from "./issue-operation-restriction";
import { DeferredPopup } from "../../common/deferred-popup";
import { PICKER_TRIGGER_CLASS } from "./pickers/property-picker";

/** Card candidates are read only while the user is choosing an assignee. */
export function IssueAssigneeControl({ issue, onUpdate, trigger }: { issue: Issue; onUpdate: (updates: Partial<UpdateIssueRequest>) => void; trigger: React.ReactNode }) {
  return <DeferredPopup trigger={trigger} triggerClassName={PICKER_TRIGGER_CLASS}>{(open, onOpenChange) => <OpenedIssueAssigneeControl issue={issue} onUpdate={onUpdate} trigger={trigger} open={open} onOpenChange={onOpenChange} />}</DeferredPopup>;
}

function OpenedIssueAssigneeControl({ issue, onUpdate, trigger, open, onOpenChange }: { issue: Issue; onUpdate: (updates: Partial<UpdateIssueRequest>) => void; trigger: React.ReactNode; open: boolean; onOpenChange: (open: boolean) => void }) {
  const wsId = useWorkspaceId();
  const policy = useIssueOperationBasis(wsId, open ? [issue.id] : []);
  const observation = { basis: policy.byIssue.get(issue.id), pending: policy.pendingIds.has(issue.id), error: policy.errorIds.has(issue.id), retry: () => { void policy.refetch(); } };
  const allowed = issueOperationAllowed(observation.basis, "assignee");
  return <AssigneePicker assigneeType={issue.assignee_type} assigneeId={issue.assignee_id} open={open} onOpenChange={onOpenChange} trigger={trigger}
    readOnly={!allowed} restriction={<IssueOperationRestriction observation={observation} operation="assignee" />}
    onUpdate={(updates) => { if (allowed) onUpdate(updates); }} />;
}
