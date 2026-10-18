// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { CockpitUnconfirmedReadError, CockpitUnconfirmedWriteError } from "../cockpit/errors";
import { cockpitDirectoryCommandAcknowledged } from "../cockpit/meeting-directory";
import type * as D from "../types/cockpit-meeting-directory";
import type { CockpitLifecycleCommandDetail } from "../types/cockpit-meeting-lifecycle";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const WS = id(1), MEETING = id(2), ROOT = id(3), OP = id(4), STEP = id(5), USER = id(6), KEY = id(7), OTHER = id(8);
const HASH = "a".repeat(64), TOKEN = "b".repeat(64), TIME = "2026-10-11T01:02:03Z";
const binding = { nas_dir: "", revision: 1 };
const counts = { total: 1, pending: 1, running: 0, retry_wait: 0, satisfied: 0, needs_attention: 0, abandoned: 0 };
function principal(): D.CockpitDirectoryPrincipal {
  return { source: "human", actor_type: "member", actor_id: USER, actor_name: "Coordinator", credential_owner_user_id: USER,
    authorizing_user_id: USER, authorizing_user_name: "Coordinator", confirmed_by_user_id: USER,
    run_id: null, issue_id: null, agent_id: null, runtime_id: null, relation_kind: "none", agenda_reference_id: null };
}
function target(): D.CockpitDirectoryTarget {
  return { root_id: ROOT, root_path: "/approved", prepare_subpath: "meetings", relative_directory: "meetings/review",
    directory: "/approved/meetings/review", target_hash: HASH, root_config_hash: HASH };
}
function grant(): D.CockpitDirectoryGrant {
  return { kind: "human", command_key: KEY, revision: 1, responsible_user_id: USER, principal: principal(), target_hash: HASH, root_config_hash: HASH, accepted_at: TIME, observed_binding: binding };
}
function operation(): D.CockpitDirectoryOperationHeader {
  return { workspace_id: WS, meeting_id: MEETING, id: OP, revision: 1, state: "active", command_key: KEY, request_hash: HASH,
    plan_hash: HASH, target: target(), created_by_type: "member", created_by: USER, created_by_name: "Coordinator", source_principal: principal(),
    responsible_user_id: USER, responsible_user_name: "Coordinator", last_grant: grant(), created_at: TIME, updated_at: TIME,
    finished_at: null, observed_binding: binding, accepted_binding_revision: null, bind_after_base: true, binding_result: "pending",
    counts, can_retry: false, can_pause: true, can_resume: false, can_claim: false, can_abandon: true, blocked_reasons: [] };
}
function preview(): D.CockpitDirectoryPreview {
  return { workspace_id: WS, meeting_id: MEETING, target: target(), plan_hash: HASH, observed_binding: binding, bind_after_base: true,
    steps: [{ step_id: null, position: 0, parent_position: null, kind: "base", label: "Meeting", relative_path: "meetings/review", path_hash: HASH, planned_state: "missing", error_code: "" }],
    counts: { total: 1, exists: 0, missing: 1, conflict: 0, unknown: 0 }, context_token: TOKEN, can_confirm: true, blocked_reasons: [], checked_at: TIME, principal: principal() };
}
function body(): D.CockpitDirectoryCreateInput {
  return { mode: "prepare", root_id: ROOT, relative_directory: "meetings/review", partitions: [], observed_nas_dir: "", observed_binding_revision: 1,
    bind_after_base: true, command_key: KEY, expected_revision: 1, context_token: TOKEN };
}
function receipt(): D.CockpitDirectoryCommandReceipt {
  return { directory_operation_id: OP, directory_step_ids: [STEP], request_hash: HASH, context_token: TOKEN, plan_hash: HASH, target: target(),
    observed_binding: binding, bind_after_base: true, operation_revision: 1, state: "active", responsible_user_id: USER, authorized_at: TIME,
    reason: "", principal: principal(), grant: grant() };
}
function result(): D.CockpitDirectoryCommandResult {
  return { workspace_id: WS, meeting_id: MEETING, command_key: KEY, action: "directory_prepare", replayed: false, receipt: receipt(), current: operation() };
}
function history(): CockpitLifecycleCommandDetail {
  return { workspace_id: WS, meeting_id: MEETING, command_key: KEY, action: "directory_prepare", actor_type: "member", actor_id: USER, actor_name: "Coordinator",
    created_at: TIME, revision: 9, issue_id: null, directory_operation_id: OP, directory_step_id: null,
    receipt: { revision: 9, issue_id: null, request_hash: HASH, reason: "", previous_occurrence: null, occurrence: null, materials: null, directory: receipt() } };
}
function reply(value: unknown) {
  const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock); return { client: new ApiClient("https://example.test"), fetchMock };
}
afterEach(() => vi.unstubAllGlobals());

describe("meeting directory API boundaries", () => {
  it("reads only the requested workspace root and bounded metadata", async () => {
    const page = { workspace_id: WS, page_size: 25, total: 1, next_cursor: null, items: [{ root_id: ROOT, root_path: "/approved", prepare_subpath_count: 1 }] };
    const read = reply(page); await expect(read.client.getCockpitDirectoryRoots(WS)).resolves.toEqual(page);
    expect(read.fetchMock.mock.calls[0]?.[1].headers).toMatchObject({ "X-Workspace-ID": WS });
    expect(read.fetchMock).toHaveBeenCalledTimes(1);
    for (const bad of [{ ...page, workspace_id: OTHER }, { ...page, page_size: 100 }, { ...page, total: 0 }, { ...page, items: [...page.items, ...page.items] }]) {
      await expect(reply(bad).client.getCockpitDirectoryRoots(WS)).resolves.toBeNull();
    }
    const detail = { workspace_id: WS, ...page.items[0], prepare_subpaths: ["meetings"] };
    await expect(reply(detail).client.getCockpitDirectoryRoot(WS, ROOT)).resolves.toEqual(detail);
    for (const bad of [{ ...detail, root_id: OTHER }, { ...detail, prepare_subpath_count: 2 }, { ...detail, prepare_subpaths: [] }]) {
      await expect(reply(bad).client.getCockpitDirectoryRoot(WS, ROOT)).resolves.toBeNull();
    }
  });

  it("rejects a confirmable preview without verified identity, complete steps or the original binding", async () => {
    await expect(reply(preview()).client.previewCockpitMeetingDirectory(WS, MEETING, body())).resolves.toEqual(preview());
    const value = preview();
    for (const bad of [{ ...value, context_token: "" }, { ...value, principal: null }, { ...value, meeting_id: OTHER },
      { ...value, target: { ...target(), root_id: OTHER } }, { ...value, observed_binding: { ...binding, revision: 2 } },
      { ...value, principal: { ...principal(), confirmed_by_user_id: OTHER } }, { ...value, steps: [] },
      { ...value, steps: [{ ...value.steps[0], planned_state: "unknown" }] }, { ...value, blocked_reasons: ["root_unavailable"] }]) {
      await expect(reply(bad).client.previewCockpitMeetingDirectory(WS, MEETING, body())).rejects.toBeInstanceOf(CockpitUnconfirmedReadError);
    }
  });

  it("accepts a fixed create receipt even after current progress moves, without changing the command", async () => {
    const value = result(); value.current = { ...operation(), revision: 8, state: "completed", finished_at: TIME, binding_result: "updated",
      accepted_binding_revision: 2, counts: { ...counts, pending: 0, satisfied: 1 }, can_pause: false, can_abandon: false };
    const read = reply(value); await expect(read.client.createCockpitMeetingDirectory(WS, MEETING, body())).resolves.toEqual(value);
    expect(JSON.parse(read.fetchMock.mock.calls[0]?.[1].body)).toEqual(body());
    const confirmed = result();
    for (const bad of [{ ...confirmed, command_key: OTHER }, { ...confirmed, meeting_id: OTHER },
      { ...confirmed, receipt: { ...receipt(), context_token: HASH } }, { ...confirmed, receipt: { ...receipt(), directory_step_ids: [] } },
      { ...confirmed, receipt: { ...receipt(), grant: { ...grant(), command_key: OTHER } } },
      { ...confirmed, receipt: { ...receipt(), target: { ...target(), relative_directory: "meetings/other" } } },
      { ...confirmed, current: { ...operation(), id: OTHER } }]) {
      await expect(reply(bad).client.createCockpitMeetingDirectory(WS, MEETING, body())).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    }
  });

  it("recovers exact directory commands from history without confusing preparation operations", async () => {
    const value = history(); const read = reply(value);
    const detail = await read.client.getCockpitLifecycleCommand(WS, MEETING, KEY);
    expect(detail).toEqual(value); expect(cockpitDirectoryCommandAcknowledged(detail!, "directory_prepare", body())).toBe(true);
    expect(read.fetchMock.mock.calls[0]?.[1].method).not.toBe("POST");
    for (const bad of [{ ...value, directory_operation_id: OTHER }, { ...value, operation_id: OP },
      { ...value, actor_type: "agent" }, { ...value, actor_id: OTHER },
      { ...value, receipt: { ...value.receipt, request_hash: TOKEN } }]) {
      await expect(reply(bad).client.getCockpitLifecycleCommand(WS, MEETING, KEY)).resolves.toBeNull();
    }
  });

  it("retains prior grants for pause but requires a new exact grant for retry and human claim", async () => {
    const paused = result(); paused.command_key = OTHER; paused.action = "directory_pause";
    paused.receipt = { ...receipt(), directory_step_ids: [], state: "paused", reason: "Check the mount" };
    const pause = { command_key: OTHER, expected_revision: 2, transition: "pause", reason: "Check the mount" };
    await expect(reply(paused).client.controlCockpitDirectory(WS, MEETING, OP, pause)).resolves.toEqual(paused);
    const retry = { command_key: OTHER, expected_revision: 2, step_ids: [STEP], context_token: TOKEN, reason: "Mount restored" };
    const resumed = result(); resumed.command_key = OTHER; resumed.action = "directory_retry";
    resumed.receipt = { ...receipt(), reason: retry.reason, grant: { ...grant(), command_key: OTHER, revision: 2 } };
    await expect(reply(resumed).client.retryCockpitDirectory(WS, MEETING, OP, retry)).resolves.toEqual(resumed);
    for (const bad of [{ ...resumed, receipt: { ...resumed.receipt, directory_step_ids: [STEP, id(90)] } },
      { ...resumed, receipt: { ...resumed.receipt, grant: grant() } }]) {
      await expect(reply(bad).client.retryCockpitDirectory(WS, MEETING, OP, retry)).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    }
    const claim = { command_key: OTHER, expected_revision: 2, transition: "claim", reason: "Taking responsibility" };
    const claimed = { ...resumed, action: "directory_claim", receipt: { ...resumed.receipt, reason: claim.reason } };
    await expect(reply(claimed).client.controlCockpitDirectory(WS, MEETING, OP, claim)).resolves.toEqual(claimed);
    await expect(reply({ ...claimed, receipt: { ...claimed.receipt, directory_step_ids: [] } }).client.controlCockpitDirectory(WS, MEETING, OP, claim)).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
  });

  it("requires retry previews to identify precisely the selected original steps", async () => {
    const base = preview();
    const value = { ...base, operation_id: OP, operation_revision: 3, step_ids: [STEP], steps: [{ ...base.steps[0], step_id: STEP }] };
    await expect(reply(value).client.previewCockpitDirectoryRetry(WS, MEETING, OP, { step_ids: [STEP] })).resolves.toEqual(value);
    for (const bad of [{ ...value, step_ids: [OTHER] }, { ...value, operation_id: OTHER }, { ...value, context_token: "" },
      { ...value, steps: [{ ...value.steps[0], step_id: OTHER }] }, { ...value, steps: [...value.steps, ...value.steps] }]) {
      await expect(reply(bad).client.previewCockpitDirectoryRetry(WS, MEETING, OP, { step_ids: [STEP] })).rejects.toBeInstanceOf(CockpitUnconfirmedReadError);
    }
  });

  it("does not call a task-token grant a human confirmation or use its runtime owner as the authorizer", async () => {
    const machine: D.CockpitDirectoryPrincipal = { ...principal(), source: "task_token", actor_type: "agent", actor_id: id(20), agent_id: id(20),
      credential_owner_user_id: id(21), authorizing_user_id: USER, confirmed_by_user_id: null,
      run_id: id(22), issue_id: id(23), runtime_id: id(24), relation_kind: "agenda_preparation", agenda_reference_id: id(25) };
    const value = preview(); value.principal = machine;
    await expect(reply(value).client.previewCockpitMeetingDirectory(WS, MEETING, body())).resolves.toEqual(value);
    for (const patch of [{ confirmed_by_user_id: USER }, { actor_id: USER }, { run_id: null }, { agenda_reference_id: null }, { relation_kind: "same_project" }]) {
      await expect(reply({ ...value, principal: { ...machine, ...patch } }).client.previewCockpitMeetingDirectory(WS, MEETING, body())).rejects.toBeInstanceOf(CockpitUnconfirmedReadError);
    }
  });

  it("makes unknown operation states read-only and keeps full step pages scoped", async () => {
    const value = { ...operation(), state: "future-state", can_retry: true, can_pause: true, can_resume: true, can_claim: true, can_abandon: true };
    await expect(reply(value).client.getCockpitDirectoryOperation(WS, MEETING, OP)).resolves.toMatchObject({ state: "future-state", can_retry: false, can_pause: false, can_resume: false, can_claim: false, can_abandon: false });
    const step: D.CockpitDirectoryStepMetadata = { id: STEP, operation_id: OP, position: 0, kind: "base", label: "Meeting", relative_path: "meetings/review",
      state: "pending", revision: 1, grant_command_key: KEY, grant_revision: 1, attempt_count: 0, last_attempt_id: null,
      last_observed_at: null, outcome: null, last_error_code: "", can_retry: false, blocked_reasons: [] };
    const page = { workspace_id: WS, meeting_id: MEETING, operation_id: OP, items: [step], total: 1, counts };
    await expect(reply(page).client.getCockpitDirectorySteps(WS, MEETING, OP)).resolves.toEqual(page);
    for (const bad of [{ ...page, operation_id: OTHER }, { ...page, items: [] }, { ...page, total: 2 },
      { ...page, items: [{ ...step, operation_id: OTHER }] }, { ...page, items: [step, step] }]) {
      await expect(reply(bad).client.getCockpitDirectorySteps(WS, MEETING, OP)).resolves.toBeNull();
    }
  });
});
