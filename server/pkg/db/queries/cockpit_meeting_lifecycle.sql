-- name: GetCockpitMeetingLifecycle :one
SELECT id,workspace_id,cockpit_id,lifecycle_revision,occurrence_state,
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

-- name: BumpCockpitWorkflowRevisionForOccurrence :exec
UPDATE cockpit_meeting SET minutes_revision=minutes_revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2;

-- name: GetCockpitLifecycleCommand :one
SELECT * FROM cockpit_meeting_lifecycle_command WHERE workspace_id=$1 AND meeting_id=$2 AND command_key=$3;

-- name: CreateCockpitLifecycleCommand :exec
INSERT INTO cockpit_meeting_lifecycle_command(workspace_id,meeting_id,command_key,kind,actor_id,request_hash,revision,agenda_revision,issue_id,operation_id,effect_id,receipt)
VALUES(sqlc.arg(workspace_id),sqlc.arg(meeting_id),sqlc.arg(command_key),sqlc.arg(kind),sqlc.arg(actor_id),sqlc.arg(request_hash),sqlc.arg(revision),1,sqlc.narg(issue_id),sqlc.narg(operation_id),sqlc.narg(effect_id),sqlc.arg(receipt));

-- name: ListCockpitLifecycleCommands :many
SELECT c.workspace_id,c.meeting_id,c.command_key,c.kind,c.actor_id,c.revision,c.issue_id,c.operation_id,c.effect_id,c.actor_type,c.directory_operation_id,c.directory_step_id,c.created_at,CASE WHEN c.actor_type='agent' THEN COALESCE(actor_agent.name,'') ELSE COALESCE(u.name,'') END::text AS actor_name
FROM cockpit_meeting_lifecycle_command c LEFT JOIN "user" u ON u.id=c.actor_id AND c.actor_type='member'
LEFT JOIN agent actor_agent ON actor_agent.id=c.actor_id AND actor_agent.workspace_id=c.workspace_id AND c.actor_type='agent'
WHERE c.workspace_id=sqlc.arg(workspace_id) AND c.meeting_id=sqlc.arg(meeting_id)
 AND (sqlc.narg(after_key)::uuid IS NULL OR (c.created_at,c.command_key)<(sqlc.arg(after_time)::timestamptz,sqlc.narg(after_key)))
ORDER BY c.created_at DESC,c.command_key DESC LIMIT sqlc.arg(page_limit);

-- name: CountCockpitLifecycleCommands :one
SELECT count(*) FROM cockpit_meeting_lifecycle_command WHERE workspace_id=$1 AND meeting_id=$2;

-- name: HasCockpitLifecycleForBoard :one
SELECT EXISTS(SELECT 1 FROM cockpit_meeting m WHERE m.workspace_id=$1 AND m.cockpit_id=$2 AND
 (m.lifecycle_revision>1 OR m.ended_at IS NOT NULL OR EXISTS(SELECT 1 FROM cockpit_meeting_agenda a WHERE a.workspace_id=m.workspace_id AND a.meeting_id=m.id)));

-- name: DeleteCockpitLifecycleByWorkspace :exec
WITH commands AS (DELETE FROM cockpit_meeting_lifecycle_command WHERE cockpit_meeting_lifecycle_command.workspace_id=$1),
refs AS (DELETE FROM cockpit_meeting_agenda_reference WHERE cockpit_meeting_agenda_reference.workspace_id=$1)
DELETE FROM cockpit_meeting_agenda WHERE cockpit_meeting_agenda.workspace_id=$1;
