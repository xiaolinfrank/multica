"use client";

import { useState, type MouseEvent, type ReactElement } from "react";
import type { Issue } from "@multica/core/types";
import { useWorkspaceId } from "@multica/core/hooks";
import { issueOperationAllowed, useIssueOperationBasis } from "@multica/core/issues";
import { IssueOperationRestriction } from "../components/issue-operation-restriction";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from "@multica/ui/components/ui/dropdown-menu";
import { shouldOpenRowMenu, useRowMenu } from "../../common/point-menu";
import { isDesktopShell } from "../../platform/local-directory";
import { useIssueActions } from "./use-issue-actions";
import {
  IssueActionsMenuItems,
  dropdownPrimitives,
} from "./issue-actions-menu-items";
import { AssigneePicker } from "../components/pickers";
import { RunningTasksDialog } from "../../plan-tree/running-tasks-dialog";

interface IssueActionsDropdownProps {
  issue: Issue;
  /** A single React element cloned by Base UI as the trigger (via `render` prop). */
  trigger: ReactElement;
  align?: "start" | "end" | "center";
  /** If set, leave the page after the issue is deleted — back to wherever the
   *  user came from, or to this path when there is no in-app history. */
  onDeletedFallbackPath?: string;
  /** The reader's archived inbox notification for this issue; adds "Restore to inbox". */
  archivedInboxItemId?: string;
  /** Adds "Show in sidebar". */
  onShowInSidebar?: () => void;
  /** Open state shared with a right-click surface, which opens this same
   *  menu at the cursor via `openAtPointer`. */
  rowMenu?: ReturnType<typeof useRowMenu>;
}

/**
 * Opens an issue page's ⋯ menu at the cursor on a right-click in the page
 * body. Desktop only for now: web keeps the browser's own menu there.
 * Content with a menu of its own — comments, rows, links, fields, selected
 * text — keeps it.
 */
export function useIssuePageMenu() {
  const rowMenu = useRowMenu();
  const onContextMenu = (event: MouseEvent) => {
    if (!isDesktopShell() || !shouldOpenRowMenu(event, { deferToContent: true })) return;
    rowMenu.openAtPointer(event);
  };
  return { rowMenu, onContextMenu };
}

export function IssueActionsDropdown({
  issue,
  trigger,
  align = "end",
  onDeletedFallbackPath,
  archivedInboxItemId,
  onShowInSidebar,
  rowMenu,
}: IssueActionsDropdownProps) {
  const wsId = useWorkspaceId();
  const [ownOpen, setOwnOpen] = useState(false);
  const [assigneeOpen, setAssigneeOpen] = useState(false);
  const open = rowMenu ? rowMenu.menu.open : ownOpen;
  const atPoint = !!rowMenu?.menu.point;
  const close = () => {
    if (rowMenu) rowMenu.setMenu((menu) => ({ ...menu, open: false }));
    else setOwnOpen(false);
  };
  // The operation policy is fetched only while the menu (or its assignee
  // popover) is open, so list surfaces pay nothing per row.
  const policy = useIssueOperationBasis(wsId, open || assigneeOpen ? [issue.id] : []);
  const observation = { basis: policy.byIssue.get(issue.id), pending: policy.pendingIds.has(issue.id), error: policy.errorIds.has(issue.id), retry: () => { void policy.refetch(); } };
  const actions = useIssueActions(issue, observation);

  // The outer `relative inline-flex` is the picker's anchor box: the
  // absolute, pointer-events-none span inside `triggerRender` fills it, so
  // the popover positions itself relative to the dropdown's 3-dot button
  // without us having to thread a ref through Base UI's anchor API.
  return (
    <span className="relative inline-flex">
      <DropdownMenu open={open} onOpenChange={rowMenu ? rowMenu.onOpenChange : setOwnOpen}>
        <DropdownMenuTrigger render={trigger} />
        <DropdownMenuContent
          align={atPoint ? "start" : align}
          anchor={rowMenu?.anchor}
          className="w-auto"
        >
          <IssueActionsMenuItems
            issue={issue}
            actions={actions}
            primitives={dropdownPrimitives}
            onOpenAssignee={() => setAssigneeOpen(true)}
            onClose={close}
            onDeletedFallbackPath={onDeletedFallbackPath}
            archivedInboxItemId={archivedInboxItemId}
            onShowInSidebar={onShowInSidebar}
            observation={observation}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Mount the picker only once the user actually opens it. Otherwise
          every row in a list/board would subscribe to members/agents/squads
          /frequency queries on mount, multiplying memory + render cost. */}
      {assigneeOpen && (
        <AssigneePicker
          assigneeType={issue.assignee_type}
          assigneeId={issue.assignee_id}
          onUpdate={actions.updateField}
          open={assigneeOpen}
          onOpenChange={setAssigneeOpen}
          readOnly={!issueOperationAllowed(observation.basis, "assignee")}
          restriction={<IssueOperationRestriction observation={observation} operation="assignee" />}
          triggerRender={
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0"
            />
          }
          trigger={<span />}
          align={atPoint ? "start" : align}
        />
      )}
      <RunningTasksDialog
        conflict={actions.directoryConflict}
        onDismiss={actions.dismissDirectoryConflict}
      />
    </span>
  );
}
