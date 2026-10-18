import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import { cockpitReadKeys } from "./read-queries";
export const cockpitActorLabelKeys = { all: (wsId: string) => [...cockpitReadKeys.all(wsId), "actor-label"] as const };
/** Naming one responsibility must never fetch the entire workspace roster. */
export function cockpitActorLabelOptions(wsId: string, type: string | null, id: string | null) {
  return queryOptions({ queryKey: [...cockpitActorLabelKeys.all(wsId), type, id], enabled: Boolean(wsId && id && ["member", "agent", "squad"].includes(type ?? "")),
    staleTime: 60_000, queryFn: async () => {
      if (!id) return null;
      if (type === "member") {
        const page = await api.searchCockpitScopeMembers(wsId, { ids: [id], page_size: 20 });
        if (!page) throw new Error("Could not resolve member");
        return page.items.find((member) => member.id === id)?.title ?? null;
      }
      if (type === "agent") { const value = await api.getAgent(id); return value.id === id && value.workspace_id === wsId ? value.name : null; }
      if (type === "squad") { const value = await api.getSquad(id); return value.id === id && value.workspace_id === wsId ? value.name : null; }
      return null;
    },
  });
}
