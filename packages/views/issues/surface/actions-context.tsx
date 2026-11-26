"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Issue, UpdateIssueRequest, IssueBatchReceipt, IssueBatchWriteOptions } from "@multica/core/types";
import type { IssueCreateDefaults } from "./types";

export type IssueSurfaceMutationOptions = {
  errorMessage?: string;
  onSuccess?: (issue: Issue) => void;
  onError?: (err: unknown) => void;
  onSettled?: () => void;
  /** Caller mounts its own RunningTasksDialog for directory-sync conflicts,
   *  so the surface does not open a second dialog for the same write. */
  handlesDirectoryConflict?: boolean;
};

export interface IssueSurfaceActions {
  isPending: boolean;
  createIssue: (defaults?: IssueCreateDefaults) => void;
  updateIssue: (
    issueId: string,
    updates: Partial<UpdateIssueRequest>,
    options?: IssueSurfaceMutationOptions,
  ) => void;
  moveIssue: (
    issueId: string,
    updates: Partial<UpdateIssueRequest>,
    options?: IssueSurfaceMutationOptions,
  ) => void;
  /** Resolves with the server's per-issue results; it skips the ones its per-issue guards refuse. */
  batchUpdate: (
    issueIds: string[],
    updates: Partial<UpdateIssueRequest>,
    options?: IssueBatchWriteOptions,
  ) => Promise<IssueBatchReceipt>;
  batchDelete: (issueIds: string[], options?: IssueBatchWriteOptions) => Promise<IssueBatchReceipt>;
}

const IssueSurfaceActionsContext = createContext<IssueSurfaceActions | null>(
  null,
);

export function IssueSurfaceActionsProvider({
  actions,
  children,
}: {
  actions: IssueSurfaceActions;
  children: ReactNode;
}) {
  return (
    <IssueSurfaceActionsContext.Provider value={actions}>
      {children}
    </IssueSurfaceActionsContext.Provider>
  );
}

export function useIssueSurfaceActionsOptional() {
  return useContext(IssueSurfaceActionsContext);
}
