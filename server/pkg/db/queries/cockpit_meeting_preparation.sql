-- name: CreateCockpitPreparationOperation :one
INSERT INTO cockpit_meeting_preparation_operation(id,workspace_id,meeting_id,kind,command_key,request_hash,context_token,template_id,template_version_id,input,state,authorized_lifecycle_revision,authorized_agenda_revision,created_by,responsible_user_id)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) RETURNING *;

-- name: GetCockpitPreparationOperation :one
SELECT * FROM cockpit_meeting_preparation_operation WHERE workspace_id=$1 AND meeting_id=$2 AND id=$3;

-- name: LockCockpitPreparationOperation :one
SELECT * FROM cockpit_meeting_preparation_operation WHERE workspace_id=$1 AND meeting_id=$2 AND id=$3 FOR UPDATE;

-- name: GetCockpitTemplateApplication :one
SELECT * FROM cockpit_meeting_preparation_operation WHERE workspace_id=$1 AND meeting_id=$2 AND template_version_id=$3 AND kind='apply_template';

-- name: UpdateCockpitPreparationOperationState :one
UPDATE cockpit_meeting_preparation_operation SET state=$4,responsible_user_id=$5,revision=revision+1,updated_at=now()
WHERE workspace_id=$1 AND meeting_id=$2 AND id=$3 AND revision=$6 RETURNING *;

-- name: CountCockpitPreparationEffects :one
SELECT count(*)::integer AS total,
 count(*) FILTER(WHERE state='pending')::integer AS pending,
 count(*) FILTER(WHERE state='applied')::integer AS applied,
 count(*) FILTER(WHERE state='needs_attention')::integer AS needs_attention,
 count(*) FILTER(WHERE state='skipped')::integer AS skipped
FROM cockpit_meeting_preparation_effect WHERE workspace_id=$1 AND operation_id=$2;

-- name: ListCockpitPreparationOperations :many
SELECT o.id,o.workspace_id,o.meeting_id,o.kind,o.revision,o.state,o.command_key,o.template_id,o.template_version_id,o.created_by,o.responsible_user_id,o.created_at,o.updated_at,COALESCE(u.name,'')::text AS created_by_name,COALESCE(responsible.name,'')::text AS responsible_user_name,COALESCE(v.title,'')::text AS template_title,v.number AS template_version_number,
 (SELECT jsonb_build_object('total',count(*),'pending',count(*) FILTER(WHERE e.state='pending'),'applied',count(*) FILTER(WHERE e.state='applied'),'needs_attention',count(*) FILTER(WHERE e.state='needs_attention'),'skipped',count(*) FILTER(WHERE e.state='skipped')) FROM cockpit_meeting_preparation_effect e WHERE e.workspace_id=o.workspace_id AND e.operation_id=o.id) AS counts
FROM cockpit_meeting_preparation_operation o LEFT JOIN "user" u ON u.id=o.created_by
LEFT JOIN "user" responsible ON responsible.id=o.responsible_user_id
LEFT JOIN cockpit_meeting_template_version v ON v.workspace_id=o.workspace_id AND v.template_id=o.template_id AND v.id=o.template_version_id
WHERE o.workspace_id=sqlc.arg(workspace_id) AND o.meeting_id=sqlc.arg(meeting_id)
AND (sqlc.narg(after_id)::uuid IS NULL OR (o.created_at,o.id)<(sqlc.arg(after_time)::timestamptz,sqlc.narg(after_id)))
ORDER BY o.created_at DESC,o.id DESC LIMIT sqlc.arg(page_limit);

-- name: CountCockpitPreparationOperations :one
SELECT count(*) FROM cockpit_meeting_preparation_operation WHERE workspace_id=$1 AND meeting_id=$2;

-- name: CreateCockpitPreparationEffect :one
INSERT INTO cockpit_meeting_preparation_effect(id,workspace_id,meeting_id,operation_id,slot_id,position,kind,label,command_key,dependency_id,request_hash,input,issue_id,run_id,target_meeting_id,authorization_key,authorization_hash,authorization_snapshot)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *;

-- name: GetCockpitPreparationEffect :one
SELECT * FROM cockpit_meeting_preparation_effect WHERE workspace_id=$1 AND meeting_id=$2 AND operation_id=$3 AND id=$4;

-- name: LockCockpitPreparationEffect :one
SELECT * FROM cockpit_meeting_preparation_effect WHERE workspace_id=$1 AND meeting_id=$2 AND operation_id=$3 AND id=$4 FOR UPDATE;

-- name: ListCockpitPreparationEffects :many
SELECT e.id,e.workspace_id,e.meeting_id,e.operation_id,e.slot_id,e.position,e.kind,e.label,e.command_key,e.dependency_id,e.revision,e.state,e.error_code,e.reason,e.agenda_id,e.reference_id,e.issue_id,e.run_id,e.target_meeting_id,e.receipt,e.applied_by,e.applied_at,e.created_at,e.updated_at,e.authorization_key,e.authorization_revision,e.authorization_hash,e.authorization_snapshot,COALESCE(e.dependency_id IS NULL OR d.state='applied',false)::boolean AS dependency_applied
FROM cockpit_meeting_preparation_effect e LEFT JOIN cockpit_meeting_preparation_effect d ON d.workspace_id=e.workspace_id AND d.operation_id=e.operation_id AND d.id=e.dependency_id
WHERE e.workspace_id=sqlc.arg(workspace_id) AND e.meeting_id=sqlc.arg(meeting_id) AND e.operation_id=sqlc.arg(operation_id)
AND (sqlc.narg(after_id)::uuid IS NULL OR (e.position,e.id)>(sqlc.arg(after_position)::integer,sqlc.narg(after_id)))
ORDER BY e.position,e.id LIMIT sqlc.arg(page_limit);

-- name: ApplyCockpitPreparationEffect :one
UPDATE cockpit_meeting_preparation_effect SET state='applied',revision=revision+1,error_code='',reason='',
 agenda_id=$5,reference_id=$6,issue_id=$7,run_id=$8,receipt=$9,applied_by=$10,applied_at=now(),updated_at=now()
WHERE workspace_id=$1 AND meeting_id=$2 AND operation_id=$3 AND id=$4 AND state='pending' RETURNING *;

-- name: SetCockpitPreparationEffectState :one
UPDATE cockpit_meeting_preparation_effect SET state=$5,error_code=$6,reason=$7,revision=revision+1,updated_at=now()
WHERE workspace_id=$1 AND meeting_id=$2 AND operation_id=$3 AND id=$4 AND state<>'applied' AND revision=$8 RETURNING *;

-- name: ResetCockpitPreparationFailures :exec
UPDATE cockpit_meeting_preparation_effect SET state='pending',error_code='',reason='',revision=revision+1,updated_at=now()
WHERE workspace_id=$1 AND operation_id=$2 AND state='needs_attention';

-- name: HasCockpitMeetingPreparationHistory :one
SELECT EXISTS(SELECT 1 FROM cockpit_meeting_preparation_operation WHERE workspace_id=$1 AND meeting_id=$2);

-- name: GetCurrentCockpitPreparationOperation :one
SELECT * FROM cockpit_meeting_preparation_operation WHERE workspace_id=$1 AND meeting_id=$2 AND state<>'completed' ORDER BY created_at DESC,id DESC LIMIT 1;

-- name: ReauthorizeCockpitPreparationEffect :one
UPDATE cockpit_meeting_preparation_effect SET authorization_key=$5,authorization_hash=$6,authorization_snapshot=$7,
 authorization_revision=authorization_revision+1,state='pending',error_code='',reason='',revision=revision+1,updated_at=now()
WHERE workspace_id=$1 AND meeting_id=$2 AND operation_id=$3 AND id=$4 AND state='needs_attention' AND receipt IS NULL AND revision=$8 RETURNING *;

-- name: GetCockpitPreparationTemplateDisplay :one
SELECT title,number FROM cockpit_meeting_template_version WHERE workspace_id=$1 AND id=$2;
