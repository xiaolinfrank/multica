import { z } from "zod";
import { createDraftStore } from "../drafts/create-draft-store";

const id = z.string().min(1);
const key = z.string().uuid();
const revision = z.number().int().positive();
const reviewer = z.object({ expected_revision: revision, handoff_key: key, reviewer_id: id, reason: z.string() });
const reference = { reference_key: key, version_id: id, purpose: z.enum(["input", "output", "evidence", "reference"]) };
const producerBase = { expected_revision: revision, command_key: key, reason: z.string() };
const producerBody = z.union([
  z.object({ ...producerBase, issue_id: id, new_issue: z.never().optional() }),
  z.object({ ...producerBase, issue_id: z.never().optional(), new_issue: z.object({ title: id, description: z.string(),
    assignee_type: z.enum(["member", "agent", "squad"]).nullable().optional(), assignee_id: id.nullable().optional(),
    priority: z.enum(["none", "urgent", "high", "medium", "low"]).optional(), due_date: id.nullable().optional(),
  }).refine((value) => Boolean(value.assignee_type) === Boolean(value.assignee_id)) }),
]);
const command = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("producer"), artifactId: id, body: producerBody }),
  z.object({ kind: z.literal("artifact_reviewer"), artifactId: id, body: reviewer }),
  z.object({ kind: z.literal("acceptance_reviewer"), nodeId: id, requestId: id, body: reviewer }),
  z.object({ kind: z.literal("node_reference"), artifactId: id, body: z.object({ ...reference, node_id: id }) }),
  z.object({ kind: z.literal("meeting_reference"), artifactId: id, body: z.object({ ...reference, meeting_id: id }) }),
]);
export type CockpitArtifactPendingCommand = z.infer<typeof command>;
const persisted = z.object({ pending: z.record(z.string(), command) });

/** Durable command intent survives dialog closure and an ambiguous network result. */
export const useCockpitArtifactCommandStore = createDraftStore<z.infer<typeof persisted>>({
  storageKey: "multica_cockpit_artifact_commands", emptyData: { pending: {} },
  hasMeaningful: (draft) => Object.keys(draft.pending).length > 0,
  migrateData: (raw) => {
    const parsed = persisted.safeParse(raw);
    return parsed.success ? parsed.data : { pending: {} };
  },
});
export const cockpitArtifactCommandDraftKey = (wsId: string, kind: CockpitArtifactPendingCommand["kind"], ...ids: string[]) => JSON.stringify([wsId, kind, ...ids]);

function commandIdentity(value: CockpitArtifactPendingCommand) {
  return "command_key" in value.body ? value.body.command_key : "handoff_key" in value.body ? value.body.handoff_key : value.body.reference_key;
}

export function prepareCockpitArtifactCommand<T extends CockpitArtifactPendingCommand>(draftKey: string, value: T): T {
  const state = useCockpitArtifactCommandStore.getState();
  const existing = state.draft.pending[draftKey];
  if (existing) {
    if (existing.kind !== value.kind || ("artifactId" in existing ? !("artifactId" in value) || existing.artifactId !== value.artifactId
      : !("nodeId" in value) || existing.nodeId !== value.nodeId || existing.requestId !== value.requestId)) throw new Error("artifact_command_scope_changed");
    // Scope and kind are checked; the stored intent, including its original key,
    // is the command to retry even if a caller has observed newer server facts.
    return existing as T;
  }
  const pending = command.parse(value) as T;
  state.setDraft({ pending: { ...state.draft.pending, [draftKey]: pending } });
  return pending;
}

/** Call only for a confirmed receipt or a definitive rejection, never a lost response. */
export function settleCockpitArtifactCommand(draftKey: string, observedCommandKey: string) {
  const state = useCockpitArtifactCommandStore.getState();
  const existing = state.draft.pending[draftKey];
  if (!existing || commandIdentity(existing) !== observedCommandKey) return;
  const pending = { ...state.draft.pending };
  delete pending[draftKey];
  state.setDraft({ pending });
}
