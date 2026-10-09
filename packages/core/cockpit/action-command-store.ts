import { z } from "zod";
import { createDraftStore } from "../drafts/create-draft-store";

const assignment = {
  assignee_type: z.string().optional(), assignee_id: z.string().optional(), priority: z.string().optional(), due_date: z.string().optional(),
};
const commandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("proposal"), meeting_id: z.string(), version_id: z.string(),
    body: z.object({ proposal_key: z.string().uuid(), title: z.string(), description: z.string(), source_quote: z.string() }) }),
  z.object({ kind: z.literal("decision"), meeting_id: z.string(), action_id: z.string(), version_id: z.string(), source_content_hash: z.string(),
    body: z.object({ expected_revision: z.number().int().positive(), decision_key: z.string().uuid(), outcome: z.enum(["create", "reuse", "dismiss"]),
      node_id: z.string().optional(), issue_id: z.string().optional(), reason: z.string().optional(), ...assignment }) }),
  z.object({ kind: z.literal("task"), node_id: z.string(),
    body: z.object({ creation_key: z.string().uuid(), title: z.string(), description: z.string().optional(), ...assignment }) }),
]);
export type CockpitActionCommand = z.infer<typeof commandSchema>;
const persisted = z.object({ commands: z.record(z.string(), commandSchema) });

/** Confirmed user intent only. Lists, issue facts, and action records belong to Query. */
export const useCockpitActionCommandStore = createDraftStore<{ commands: Record<string, CockpitActionCommand> }>({
  storageKey: "multica_cockpit_action_commands", emptyData: { commands: {} },
  hasMeaningful: (draft) => Object.keys(draft.commands).length > 0,
  migrateData: (raw) => {
    const parsed = persisted.safeParse(raw);
    return parsed.success ? parsed.data : { commands: {} };
  },
});

export function rememberCockpitActionCommand(scope: string, command: CockpitActionCommand) {
  const store = useCockpitActionCommandStore.getState();
  if (store.draft.commands[scope]) return;
  store.setDraft({ commands: { ...store.draft.commands, [scope]: command } });
}

export function clearCockpitActionCommand(scope: string) {
  const store = useCockpitActionCommandStore.getState();
  if (!store.draft.commands[scope]) return;
  const commands = { ...store.draft.commands };
  delete commands[scope];
  store.setDraft({ commands });
}
