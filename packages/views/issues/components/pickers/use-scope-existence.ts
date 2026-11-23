"use client";

import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { projectListOptions } from "@multica/core/projects/queries";
import { moduleListOptions } from "@multica/core/modules/queries";
import { cockpitNodeDetailOptions, EMPTY_COCKPIT_SCOPE } from "@multica/core/cockpit";
import { ApiError } from "@multica/core/api";
import { EMPTY_ISSUE_SCOPE, type IssueScopeValue } from "./issue-scope-picker";

/** Which stored levels no longer exist. `null` means "not answered yet" —
 *  a list still loading, or a read that failed for a reason other than
 *  "this row is gone". */
export interface ScopeExistence {
  projectMissing: boolean | null;
  moduleMissing: boolean | null;
  workItemMissing: boolean | null;
}

/**
 * Resolves a restored filing against the rows that exist now.
 *
 * A draft outlives the board it was written against: the project can be
 * deleted, the module moved to another project, the work item removed. Each
 * level is checked against the same lists the picker already reads (shared
 * query keys, so this costs nothing extra), and a work item — the one level
 * with no complete list to check against — against its own row.
 *
 * A read that fails for a transport reason answers `null`, not "missing": a
 * blip must not silently discard the user's filing. Only a 404 or an
 * unconfirmed answer means the row is gone.
 */
export function useScopeExistence(value: IssueScopeValue): ScopeExistence {
  const wsId = useWorkspaceId();
  const projects = useQuery(projectListOptions(wsId));
  const modules = useQuery(moduleListOptions(wsId));
  const workItem = useQuery({
    ...cockpitNodeDetailOptions(wsId, value.work_item_id ?? "", EMPTY_COCKPIT_SCOPE),
    enabled: Boolean(value.work_item_id),
  });

  const projectMissing =
    !value.project_id || !projects.isSuccess
      ? null
      : !projects.data.some((project) => project.id === value.project_id);

  let moduleMissing: boolean | null = null;
  if (value.module_id && modules.isSuccess) {
    const module = modules.data.find((candidate) => candidate.id === value.module_id);
    // A module that exists but belongs to another project is just as unusable
    // here: the create would carry a pair the server refuses.
    moduleMissing = !module || (value.project_id != null && module.project_id !== value.project_id);
  }

  let workItemMissing: boolean | null = null;
  if (value.work_item_id) {
    const notFound = workItem.error instanceof ApiError && workItem.error.status === 404;
    if (notFound || (workItem.isSuccess && !workItem.data?.node)) workItemMissing = true;
    else if (workItem.isSuccess) workItemMissing = false;
  }

  return { projectMissing, moduleMissing, workItemMissing };
}

/**
 * Drops whatever part of a restored filing no longer exists, one level at a
 * time: a dead project takes the whole filing with it, a module outside the
 * project takes the module and its work item, and a work item that cannot be
 * read is dropped alone. Nothing is dropped while its check is unanswered.
 */
export function useDropMissingScope(
  value: IssueScopeValue,
  drop: (next: IssueScopeValue) => void,
): void {
  const existence = useScopeExistence(value);
  const dropRef = useRef(drop);
  dropRef.current = drop;
  const { projectMissing, moduleMissing, workItemMissing } = existence;
  const { project_id, module_id, work_item_id } = value;
  useEffect(() => {
    if (projectMissing) {
      dropRef.current(EMPTY_ISSUE_SCOPE);
      return;
    }
    if (moduleMissing) {
      dropRef.current({ project_id, module_id: null, work_item_id: null });
      return;
    }
    if (workItemMissing) dropRef.current({ project_id, module_id, work_item_id: null });
  }, [projectMissing, moduleMissing, workItemMissing, project_id, module_id, work_item_id]);
}
