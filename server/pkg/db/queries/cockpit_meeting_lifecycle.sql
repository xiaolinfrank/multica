-- name: GetCockpitMeetingLifecycle :one
SELECT id,workspace_id,cockpit_id,lifecycle_revision,agenda_revision,occurrence_state,
 started_confirmed_at,started_confirmed_by,ended_at,ended_by,ended_source,actual_started_at,actual_ended_at,cancelled_at,cancelled_by,cancelled_reason,archived_at,archived_by,archived_reason,
 now()::timestamptz AS database_now
FROM cockpit_meeting WHERE workspace_id=$1 AND id=$2;

-- name: SetCockpitMeetingOccurrence :one
UPDATE cockpit_meeting SET occurrence_state=sqlc.arg(state),
 started_confirmed_at=sqlc.narg(started_at),started_confirmed_by=sqlc.narg(started_by),
 ended_at=sqlc.narg(ended_at),ended_by=sqlc.narg(ended_by),ended_source=sqlc.narg(ended_source),
 actual_started_at=sqlc.narg(actual_started_at),actual_ended_at=sqlc.narg(actual_ended_at),
 lifecycle_revision=lifecycle_revision+1,lifecycle_updated_at=now(),lifecycle_updated_by=sqlc.arg(actor_id)
WHERE workspace_id=sqlc.arg(workspace_id) AND id=sqlc.arg(meeting_id) AND lifecycle_revision=sqlc.arg(expected_revision)
RETURNING lifecycle_revision;

-- name: BumpCockpitAgendaRevision :one
UPDATE cockpit_meeting SET agenda_revision=agenda_revision+1 WHERE workspace_id=$1 AND id=$2 RETURNING agenda_revision;

-- name: BumpCockpitWorkflowRevisionForOccurrence :exec
UPDATE cockpit_meeting_work_package SET revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND meeting_id=$2;

-- name: GetCockpitLifecycleCommand :one
SELECT * FROM cockpit_meeting_lifecycle_command WHERE workspace_id=$1 AND meeting_id=$2 AND command_key=$3;

-- name: CreateCockpitLifecycleCommand :exec
INSERT INTO cockpit_meeting_lifecycle_command(workspace_id,meeting_id,command_key,kind,actor_id,request_hash,revision,agenda_revision,agenda_id,reference_id,issue_id,operation_id,effect_id,receipt)
VALUES(sqlc.arg(workspace_id),sqlc.arg(meeting_id),sqlc.arg(command_key),sqlc.arg(kind),sqlc.arg(actor_id),sqlc.arg(request_hash),sqlc.arg(revision),sqlc.arg(agenda_revision),sqlc.narg(agenda_id),sqlc.narg(reference_id),sqlc.narg(issue_id),sqlc.narg(operation_id),sqlc.narg(effect_id),sqlc.arg(receipt));

-- name: ListCockpitLifecycleCommands :many
SELECT c.workspace_id,c.meeting_id,c.command_key,c.kind,c.actor_id,c.revision,c.agenda_revision,c.agenda_id,c.reference_id,c.issue_id,c.operation_id,c.effect_id,c.actor_type,c.directory_operation_id,c.directory_step_id,c.created_at,CASE WHEN c.actor_type='agent' THEN COALESCE(actor_agent.name,'') ELSE COALESCE(u.name,'') END::text AS actor_name
FROM cockpit_meeting_lifecycle_command c LEFT JOIN "user" u ON u.id=c.actor_id AND c.actor_type='member'
LEFT JOIN agent actor_agent ON actor_agent.id=c.actor_id AND actor_agent.workspace_id=c.workspace_id AND c.actor_type='agent'
WHERE c.workspace_id=sqlc.arg(workspace_id) AND c.meeting_id=sqlc.arg(meeting_id)
 AND (sqlc.narg(after_key)::uuid IS NULL OR (c.created_at,c.command_key)<(sqlc.arg(after_time)::timestamptz,sqlc.narg(after_key)))
ORDER BY c.created_at DESC,c.command_key DESC LIMIT sqlc.arg(page_limit);

-- name: CountCockpitLifecycleCommands :one
SELECT count(*) FROM cockpit_meeting_lifecycle_command WHERE workspace_id=$1 AND meeting_id=$2;

-- name: GetCockpitMeetingAgenda :one
SELECT * FROM cockpit_meeting_agenda WHERE workspace_id=$1 AND meeting_id=$2 AND id=$3;

-- name: CreateCockpitMeetingAgenda :one
INSERT INTO cockpit_meeting_agenda(id,workspace_id,meeting_id,title,purposes,desired_outcome,notes,facilitator_user_id,node_id,sort_order,created_by,updated_by)
VALUES(sqlc.arg(id),sqlc.arg(workspace_id),sqlc.arg(meeting_id),sqlc.arg(title),sqlc.arg(purposes),sqlc.arg(desired_outcome),sqlc.arg(notes),sqlc.narg(facilitator_user_id),sqlc.narg(node_id),
 COALESCE(sqlc.narg(sort_order)::bigint,(SELECT LEAST(COALESCE(max(a.sort_order),0)+1024,9007199254740991)::bigint FROM cockpit_meeting_agenda a WHERE a.workspace_id=sqlc.arg(workspace_id) AND a.meeting_id=sqlc.arg(meeting_id))),sqlc.arg(actor_id),sqlc.arg(actor_id)) RETURNING *;

-- name: UpdateCockpitMeetingAgenda :one
UPDATE cockpit_meeting_agenda SET title=sqlc.arg(title),purposes=sqlc.arg(purposes),desired_outcome=sqlc.arg(desired_outcome),notes=sqlc.arg(notes),
 facilitator_user_id=sqlc.narg(facilitator_user_id),node_id=sqlc.narg(node_id),sort_order=sqlc.arg(sort_order),revision=revision+1,updated_by=sqlc.arg(actor_id),updated_at=now()
WHERE workspace_id=sqlc.arg(workspace_id) AND meeting_id=sqlc.arg(meeting_id) AND id=sqlc.arg(id) AND revision=sqlc.arg(expected_revision) AND removed_at IS NULL RETURNING *;

-- name: RemoveCockpitMeetingAgenda :one
UPDATE cockpit_meeting_agenda SET removed_at=now(),removed_by=sqlc.arg(actor_id),revision=revision+1,updated_by=sqlc.arg(actor_id),updated_at=now()
WHERE workspace_id=sqlc.arg(workspace_id) AND meeting_id=sqlc.arg(meeting_id) AND id=sqlc.arg(id) AND revision=sqlc.arg(expected_revision) AND removed_at IS NULL RETURNING *;

-- name: BumpCockpitAgendaItemRevision :one
UPDATE cockpit_meeting_agenda SET revision=revision+1,updated_by=sqlc.arg(actor_id),updated_at=now()
WHERE workspace_id=sqlc.arg(workspace_id) AND meeting_id=sqlc.arg(meeting_id) AND id=sqlc.arg(id) AND revision=sqlc.arg(expected_revision) AND removed_at IS NULL RETURNING *;

-- name: ListCockpitAgendaMetadata :many
SELECT a.id,a.sort_order,a.revision,a.title,a.purposes,a.facilitator_user_id,a.node_id,a.created_at,a.updated_at,a.removed_at,
 COALESCE(u.name,'')::text AS facilitator_name,COALESCE(n.code,'')::text AS node_code,COALESCE(n.name,'')::text AS node_title,
 (SELECT count(*) FROM cockpit_meeting_agenda_reference r WHERE r.workspace_id=a.workspace_id AND r.agenda_id=a.id AND r.removed_at IS NULL)::bigint AS reference_count
FROM cockpit_meeting_agenda a LEFT JOIN "user" u ON u.id=a.facilitator_user_id
LEFT JOIN cockpit_node n ON n.workspace_id=a.workspace_id AND n.id=a.node_id
WHERE a.workspace_id=sqlc.arg(workspace_id) AND a.meeting_id=sqlc.arg(meeting_id)
 AND (sqlc.arg(include_removed)::boolean OR a.removed_at IS NULL)
 AND (sqlc.arg(query)::text='' OR a.title ILIKE '%'||sqlc.arg(query)||'%')
 AND (sqlc.narg(after_id)::uuid IS NULL OR (a.sort_order,a.id)>(sqlc.arg(after_order)::bigint,sqlc.narg(after_id)))
ORDER BY a.sort_order,a.id LIMIT sqlc.arg(page_limit);

-- name: CountCockpitAgenda :one
SELECT count(*) FROM cockpit_meeting_agenda WHERE workspace_id=sqlc.arg(workspace_id) AND meeting_id=sqlc.arg(meeting_id)
 AND (sqlc.arg(include_removed)::boolean OR removed_at IS NULL)
 AND (sqlc.arg(query)::text='' OR title ILIKE '%'||sqlc.arg(query)||'%');

-- name: GetCockpitAgendaMetadata :one
SELECT a.id,a.sort_order,a.revision,a.title,a.purposes,a.facilitator_user_id,a.node_id,a.created_at,a.updated_at,a.removed_at,
 COALESCE(u.name,'')::text AS facilitator_name,COALESCE(n.code,'')::text AS node_code,COALESCE(n.name,'')::text AS node_title,
 (SELECT count(*) FROM cockpit_meeting_agenda_reference r WHERE r.workspace_id=a.workspace_id AND r.agenda_id=a.id AND r.removed_at IS NULL)::bigint AS reference_count
FROM cockpit_meeting_agenda a LEFT JOIN "user" u ON u.id=a.facilitator_user_id
LEFT JOIN cockpit_node n ON n.workspace_id=a.workspace_id AND n.id=a.node_id
WHERE a.workspace_id=$1 AND a.meeting_id=$2 AND a.id=$3;

-- name: GetCockpitAgendaReference :one
SELECT * FROM cockpit_meeting_agenda_reference WHERE workspace_id=$1 AND meeting_id=$2 AND agenda_id=$3 AND id=$4;

-- name: GetActiveCockpitAgendaReference :one
SELECT * FROM cockpit_meeting_agenda_reference WHERE workspace_id=$1 AND agenda_id=$2 AND kind=$3 AND target_id=$4 AND removed_at IS NULL;

-- name: CreateCockpitAgendaReference :one
INSERT INTO cockpit_meeting_agenda_reference(id,workspace_id,meeting_id,agenda_id,kind,target_id,purpose,created_by)
VALUES(sqlc.arg(id),sqlc.arg(workspace_id),sqlc.arg(meeting_id),sqlc.arg(agenda_id),sqlc.arg(kind),sqlc.arg(target_id),sqlc.arg(purpose),sqlc.arg(actor_id)) RETURNING *;

-- name: RemoveCockpitAgendaReference :one
UPDATE cockpit_meeting_agenda_reference SET removed_at=now(),removed_by=$5
WHERE workspace_id=$1 AND meeting_id=$2 AND agenda_id=$3 AND id=$4 AND removed_at IS NULL RETURNING *;

-- name: ListCockpitAgendaReferences :many
SELECT * FROM cockpit_meeting_agenda_reference WHERE workspace_id=sqlc.arg(workspace_id) AND meeting_id=sqlc.arg(meeting_id) AND agenda_id=sqlc.arg(agenda_id)
 AND (sqlc.arg(include_removed)::boolean OR removed_at IS NULL)
 AND (sqlc.narg(after_id)::uuid IS NULL OR id>sqlc.narg(after_id)) ORDER BY id LIMIT sqlc.arg(page_limit);

-- name: CountCockpitAgendaReferences :one
SELECT count(*) FROM cockpit_meeting_agenda_reference WHERE workspace_id=$1 AND meeting_id=$2 AND agenda_id=$3 AND ($4::boolean OR removed_at IS NULL);

-- name: ListCockpitAgendaArtifactTargets :many
SELECT r.id,r.artifact_id,r.version_id,r.removed_at,a.title,v.version_number,v.content_hash,v.decision AS version_decision
FROM cockpit_artifact_meeting_reference r
JOIN cockpit_artifact a ON a.workspace_id=r.workspace_id AND a.id=r.artifact_id
JOIN cockpit_artifact_version v ON v.workspace_id=r.workspace_id AND v.id=r.version_id AND v.artifact_id=r.artifact_id
WHERE r.workspace_id=sqlc.arg(workspace_id) AND r.meeting_id=sqlc.arg(meeting_id) AND r.id=ANY(sqlc.arg(ids)::uuid[]);

-- name: HasCockpitLifecycleForBoard :one
SELECT EXISTS(SELECT 1 FROM cockpit_meeting m WHERE m.workspace_id=$1 AND m.cockpit_id=$2 AND
 (m.lifecycle_revision>1 OR m.ended_at IS NOT NULL OR EXISTS(SELECT 1 FROM cockpit_meeting_agenda a WHERE a.workspace_id=m.workspace_id AND a.meeting_id=m.id)));

-- name: DeleteCockpitAgendaByMeeting :exec
WITH refs AS (DELETE FROM cockpit_meeting_agenda_reference WHERE workspace_id=$1 AND meeting_id=$2)
DELETE FROM cockpit_meeting_agenda a WHERE a.workspace_id=$1 AND a.meeting_id=$2;

-- name: DeleteCockpitLifecycleByWorkspace :exec
WITH commands AS (DELETE FROM cockpit_meeting_lifecycle_command WHERE workspace_id=$1),
refs AS (DELETE FROM cockpit_meeting_agenda_reference WHERE workspace_id=$1)
DELETE FROM cockpit_meeting_agenda a WHERE a.workspace_id=$1;
