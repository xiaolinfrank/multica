"use client";

import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import type { UpdateIssueRequest } from "@multica/core/types";
import {
  useBatchDeleteIssues,
  useBatchUpdateIssues,
  useUpdateIssue,
} from "@multica/core/issues/mutations";
import { errorCode } from "@multica/core/api";
import { useModalStore } from "@multica/core/modals";
import {
  type IssueSurfaceActions,
  type IssueSurfaceMutationOptions,
} from "./actions-context";
import type { IssueCreateDefaults } from "./types";
import { useT } from "../../i18n";
import { isCockpitRunningTasksError } from "@multica/core/cockpit";
import type { RunningTasksConflict } from "../../plan-tree/running-tasks-dialog";

export type MoveIssueUpdates = Pick<
  UpdateIssueRequest,
  | "status"
  | "assignee_type"
  | "assignee_id"
  | "position"
  | "stop_previous_assignee_runs"
  | "parent_issue_id"
  | "project_id"
  | "module_id"
  | "work_item_id"
  | "directory_sync"
> & {
  before_id: string | null;
  after_id: string | null;
};

export interface IssueSurfaceActionController {
  actions: IssueSurfaceActions;
  openCreateIssue: (defaults?: IssueCreateDefaults) => void;
  moveIssue: (
    issueId: string,
    updates: MoveIssueUpdates,
    onSettled?: () => void,
  ) => void;
  directoryConflict: RunningTasksConflict | null;
  dismissDirectoryConflict: () => void;
}

export function useIssueSurfaceActions({
  createDefaults,
}: {
  createDefaults: IssueCreateDefaults;
}): IssueSurfaceActionController {
  const { t } = useT("projects");
  const { t: tIssues } = useT("issues");
  const updateIssueMutation = useUpdateIssue();
  const batchUpdateMutation = useBatchUpdateIssues();
  const batchDeleteMutation = useBatchDeleteIssues();
  const [directoryConflict, setDirectoryConflict] =
    useState<RunningTasksConflict | null>(null);
  const dismissDirectoryConflict = useCallback(
    () => setDirectoryConflict(null),
    [],
  );

  const updateIssue = useCallback(
    (
      issueId: string,
      updates: Partial<UpdateIssueRequest>,
      options?: IssueSurfaceMutationOptions,
    ) => {
      const submit = (patch: Partial<UpdateIssueRequest>) => {
        updateIssueMutation.mutate(
          { id: issueId, ...patch },
          {
            onSuccess: (issue) => options?.onSuccess?.(issue),
            onError: (err) => {
              if (isCockpitRunningTasksError(err)) {
                // Surface-level inline edits (table cells, board cards, module
                // row drops) don't mount their own dialog, so the surface opens
                // RunningTasksDialog to offer "sync now / defer". Callers that
                // already host the dialog (useIssueActions) opt out via flag.
                if (!options?.handlesDirectoryConflict) {
                  setDirectoryConflict({
                    tasks: err.runningTasks,
                    retry: (mode) => {
                      setDirectoryConflict(null);
                      submit({ ...updates, directory_sync: mode });
                    },
                  });
                }
              } else {
                toast.error(
                  errorCode(err) === "revision_conflict"
                    ? tIssues(($) => $.revision.conflict)
                    : err instanceof Error && err.message
                    ? err.message
                    : (options?.errorMessage ??
                        t(($) => $.detail.toast_move_issue_failed)),
                );
              }
              options?.onError?.(err);
            },
            onSettled: () => options?.onSettled?.(),
          },
        );
      };
      submit(updates);
    },
    [t, tIssues, updateIssueMutation],
  );

  const moveIssue = useCallback(
    (
      issueId: string,
      updates: MoveIssueUpdates,
      onSettled?: () => void,
    ) => {
      const submit = (patch: MoveIssueUpdates) => {
        const { before_id, after_id, ...optimisticUpdates } = patch;
        updateIssueMutation.mutate(
          {
            id: issueId,
            ...optimisticUpdates,
            move_intent: { before_id, after_id },
          },
          {
            onError: (err) => {
              if (isCockpitRunningTasksError(err)) {
                setDirectoryConflict({
                  tasks: err.runningTasks,
                  retry: (mode) => {
                    setDirectoryConflict(null);
                    submit({ ...updates, directory_sync: mode });
                  },
                });
                return;
              }
              toast.error(
                errorCode(err) === "revision_conflict"
                  ? tIssues(($) => $.revision.conflict)
                  : err instanceof Error && err.message
                  ? err.message
                  : t(($) => $.detail.toast_move_issue_failed),
              );
            },
            onSettled,
          },
        );
      };
      submit(updates);
    },
    [t, tIssues, updateIssueMutation],
  );

  const openCreateIssue = useCallback(
    (defaults?: IssueCreateDefaults) => {
      useModalStore
        .getState()
        .open("create-issue", { ...createDefaults, ...defaults });
    },
    [createDefaults],
  );

  const actions = useMemo<IssueSurfaceActions>(
    () => ({
      isPending:
        updateIssueMutation.isPending ||
        batchUpdateMutation.isPending ||
        batchDeleteMutation.isPending,
      createIssue: openCreateIssue,
      updateIssue,
      moveIssue: (issueId, updates, options) =>
        updateIssue(issueId, updates, {
          errorMessage: t(($) => $.detail.toast_move_issue_failed),
          ...options,
        }),
      batchUpdate: (issueIds, updates, options) =>
        batchUpdateMutation.mutateAsync({ ids: issueIds, updates, ...options }),
      batchDelete: (issueIds, options) =>
        batchDeleteMutation.mutateAsync({ ids: issueIds, ...options }),
    }),
    [
      batchDeleteMutation,
      batchUpdateMutation,
      openCreateIssue,
      t,
      updateIssue,
      updateIssueMutation.isPending,
    ],
  );

  return {
    actions,
    openCreateIssue,
    moveIssue,
    directoryConflict,
    dismissDirectoryConflict,
  };
}
