import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type { CockpitMemberSelectorQuery, CockpitNodeSelectorQuery, CockpitAssigneeSelectorQuery, CockpitAssigneeType } from "../types";
import { cockpitKeys } from "./queries";
import { requireCockpitReadResult } from "./errors";

export const cockpitScopeSelectorKeys = {
  all: (wsId: string) => [...cockpitKeys.surfaces(wsId), "scope-selectors"] as const,
  nodes: (wsId: string) => [...cockpitScopeSelectorKeys.all(wsId), "nodes"] as const,
  members: (wsId: string) => [...cockpitScopeSelectorKeys.all(wsId), "members"] as const,
};
export function cockpitScopeNodesOptions(wsId: string, params: CockpitNodeSelectorQuery = {}) {
  const query = { page_size: 20, eligible: true, ...params, q: params.q?.trim() || undefined };
  return queryOptions({ queryKey: [...cockpitScopeSelectorKeys.nodes(wsId), query],
    queryFn: async ({ signal }) => requireCockpitReadResult(await api.searchCockpitScopeNodes(wsId, query, signal)), enabled: Boolean(wsId) });
}
export function cockpitScopeMembersOptions(wsId: string, params: CockpitMemberSelectorQuery = {}) {
  const query = { page_size: 20, ...params, q: params.q?.trim() || undefined, ids: params.ids?.length ? [...params.ids].sort() : undefined };
  return queryOptions({ queryKey: [...cockpitScopeSelectorKeys.members(wsId), query],
    queryFn: async ({ signal }) => requireCockpitReadResult(await api.searchCockpitScopeMembers(wsId, query, signal)), enabled: Boolean(wsId) });
}
export function cockpitSelectedMemberOptions(wsId: string, userId: string) {
  return queryOptions({ queryKey: [...cockpitScopeSelectorKeys.members(wsId), "selected", userId],
    queryFn: async ({ signal }) => requireCockpitReadResult(await api.searchCockpitScopeMembers(wsId, { ids: [userId], page_size: 20 }, signal)),
    enabled: Boolean(wsId && userId) });
}

export function cockpitAssigneesOptions(wsId: string, params: CockpitAssigneeSelectorQuery = {}) {
  const query = { page_size: 20, kind: "all" as const, ...params, q: params.q?.trim() || undefined };
  return queryOptions({ queryKey: [...cockpitScopeSelectorKeys.all(wsId), "assignees", query],
    queryFn: async ({ signal }) => requireCockpitReadResult(await api.searchCockpitAssignees(wsId, query, signal)), enabled: Boolean(wsId) });
}
export function cockpitSelectedAssigneeOptions(wsId: string, type: string | null | undefined, id: string | null | undefined) {
  const selectedType: CockpitAssigneeType | undefined = type === "member" || type === "agent" || type === "squad" ? type : undefined;
  return queryOptions({ queryKey: [...cockpitScopeSelectorKeys.all(wsId), "selected-assignee", type ?? "", id ?? ""],
    queryFn: async ({ signal }) => {
      if (!selectedType || !id) throw new Error("cockpit_assignee_selection_invalid");
      return requireCockpitReadResult(await api.searchCockpitAssignees(wsId, { selected_type: selectedType, selected_id: id, page_size: 20 }, signal));
    }, enabled: Boolean(wsId && selectedType && id) });
}
