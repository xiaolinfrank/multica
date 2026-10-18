import { z } from "zod";
import { ApiError } from "../api";
import { parseWithFallback } from "../api/schema";

const bindingConflict = z.object({ code: z.literal("node_binding_exists"), workspace_id: z.string().min(1),
  creation_key: z.string().uuid(), existing_node_id: z.string().uuid() });
export type CockpitNodeBindingConflict = z.infer<typeof bindingConflict>;
/** Only a scoped, keyed refusal proves that this draft can be corrected safely. */
export function getCockpitNodeBindingConflict(error: unknown, wsId: string, creationKey: string) {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  if (!error.body || typeof error.body !== "object" || !("code" in error.body) || error.body.code !== "node_binding_exists") return null;
  const result = parseWithFallback<CockpitNodeBindingConflict | null>(error.body, bindingConflict, null, { endpoint: "POST /api/cockpit/nodes conflict" });
  return result?.workspace_id === wsId && result.creation_key === creationKey ? result : null;
}
