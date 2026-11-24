"use client";

import { useCallback } from "react";
import { cockpitWriteError, useRenameCockpitWorkItem } from "@multica/core/cockpit";
import { useUpdateModule } from "@multica/core/modules";
import { useUpdateProject } from "@multica/core/projects";
import type { NodeDirectorySyncResult } from "@multica/core/types";
import type { PlanRow } from "./plan-rows";

/** The record a row's title lives on: the project, the module, or — only for
 *  a work item — the node itself. Null means the row cannot be renamed
 *  because its record id is missing; the caller disables the gesture rather
 *  than guessing an id. */
export function planRowRenameTarget(row: PlanRow): string | null {
  if (row.kind === "project") return row.node.project_id || null;
  if (row.kind === "module") return row.node.module_id || null;
  return row.node.id;
}

/** Rename one plan row through the interface that owns its title.
 *
 *  L1/L2 names are projections of the project/module titles (invariant I5),
 *  so writing the node's own name would succeed and change nothing on screen.
 *  A work item has no record of its own and is renamed as a node, through the
 *  mutation S7's directory sync listens to. One implementation for the tree,
 *  the table and the gantt. */
export function usePlanRowRename(wsId: string) {
  const updateProject = useUpdateProject();
  const updateModule = useUpdateModule();
  const renameWorkItem = useRenameCockpitWorkItem(wsId);
  return useCallback(async (row: PlanRow, name: string, directorySync?: "sync" | "defer" | "force"): Promise<NodeDirectorySyncResult | undefined> => {
    const title = name.trim();
    if (!title) return;
    if (row.kind === "project") {
      if (!row.node.project_id) return;
      // A project has no folder of its own, so `directorySync` means nothing.
      await updateProject.mutateAsync({ id: row.node.project_id, title });
      return;
    }
    if (row.kind === "module") {
      if (!row.node.module_id) return;
      try {
        const module = await updateModule.mutateAsync({ id: row.node.module_id, title, ...(directorySync ? { directory_sync: directorySync } : {}) });
        return module.directory_sync;
      } catch (error) {
        // Module writes go through their own client; translate the refusal so
        // a running-task 409 reaches the same dialog the node writes use.
        throw cockpitWriteError(error);
      }
    }
    const node = await renameWorkItem.mutateAsync({ id: row.node.id, name: title, ...(directorySync ? { directorySync } : {}) });
    return node.directory_sync;
  }, [renameWorkItem, updateModule, updateProject]);
}
