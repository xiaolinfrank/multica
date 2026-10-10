// @vitest-environment node
import { beforeEach, expect, it } from "vitest";
import { cockpitArtifactCommandDraftKey, prepareCockpitArtifactCommand, settleCockpitArtifactCommand, useCockpitArtifactCommandStore } from "./artifact-command-store";

const firstKey = "10000000-0000-4000-8000-000000000001";
const secondKey = "10000000-0000-4000-8000-000000000002";
const command = { kind: "producer" as const, artifactId: "artifact-1", body: { expected_revision: 2, command_key: firstKey, issue_id: "issue-1", reason: "Continue report" } };
beforeEach(() => useCockpitArtifactCommandStore.getState().clearDraft());

it("retries frozen intent across dialog reopening, newer revisions and changed choices", () => {
  const draftKey = cockpitArtifactCommandDraftKey("ws-1", "producer", "artifact-1");
  const frozen = prepareCockpitArtifactCommand(draftKey, command);
  const changed = { ...command, body: { ...command.body, expected_revision: 9, command_key: secondKey, issue_id: "issue-2" } };
  expect(prepareCockpitArtifactCommand(draftKey, changed)).toEqual(frozen);
  expect(useCockpitArtifactCommandStore.getState().hasDraft()).toBe(true);
  settleCockpitArtifactCommand(draftKey, firstKey);
  expect(prepareCockpitArtifactCommand(draftKey, changed)).toEqual(changed);
  settleCockpitArtifactCommand(draftKey, firstKey);
  expect(useCockpitArtifactCommandStore.getState().draft.pending[draftKey]).toEqual(changed);
});

it("isolates workspaces and refuses reuse of a pending slot for another resource", () => {
  const draftKey = cockpitArtifactCommandDraftKey("ws-1", "producer", "artifact-1");
  prepareCockpitArtifactCommand(draftKey, command);
  expect(() => prepareCockpitArtifactCommand(draftKey, { ...command, artifactId: "artifact-2" })).toThrow("artifact_command_scope_changed");
  const other = cockpitArtifactCommandDraftKey("ws-2", "producer", "artifact-1");
  prepareCockpitArtifactCommand(other, { ...command, body: { ...command.body, command_key: secondKey } });
  settleCockpitArtifactCommand(draftKey, firstKey);
  expect(useCockpitArtifactCommandStore.getState().draft.pending[other]?.body).toEqual({ ...command.body, command_key: secondKey });
});
