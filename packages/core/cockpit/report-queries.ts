import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import { cockpitKeys } from "./queries";
import { requireCockpitReadResult } from "./errors";
import type { CockpitScope } from "./navigation";
import { cockpitReportData } from "./report-model";

/** Read once for a presentation; realtime invalidation never silently changes an in-progress report. */
export function cockpitReportOptions(wsId: string, scope: CockpitScope, asOf: string, sessionId: string) {
  return queryOptions({ queryKey: [...cockpitKeys.all(wsId), "report", scope, asOf, sessionId],
    queryFn: async ({ signal }) => cockpitReportData(requireCockpitReadResult(await api.getCockpitWorkOverview(wsId, {
      as_of: asOf, project_id: scope.projectId ?? undefined, module_id: scope.moduleId ?? undefined, attention_view: "team",
    }, signal))),
    enabled: false, staleTime: Infinity, gcTime: 0, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
}
