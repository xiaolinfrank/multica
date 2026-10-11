-- name: CreateCockpitDirectoryOperation :one
INSERT INTO cockpit_meeting_directory_operation(id,workspace_id,meeting_id,creation_command_key,request_hash,plan_hash,state,root_id,root_path,prepare_subpath,relative_directory,directory,target_hash,root_config_hash,observed_nas_dir,observed_binding_revision,bind_after_base,created_by_type,created_by,credential_owner_user_id,authorizing_user_id,source_run_id,source_issue_id,source_agent_id,source_runtime_id,source_task_token_id,source_relation_kind,source_agenda_reference_id,source_principal,last_grant_command_key,responsible_user_id,input,receipt)
VALUES(sqlc.arg(id),sqlc.arg(workspace_id),sqlc.arg(meeting_id),sqlc.arg(creation_command_key),sqlc.arg(request_hash),sqlc.arg(plan_hash),sqlc.arg(state),sqlc.arg(root_id),sqlc.arg(root_path),sqlc.arg(prepare_subpath),sqlc.arg(relative_directory),sqlc.arg(directory),sqlc.arg(target_hash),sqlc.arg(root_config_hash),sqlc.arg(observed_nas_dir),sqlc.arg(observed_binding_revision),sqlc.arg(bind_after_base),sqlc.arg(created_by_type),sqlc.arg(created_by),sqlc.arg(credential_owner_user_id),sqlc.arg(authorizing_user_id),sqlc.narg(source_run_id),sqlc.narg(source_issue_id),sqlc.narg(source_agent_id),sqlc.narg(source_runtime_id),sqlc.narg(source_task_token_id),sqlc.arg(source_relation_kind),sqlc.narg(source_agenda_reference_id),sqlc.arg(source_principal),sqlc.arg(last_grant_command_key),sqlc.arg(responsible_user_id),sqlc.arg(input),sqlc.arg(receipt)) RETURNING *;

-- name: GetCockpitDirectoryOperation :one
SELECT * FROM cockpit_meeting_directory_operation WHERE workspace_id=$1 AND meeting_id=$2 AND id=$3;

-- name: LockCockpitDirectoryOperation :one
SELECT * FROM cockpit_meeting_directory_operation WHERE workspace_id=$1 AND meeting_id=$2 AND id=$3 FOR UPDATE;

-- name: FindOpenCockpitDirectoryTarget :one
SELECT * FROM cockpit_meeting_directory_operation WHERE workspace_id=$1 AND meeting_id=$2 AND root_id=$3 AND target_hash=$4 AND finished_at IS NULL;

-- name: FindLegacyCockpitDirectoryPlan :one
SELECT * FROM cockpit_meeting_directory_operation WHERE workspace_id=sqlc.arg(workspace_id) AND meeting_id=sqlc.arg(meeting_id) AND created_by_type=sqlc.arg(created_by_type) AND created_by=sqlc.arg(created_by) AND plan_hash=sqlc.arg(plan_hash) AND authorizing_user_id=sqlc.arg(authorizing_user_id) AND source_issue_id IS NOT DISTINCT FROM sqlc.narg(source_issue_id)::uuid ORDER BY created_at DESC,id DESC LIMIT 1;

-- name: GetCurrentCockpitDirectoryOperation :one
SELECT * FROM cockpit_meeting_directory_operation WHERE workspace_id=$1 AND meeting_id=$2 AND finished_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 1;

-- name: CountCockpitDirectoryOperations :one
SELECT count(*)::bigint AS total,count(*) FILTER(WHERE finished_at IS NULL)::bigint AS unfinished,count(*) FILTER(WHERE state='needs_attention')::bigint AS needs_attention
FROM cockpit_meeting_directory_operation WHERE workspace_id=$1 AND meeting_id=$2;

-- name: ListCockpitDirectoryOperations :many
SELECT o.id,o.workspace_id,o.meeting_id,o.creation_command_key,o.request_hash,o.plan_hash,o.revision,o.state,o.root_id,o.root_path,o.prepare_subpath,o.relative_directory,o.directory,o.target_hash,o.root_config_hash,o.observed_nas_dir,o.observed_binding_revision,o.accepted_binding_revision,o.bind_after_base,o.binding_result,o.created_by_type,o.created_by,o.credential_owner_user_id,o.authorizing_user_id,o.source_run_id,o.source_issue_id,o.source_agent_id,o.source_runtime_id,o.source_task_token_id,o.source_relation_kind,o.source_agenda_reference_id,o.source_principal,o.last_grant_command_key,o.responsible_user_id,NULL::jsonb AS input,NULL::jsonb AS receipt,o.created_at,o.updated_at,o.finished_at FROM cockpit_meeting_directory_operation o
WHERE o.workspace_id=sqlc.arg(workspace_id) AND o.meeting_id=sqlc.arg(meeting_id)
AND(sqlc.narg(after_id)::uuid IS NULL OR (o.created_at,o.id)<(sqlc.arg(after_time)::timestamptz,sqlc.narg(after_id)))
ORDER BY o.created_at DESC,o.id DESC LIMIT sqlc.arg(page_limit);

-- name: UpdateCockpitDirectoryOperation :one
UPDATE cockpit_meeting_directory_operation SET state=sqlc.arg(state),revision=revision+1,
 responsible_user_id=sqlc.arg(responsible_user_id),last_grant_command_key=sqlc.arg(last_grant_command_key),
 binding_result=sqlc.arg(binding_result),accepted_binding_revision=sqlc.narg(accepted_binding_revision),
 updated_at=now(),finished_at=CASE WHEN sqlc.arg(state)::text IN ('completed','abandoned') THEN now() ELSE NULL END
WHERE workspace_id=sqlc.arg(workspace_id) AND meeting_id=sqlc.arg(meeting_id) AND id=sqlc.arg(id) AND revision=sqlc.arg(expected_revision) AND finished_at IS NULL RETURNING *;

-- name: UpdateCockpitDirectoryBinding :one
UPDATE cockpit_meeting SET nas_dir=sqlc.arg(nas_dir)
WHERE workspace_id=sqlc.arg(workspace_id) AND id=sqlc.arg(meeting_id) AND nas_dir_revision=sqlc.arg(expected_revision) AND nas_dir=sqlc.arg(observed_nas_dir)
RETURNING nas_dir,nas_dir_revision;

-- name: CreateCockpitDirectoryStep :one
INSERT INTO cockpit_meeting_directory_step(id,workspace_id,meeting_id,operation_id,position,parent_step_id,kind,label,relative_path,path_hash,grant_command_key,grant_revision,next_attempt_at)
VALUES(sqlc.arg(id),sqlc.arg(workspace_id),sqlc.arg(meeting_id),sqlc.arg(operation_id),sqlc.arg(position),sqlc.narg(parent_step_id),sqlc.arg(kind),sqlc.arg(label),sqlc.arg(relative_path),sqlc.arg(path_hash),sqlc.arg(grant_command_key),sqlc.arg(grant_revision),sqlc.narg(next_attempt_at)) RETURNING *;

-- name: GetCockpitDirectoryStep :one
SELECT * FROM cockpit_meeting_directory_step WHERE workspace_id=$1 AND meeting_id=$2 AND operation_id=$3 AND id=$4;

-- name: LockCockpitDirectoryStep :one
SELECT * FROM cockpit_meeting_directory_step WHERE workspace_id=$1 AND meeting_id=$2 AND operation_id=$3 AND id=$4 FOR UPDATE;

-- name: ListCockpitDirectorySteps :many
SELECT * FROM cockpit_meeting_directory_step WHERE workspace_id=$1 AND operation_id=$2 ORDER BY position,id;

-- name: CountCockpitDirectoryStepStates :one
SELECT count(*)::bigint AS total,count(*) FILTER(WHERE state='pending')::bigint AS pending,
 count(*) FILTER(WHERE state='running')::bigint AS running,count(*) FILTER(WHERE state='retry_wait')::bigint AS retry_wait,
 count(*) FILTER(WHERE state='satisfied')::bigint AS satisfied,count(*) FILTER(WHERE state='needs_attention')::bigint AS needs_attention,
 count(*) FILTER(WHERE state='abandoned')::bigint AS abandoned
FROM cockpit_meeting_directory_step WHERE workspace_id=$1 AND operation_id=$2;

-- name: ListCockpitDirectoryDueCandidates :many
SELECT s.workspace_id,s.meeting_id,s.operation_id,s.id
FROM cockpit_meeting_directory_step s
WHERE s.state IN ('pending','retry_wait') AND s.next_attempt_at<=now()
ORDER BY s.next_attempt_at,s.id LIMIT 16;

-- name: ClaimOneCockpitDirectoryStep :one
WITH candidate AS MATERIALIZED (
 SELECT s.id FROM cockpit_meeting_directory_step s
 JOIN cockpit_meeting_directory_operation o ON o.workspace_id=s.workspace_id AND o.id=s.operation_id
 WHERE s.workspace_id=sqlc.arg(workspace_id) AND s.operation_id=sqlc.arg(operation_id) AND o.state='active'
 AND s.state IN ('pending','retry_wait') AND s.next_attempt_at<=now()
 AND(s.parent_step_id IS NULL OR EXISTS(SELECT 1 FROM cockpit_meeting_directory_step p WHERE p.workspace_id=s.workspace_id AND p.operation_id=s.operation_id AND p.id=s.parent_step_id AND p.state='satisfied'))
 ORDER BY s.next_attempt_at,s.id LIMIT 1 FOR UPDATE OF s SKIP LOCKED
)
UPDATE cockpit_meeting_directory_step s SET state='running',revision=s.revision+1,attempt_count=s.attempt_count+1,
 last_attempt_id=sqlc.arg(attempt_id),lease_token=sqlc.arg(lease_token),lease_expires_at=sqlc.arg(lease_expires_at),next_attempt_at=NULL,updated_at=now()
FROM candidate c WHERE s.id=c.id AND s.workspace_id=sqlc.arg(workspace_id) RETURNING s.*;

-- name: ListExpiredCockpitDirectorySteps :many
SELECT workspace_id,meeting_id,operation_id,id FROM cockpit_meeting_directory_step WHERE state='running' AND lease_expires_at<=now() ORDER BY lease_expires_at,id LIMIT 16;

-- name: UpdateCockpitDirectoryStep :one
UPDATE cockpit_meeting_directory_step SET state=sqlc.arg(state),revision=revision+1,
 grant_command_key=sqlc.arg(grant_command_key),grant_revision=sqlc.arg(grant_revision),
 next_attempt_at=sqlc.narg(next_attempt_at),lease_token=sqlc.narg(lease_token),lease_expires_at=sqlc.narg(lease_expires_at),
 last_observed_at=sqlc.narg(last_observed_at),outcome=sqlc.narg(outcome),last_error_code=sqlc.arg(last_error_code),updated_at=now()
WHERE workspace_id=sqlc.arg(workspace_id) AND operation_id=sqlc.arg(operation_id) AND id=sqlc.arg(id) AND revision=sqlc.arg(expected_revision) AND state NOT IN ('satisfied','abandoned') RETURNING *;

-- name: UnscheduleCockpitDirectorySteps :exec
UPDATE cockpit_meeting_directory_step SET next_attempt_at=NULL,updated_at=now()
WHERE workspace_id=$1 AND operation_id=$2 AND state IN ('pending','retry_wait') AND next_attempt_at IS NOT NULL;

-- name: ScheduleCockpitDirectorySteps :exec
UPDATE cockpit_meeting_directory_step s SET next_attempt_at=now(),updated_at=now()
WHERE s.workspace_id=$1 AND s.operation_id=$2 AND s.state IN ('pending','retry_wait') AND s.next_attempt_at IS NULL
AND(s.parent_step_id IS NULL OR EXISTS(SELECT 1 FROM cockpit_meeting_directory_step p WHERE p.workspace_id=s.workspace_id AND p.operation_id=s.operation_id AND p.id=s.parent_step_id AND p.state='satisfied'));

-- name: CreateCockpitDirectoryAttempt :one
INSERT INTO cockpit_meeting_directory_attempt(id,workspace_id,meeting_id,operation_id,step_id,attempt_number,grant_command_key,grant_revision,lease_token,state)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'running') RETURNING *;

-- name: GetCockpitDirectoryAttempt :one
SELECT * FROM cockpit_meeting_directory_attempt WHERE workspace_id=$1 AND meeting_id=$2 AND operation_id=$3 AND step_id=$4 AND id=$5;

-- name: FinishCockpitDirectoryAttempt :one
UPDATE cockpit_meeting_directory_attempt SET state=sqlc.arg(state),finished_at=now(),outcome=sqlc.narg(outcome),observed_at=sqlc.narg(observed_at),
 error_code=sqlc.arg(error_code),error_message=sqlc.arg(error_message),receipt=sqlc.narg(receipt)
WHERE workspace_id=sqlc.arg(workspace_id) AND id=sqlc.arg(id) AND lease_token=sqlc.arg(lease_token) AND state='running' RETURNING *;

-- name: RecordLateCockpitDirectoryObservation :execrows
UPDATE cockpit_meeting_directory_attempt SET late_receipt=$3,late_observed_at=now()
WHERE workspace_id=$1 AND id=$2 AND late_receipt IS NULL AND finished_at IS NOT NULL;

-- name: CountCockpitDirectoryAttempts :one
SELECT count(*) FROM cockpit_meeting_directory_attempt WHERE workspace_id=$1 AND step_id=$2;

-- name: CountCockpitDirectoryGrantAttempts :one
SELECT count(*) FROM cockpit_meeting_directory_attempt WHERE workspace_id=$1 AND step_id=$2 AND grant_command_key=$3;

-- name: ListCockpitDirectoryAttempts :many
SELECT id,step_id,attempt_number,state,started_at,finished_at,error_code,outcome,observed_at
FROM cockpit_meeting_directory_attempt WHERE workspace_id=sqlc.arg(workspace_id) AND step_id=sqlc.arg(step_id)
AND(sqlc.arg(before_number)::integer=0 OR attempt_number<sqlc.arg(before_number)) ORDER BY attempt_number DESC LIMIT sqlc.arg(page_limit);

-- name: CreateCockpitDirectoryCommand :exec
INSERT INTO cockpit_meeting_lifecycle_command(workspace_id,meeting_id,command_key,kind,actor_type,actor_id,request_hash,revision,agenda_revision,directory_operation_id,directory_step_id,receipt)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12);

-- name: GetLiveCockpitDirectoryTaskToken :one
SELECT * FROM task_token WHERE id=$1 AND workspace_id=$2 AND expires_at>clock_timestamp() FOR SHARE;

-- name: GetCockpitDirectoryPreparationRelation :one
WITH relations AS (
 SELECT 'work_package'::text AS kind,NULL::uuid AS agenda_reference_id,0 AS rank FROM cockpit_meeting_work_package w WHERE w.workspace_id=$1 AND w.meeting_id=$2 AND w.minutes_issue_id=$3
 UNION ALL SELECT 'agenda_preparation',r.id,1 FROM cockpit_meeting_agenda_reference r JOIN cockpit_meeting_agenda a ON a.workspace_id=r.workspace_id AND a.meeting_id=r.meeting_id AND a.id=r.agenda_id
 WHERE r.workspace_id=$1 AND r.meeting_id=$2 AND r.kind='issue' AND r.target_id=$3 AND r.purpose='preparation' AND r.removed_at IS NULL AND a.removed_at IS NULL
 UNION ALL SELECT CASE WHEN l.role='task' THEN 'legacy_task' ELSE 'direct_preparation' END,NULL::uuid,2 FROM cockpit_meeting_issue l
 WHERE l.workspace_id=$1 AND l.meeting_id=$2 AND l.issue_id=$3 AND (l.role='task' OR 'preparation'=ANY(l.roles))
)
SELECT kind,agenda_reference_id FROM relations ORDER BY rank,agenda_reference_id LIMIT 1;

-- name: HasCockpitDirectoryHistory :one
SELECT EXISTS(SELECT 1 FROM cockpit_meeting_directory_operation WHERE cockpit_meeting_directory_operation.workspace_id=$1 AND cockpit_meeting_directory_operation.meeting_id=$2)
 OR EXISTS(SELECT 1 FROM cockpit_meeting_directory_step WHERE cockpit_meeting_directory_step.workspace_id=$1 AND cockpit_meeting_directory_step.meeting_id=$2)
 OR EXISTS(SELECT 1 FROM cockpit_meeting_directory_attempt WHERE cockpit_meeting_directory_attempt.workspace_id=$1 AND cockpit_meeting_directory_attempt.meeting_id=$2);

-- name: HasCockpitDirectoryWorkspaceHistory :one
SELECT EXISTS(SELECT 1 FROM cockpit_meeting_directory_operation WHERE cockpit_meeting_directory_operation.workspace_id=$1)
 OR EXISTS(SELECT 1 FROM cockpit_meeting_directory_step WHERE cockpit_meeting_directory_step.workspace_id=$1)
 OR EXISTS(SELECT 1 FROM cockpit_meeting_directory_attempt WHERE cockpit_meeting_directory_attempt.workspace_id=$1);

-- name: DeleteCockpitDirectoryByWorkspace :exec
WITH attempts AS(DELETE FROM cockpit_meeting_directory_attempt WHERE cockpit_meeting_directory_attempt.workspace_id=$1),
 steps AS(DELETE FROM cockpit_meeting_directory_step WHERE cockpit_meeting_directory_step.workspace_id=$1)
DELETE FROM cockpit_meeting_directory_operation WHERE cockpit_meeting_directory_operation.workspace_id=$1;

-- name: ReadLiveCockpitDirectoryTaskToken :one
SELECT * FROM task_token WHERE id=$1 AND workspace_id=$2 AND expires_at>clock_timestamp();

-- name: LockCockpitDirectoryRun :one
SELECT t.* FROM agent_task_queue t JOIN issue i ON i.id=t.issue_id
WHERE i.workspace_id=$1 AND t.id=$2 FOR UPDATE OF t;

-- name: ReadCockpitDirectoryGrants :many
SELECT command_key,(receipt->'directory'->'grant')::jsonb AS grant FROM cockpit_meeting_lifecycle_command
WHERE workspace_id=$1 AND meeting_id=$2 AND command_key=ANY($3::uuid[]) AND directory_operation_id IS NOT NULL;

-- name: ReadCockpitDirectoryOperationCounts :many
SELECT operation_id,count(*)::bigint AS total,count(*) FILTER(WHERE state='pending')::bigint AS pending,
 count(*) FILTER(WHERE state='running')::bigint AS running,count(*) FILTER(WHERE state='retry_wait')::bigint AS retry_wait,
 count(*) FILTER(WHERE state='satisfied')::bigint AS satisfied,count(*) FILTER(WHERE state='needs_attention')::bigint AS needs_attention,
 count(*) FILTER(WHERE state='abandoned')::bigint AS abandoned
FROM cockpit_meeting_directory_step WHERE workspace_id=$1 AND operation_id=ANY($2::uuid[]) GROUP BY operation_id;

-- name: ListCockpitDirectoryUnfinishedSteps :many
SELECT * FROM cockpit_meeting_directory_step WHERE workspace_id=$1 AND operation_id=ANY($2::uuid[]) AND state NOT IN ('satisfied','abandoned') ORDER BY operation_id,position;

-- name: ReadCockpitDirectoryPermissionFacts :many
WITH requested AS MATERIALIZED (SELECT DISTINCT (i->>'user_id')::uuid AS user_id,(i->>'agent_id')::uuid AS agent_id FROM jsonb_array_elements(sqlc.arg(identities)::jsonb) i)
SELECT r.user_id,r.agent_id,(m.user_id IS NOT NULL)::boolean AS member_exists,a.owner_id,a.permission_mode,a.status,
 EXISTS(SELECT 1 FROM agent_invocation_target t WHERE t.agent_id=a.id AND t.target_type='workspace')::boolean AS workspace_target,
 EXISTS(SELECT 1 FROM agent_invocation_target t WHERE t.agent_id=a.id AND t.target_type='member' AND t.target_id=r.user_id)::boolean AS member_target
FROM requested r LEFT JOIN member m ON m.workspace_id=sqlc.arg(workspace_id) AND m.user_id=r.user_id
LEFT JOIN agent a ON a.workspace_id=sqlc.arg(workspace_id) AND a.id=r.agent_id;

-- name: CountCockpitDirectoryRunnableSteps :one
SELECT count(*)::bigint FROM cockpit_meeting_directory_step s
WHERE s.workspace_id=$1 AND s.operation_id=$2 AND s.state IN ('pending','retry_wait')
AND (s.parent_step_id IS NULL OR EXISTS(SELECT 1 FROM cockpit_meeting_directory_step p WHERE p.workspace_id=s.workspace_id AND p.operation_id=s.operation_id AND p.id=s.parent_step_id AND p.state='satisfied'));

-- name: ReadCockpitDirectoryAcceptedBindings :many
SELECT o.id AS operation_id,a.grant_command_key,a.grant_revision,(c.receipt->'directory'->'grant')::jsonb AS grant
FROM cockpit_meeting_directory_operation o
JOIN cockpit_meeting_directory_step b ON b.workspace_id=o.workspace_id AND b.operation_id=o.id AND b.meeting_id=o.meeting_id AND b.kind='base' AND b.state='satisfied'
JOIN cockpit_meeting_directory_attempt a ON a.workspace_id=o.workspace_id AND a.operation_id=o.id AND a.step_id=b.id AND a.id=b.last_attempt_id AND a.state='succeeded' AND a.grant_command_key=b.grant_command_key AND a.grant_revision=b.grant_revision
JOIN cockpit_meeting_lifecycle_command c ON c.workspace_id=o.workspace_id AND c.meeting_id=o.meeting_id AND c.directory_operation_id=o.id AND c.command_key=a.grant_command_key
WHERE o.workspace_id=$1 AND o.id=ANY($2::uuid[]) AND o.accepted_binding_revision IS NOT NULL;
