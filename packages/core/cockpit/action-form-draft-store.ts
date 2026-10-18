import { z } from "zod";
import { createDraftStore } from "../drafts/create-draft-store";

const textFields = { title: z.string(), description: z.string(), sourceQuote: z.string() };
const formSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("proposal"), versionId: z.string(), ...textFields }),
  z.object({ kind: z.literal("decision"), versionId: z.string(), sourceHash: z.string(), revision: z.number().int().positive(),
    editing: z.boolean(), ...textFields, outcome: z.enum(["create", "reuse", "dismiss"]), nodeId: z.string(), issueId: z.string(), reason: z.string(),
    fields: z.object({ assigneeType: z.enum(["member", "agent", "squad"]), assigneeId: z.string(), priority: z.string(), dueDate: z.string() }) }),
]);
export type CockpitActionFormDraft = z.infer<typeof formSchema>;
export type CockpitActionProposalDraft = Extract<CockpitActionFormDraft, { kind: "proposal" }>;
export type CockpitActionDecisionDraft = Extract<CockpitActionFormDraft, { kind: "decision" }>;
const persisted = z.object({ forms: z.record(z.string(), formSchema) });

/** Unsubmitted inputs only. Confirmed commands and their retry keys use action-command-store. */
export const useCockpitActionFormDraftStore = createDraftStore<{ forms: Record<string, CockpitActionFormDraft> }>({
  storageKey: "multica_cockpit_action_form_drafts", emptyData: { forms: {} },
  hasMeaningful: (draft) => Object.keys(draft.forms).length > 0,
  migrateData: (raw) => {
    const parsed = persisted.safeParse(raw);
    return parsed.success ? parsed.data : { forms: {} };
  },
});

export function cockpitActionFormKey(wsId: string, kind: "proposal" | "decision", id: string): string {
  return JSON.stringify([wsId, kind, id]);
}

export function saveCockpitActionFormDraft(key: string, form: CockpitActionFormDraft): void {
  const store = useCockpitActionFormDraftStore.getState();
  store.setDraft({ forms: { ...store.draft.forms, [key]: formSchema.parse(form) } });
}

export function clearCockpitActionFormDraft(key: string): void {
  const store = useCockpitActionFormDraftStore.getState();
  if (!store.draft.forms[key]) return;
  const forms = { ...store.draft.forms };
  delete forms[key];
  store.setDraft({ forms });
}
