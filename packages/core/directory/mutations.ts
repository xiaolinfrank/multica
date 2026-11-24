import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { cockpitKeys } from "../cockpit/queries";
import { issueKeys } from "../issues/queries";
import { directoryKeys } from "./queries";

/** Repair one row's folder (create it, or rename it to the row's name). */
export function useSyncNodeDirectory(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, force }: { nodeId: string; force?: boolean }) =>
      api.syncCockpitNodeDirectory(wsId, nodeId, force ?? false),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: directoryKeys.plan(wsId) });
      void queryClient.invalidateQueries({ queryKey: cockpitKeys.board(wsId) });
    },
  });
}

/** Preview (default) or apply the plan-wide folder pass. */
export function useFillPlanDirectories(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { apply?: boolean; project_id?: string; force?: boolean }) =>
      api.fillCockpitPlanDirectories(wsId, body),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: directoryKeys.plan(wsId) });
      void queryClient.invalidateQueries({ queryKey: cockpitKeys.board(wsId) });
    },
  });
}

/** Allocate the issue's folder name if needed and create the folder on the
 *  server. The detail row calls this from "open folder" / "retry". */
export function useEnsureIssueDirectory(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (issueId: string) => api.ensureIssueDirectory(issueId),
    onSettled: (_data, _error, issueId) => {
      void queryClient.invalidateQueries({ queryKey: directoryKeys.issue(wsId, issueId) });
      void queryClient.invalidateQueries({ queryKey: issueKeys.detail(wsId, issueId) });
    },
  });
}
