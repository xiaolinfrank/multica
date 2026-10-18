import { useMutation } from "@tanstack/react-query";
import { api } from "../api";
import { requireCockpitReadResult } from "./errors";
import type { CockpitChangePreview } from "../types";

/** A review session is one fixed, explicitly requested observation, never a live query. */
export function usePreviewCockpitChangeBatch(wsId: string) {
  return useMutation({ mutationFn: async (ids: string[]) => {
    if (ids.length === 0 || ids.length > 25 || new Set(ids).size !== ids.length) throw new Error("Invalid change review batch");
    const observations: CockpitChangePreview[] = [];
    for (let offset = 0; offset < ids.length; offset += 4) {
      observations.push(...await Promise.all(ids.slice(offset, offset + 4).map(async (id) => requireCockpitReadResult(await api.getCockpitChangePreview(wsId, id)))));
    }
    return observations;
  } });
}
