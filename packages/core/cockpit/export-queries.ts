"use client";

import { useMutation } from "@tanstack/react-query";
import { api } from "../api";
import type { CockpitScope } from "./navigation";
import { CockpitUnconfirmedWriteError } from "./errors";

/** An explicit snapshot preparation, not a live subscription that refetches a large ledger on every event. */
export function usePrepareCockpitCsvExport(wsId: string) {
  return useMutation({ mutationFn: async ({ scope, signal }: { scope: CockpitScope; signal: AbortSignal }) => {
    const result = await api.getCockpitPlanExport(wsId, scope, signal);
    if (!result || result.workspace_id !== wsId || result.scope.project_id !== scope.projectId || result.scope.module_id !== scope.moduleId) throw new CockpitUnconfirmedWriteError();
    return result;
  } });
}
