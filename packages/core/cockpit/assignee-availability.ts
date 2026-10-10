import { useQuery } from "@tanstack/react-query";
import { cockpitSelectedAssigneeOptions } from "./scope-selector-queries";

type AssigneeFact = { type: string; status: string; runtime_bound: boolean | null; can_assign: boolean; reason: string };
/** Planning eligibility is distinct from dispatching a run; offline agents can remain valid assignees. */
export function canChooseCockpitAssignee(item: AssigneeFact | undefined): boolean {
  if (!item || item.can_assign !== true || item.reason !== "") return false;
  if (item.type === "member") return item.status === "active";
  if (item.type === "agent") return item.runtime_bound === true && ["idle", "working", "blocked", "error", "offline"].includes(item.status);
  if (item.type === "squad") return item.status === "active" && item.runtime_bound === true;
  return false;
}
export function useCockpitAssigneeAvailability(wsId: string, type: string | null, id: string | null) {
  const query = useQuery(cockpitSelectedAssigneeOptions(wsId, type, id));
  const selected = query.data?.items.find((item) => item.type === type && item.id === id);
  return { ...query, selected, available: Boolean(id && type && !query.isError && !query.isFetching && canChooseCockpitAssignee(selected)) };
}
