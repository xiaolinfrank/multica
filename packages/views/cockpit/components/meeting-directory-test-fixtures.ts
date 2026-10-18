import type * as D from "@multica/core/types";
import type { CockpitLifecycleCommandDetail } from "@multica/core/types";

export const directoryId = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const WS = directoryId(1), MEETING = directoryId(2), ROOT = directoryId(3), OP = directoryId(4), STEP = directoryId(5), USER = directoryId(6), KEY = directoryId(7), OTHER = directoryId(8);
export const HASH = "a".repeat(64), TOKEN = "b".repeat(64), TIME = "2026-10-11T01:02:03Z";
const binding = { nas_dir: "", revision: 1 };
const counts = { total: 1, pending: 1, running: 0, retry_wait: 0, satisfied: 0, needs_attention: 0, abandoned: 0 };
export function principal(): D.CockpitDirectoryPrincipal {
  return { source: "human", actor_type: "member", actor_id: USER, actor_name: "Coordinator", credential_owner_user_id: USER,
    authorizing_user_id: USER, authorizing_user_name: "Coordinator", confirmed_by_user_id: USER,
    run_id: null, issue_id: null, agent_id: null, runtime_id: null, relation_kind: "none", agenda_reference_id: null };
}
export function target(): D.CockpitDirectoryTarget {
  return { root_id: ROOT, root_path: "/approved", prepare_subpath: "meetings", relative_directory: "meetings/review",
    directory: "/approved/meetings/review", target_hash: HASH, root_config_hash: HASH };
}
export function grant(): D.CockpitDirectoryGrant {
  return { kind: "human", command_key: KEY, revision: 1, responsible_user_id: USER, principal: principal(), target_hash: HASH, root_config_hash: HASH, accepted_at: TIME, observed_binding: binding };
}
export function operation(): D.CockpitDirectoryOperationHeader {
  return { workspace_id: WS, meeting_id: MEETING, id: OP, revision: 1, state: "active", command_key: KEY, request_hash: HASH,
    plan_hash: HASH, target: target(), created_by_type: "member", created_by: USER, created_by_name: "Coordinator", source_principal: principal(),
    responsible_user_id: USER, responsible_user_name: "Coordinator", last_grant: grant(), created_at: TIME, updated_at: TIME,
    finished_at: null, observed_binding: binding, accepted_binding_revision: null, bind_after_base: true, binding_result: "pending",
    counts, can_retry: false, can_pause: true, can_resume: false, can_claim: false, can_abandon: true, blocked_reasons: [] };
}
export function preview(): D.CockpitDirectoryPreview {
  return { workspace_id: WS, meeting_id: MEETING, target: target(), plan_hash: HASH, observed_binding: binding, bind_after_base: true,
    steps: [{ step_id: null, position: 0, parent_position: null, kind: "base", label: "Meeting", relative_path: "meetings/review", path_hash: HASH, planned_state: "missing", error_code: "" }],
    counts: { total: 1, exists: 0, missing: 1, conflict: 0, unknown: 0 }, context_token: TOKEN, can_confirm: true, blocked_reasons: [], checked_at: TIME, principal: principal() };
}
export function body(): D.CockpitDirectoryCreateInput {
  return { mode: "prepare", root_id: ROOT, relative_directory: "meetings/review", partitions: [], observed_nas_dir: "", observed_binding_revision: 1,
    bind_after_base: true, command_key: KEY, expected_revision: 1, context_token: TOKEN };
}
export function receipt(): D.CockpitDirectoryCommandReceipt {
  return { directory_operation_id: OP, directory_step_ids: [STEP], request_hash: HASH, context_token: TOKEN, plan_hash: HASH, target: target(),
    observed_binding: binding, bind_after_base: true, operation_revision: 1, state: "active", responsible_user_id: USER, authorized_at: TIME,
    reason: "", principal: principal(), grant: grant() };
}
export function result(): D.CockpitDirectoryCommandResult {
  return { workspace_id: WS, meeting_id: MEETING, command_key: KEY, action: "directory_prepare", replayed: false, receipt: receipt(), current: operation() };
}
export function history(): CockpitLifecycleCommandDetail {
  return { workspace_id: WS, meeting_id: MEETING, command_key: KEY, action: "directory_prepare", actor_type: "member", actor_id: USER, actor_name: "Coordinator",
    created_at: TIME, revision: 9, issue_id: null, directory_operation_id: OP, directory_step_id: null,
    receipt: { revision: 9, issue_id: null, request_hash: HASH, reason: "",
      previous_occurrence: null, occurrence: null, materials: null, directory: receipt() } };
}

export function summary(): D.CockpitDirectorySummary {
  return { workspace_id: WS, meeting_id: MEETING, generated_at: TIME, binding, binding_candidate: target(), binding_candidate_reason: "",
    capabilities: { available: true, can_preview: true, can_create: true }, blocked_reasons: [], current: operation(), history_total: 1, unfinished_total: 1, needs_attention_total: 0 };
}
export function step(overrides: Partial<D.CockpitDirectoryStepMetadata> = {}): D.CockpitDirectoryStepMetadata {
  return { id: STEP, operation_id: OP, position: 0, kind: "base", label: "Meeting directory", relative_path: "meetings/review", state: "pending", revision: 1,
    grant_command_key: KEY, grant_revision: 1, attempt_count: 0, last_attempt_id: null, last_observed_at: null, outcome: "", last_error_code: "", can_retry: false, blocked_reasons: [], ...overrides };
}
