// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllRegisteredDrafts } from "../drafts/cleanup-registry";
import { setCurrentWorkspace } from "../platform/workspace-storage";
import { cockpitActionFormKey, clearCockpitActionFormDraft, saveCockpitActionFormDraft, useCockpitActionFormDraftStore, type CockpitActionDecisionDraft } from "./action-form-draft-store";
import { useCockpitActionCommandStore } from "./action-command-store";

const storageValues = vi.hoisted(() => new Map<string, string>());
vi.mock("../platform/storage", () => ({ defaultStorage: {
  getItem: (key: string) => storageValues.get(key) ?? null,
  setItem: (key: string, value: string) => { storageValues.set(key, value); },
  removeItem: (key: string) => { storageValues.delete(key); },
} }));
const flushWorkspace = () => new Promise<void>((resolve) => queueMicrotask(resolve));

const form: CockpitActionDecisionDraft = { kind: "decision", versionId: "version-1", sourceHash: "fixed-source", revision: 3,
  editing: false, title: "Verify interface", description: "Keep this draft", sourceQuote: "Quoted source", outcome: "reuse",
  nodeId: "node-1", issueId: "issue-1", reason: "", fields: { assigneeType: "member", assigneeId: "member-1", priority: "none", dueDate: "" } };

beforeEach(async () => {
  setCurrentWorkspace(null, null); await flushWorkspace(); storageValues.clear();
  useCockpitActionFormDraftStore.getState().clearDraft(); useCockpitActionCommandStore.getState().clearDraft();
});

describe("unsubmitted cockpit action drafts", () => {
  it("keeps selected IDs and the original source revision without creating a confirmation command or storing server snapshots", () => {
    const key = cockpitActionFormKey("ws-1", "decision", "action-1");
    const input = { ...form, issue: { id: "issue-1", status: "done" } };
    saveCockpitActionFormDraft(key, input);
    expect(useCockpitActionFormDraftStore.getState().draft.forms[key]).toEqual(form);
    expect(useCockpitActionCommandStore.getState().draft.commands).toEqual({});
  });

  it("isolates workspace, action and proposal drafts and clears only the confirmed form", () => {
    const first = cockpitActionFormKey("ws-1", "decision", "same-id");
    const second = cockpitActionFormKey("ws-2", "decision", "same-id");
    const proposal = cockpitActionFormKey("ws-1", "proposal", "same-id");
    saveCockpitActionFormDraft(first, form);
    saveCockpitActionFormDraft(second, { ...form, reason: "Other workspace" });
    saveCockpitActionFormDraft(proposal, { kind: "proposal", versionId: "version-2", title: "Draft", description: "", sourceQuote: "" });
    clearCockpitActionFormDraft(first);
    expect(useCockpitActionFormDraftStore.getState().draft.forms[first]).toBeUndefined();
    expect(useCockpitActionFormDraftStore.getState().draft.forms[second]).toMatchObject({ reason: "Other workspace" });
    expect(useCockpitActionFormDraftStore.getState().draft.forms[proposal]).toMatchObject({ kind: "proposal", versionId: "version-2" });
  });

  it("registers session cleanup so a later user cannot recover another user's action choices", () => {
    saveCockpitActionFormDraft(cockpitActionFormKey("ws-1", "decision", "action-1"), form);
    resetAllRegisteredDrafts();
    expect(useCockpitActionFormDraftStore.getState().draft.forms).toEqual({});
    expect(useCockpitActionFormDraftStore.getState().hasDraft()).toBe(false);
  });

  it("rehydrates the actual workspace namespace and ignores a previous workspace's late acknowledgement", async () => {
    const first = cockpitActionFormKey("ws-1", "decision", "same-action");
    const second = cockpitActionFormKey("ws-2", "decision", "same-action");
    setCurrentWorkspace("team-a", "ws-1"); await flushWorkspace();
    saveCockpitActionFormDraft(first, form);
    setCurrentWorkspace("team-b", "ws-2"); await flushWorkspace();
    expect(useCockpitActionFormDraftStore.getState().draft.forms).toEqual({});
    saveCockpitActionFormDraft(second, { ...form, reason: "Second workspace draft" });
    // A request from team-a can settle after navigation, but its captured key cannot clear team-b's form.
    await Promise.resolve().then(() => clearCockpitActionFormDraft(first));
    expect(useCockpitActionFormDraftStore.getState().draft.forms[second]).toMatchObject({ reason: "Second workspace draft" });
    setCurrentWorkspace("team-a", "ws-1"); await flushWorkspace();
    expect(useCockpitActionFormDraftStore.getState().draft.forms).toEqual({ [first]: form });
    setCurrentWorkspace("team-b", "ws-2"); await flushWorkspace();
    expect(useCockpitActionFormDraftStore.getState().draft.forms[second]).toMatchObject({ reason: "Second workspace draft" });
  });
});
