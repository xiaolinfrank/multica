-- name: SetCockpitMeetingDisposition :one
UPDATE cockpit_meeting SET occurrence_state=sqlc.arg(state),
 cancelled_at=sqlc.narg(cancelled_at),cancelled_by=sqlc.narg(cancelled_by),cancelled_reason=sqlc.arg(cancelled_reason),
 archived_at=sqlc.narg(archived_at),archived_by=sqlc.narg(archived_by),archived_reason=sqlc.arg(archived_reason),
 lifecycle_revision=lifecycle_revision+1,lifecycle_updated_at=now(),lifecycle_updated_by=sqlc.arg(actor_id)
WHERE workspace_id=sqlc.arg(workspace_id) AND id=sqlc.arg(meeting_id) AND lifecycle_revision=sqlc.arg(expected_revision)
RETURNING lifecycle_revision;

-- name: ReadCockpitMeetingPendingCounts :one
WITH preparation_issues AS MATERIALIZED (
 SELECT r.target_id AS id FROM cockpit_meeting_agenda_reference r
 JOIN cockpit_meeting_agenda a ON a.workspace_id=r.workspace_id AND a.meeting_id=r.meeting_id AND a.id=r.agenda_id AND a.removed_at IS NULL
 WHERE r.workspace_id=$1 AND r.meeting_id=$2 AND r.kind='issue' AND r.purpose='preparation' AND r.removed_at IS NULL
 UNION SELECT i.issue_id FROM cockpit_meeting_issue i WHERE i.workspace_id=$1 AND i.meeting_id=$2 AND ('preparation'=ANY(i.roles) OR 'task'=ANY(i.roles))
 UNION SELECT l.issue_id FROM cockpit_meeting_issue l WHERE l.workspace_id=$1 AND l.meeting_id=$2 AND 'minutes'=ANY(l.roles)
)
SELECT jsonb_build_object(
 'minutes_review',(SELECT count(*) FROM cockpit_meeting m JOIN cockpit_minutes_version v ON v.workspace_id=m.workspace_id AND v.meeting_id=m.id AND v.id=m.minutes_current_version_id WHERE m.workspace_id=$1 AND m.id=$2 AND v.decision='pending'),
 'draft_actions',(SELECT count(*) FROM cockpit_meeting_action WHERE workspace_id=$1 AND meeting_id=$2 AND status='draft'),
 'active_preparation_issues',(SELECT count(*) FROM preparation_issues p JOIN issue i ON i.id=p.id AND i.workspace_id=$1 LEFT JOIN issue_status s ON s.workspace_id=i.workspace_id AND s.key=i.status WHERE cockpit_issue_category(i.status,s.category) NOT IN ('done','closed')),
 'active_runs',(SELECT count(*) FROM agent_task_queue t JOIN preparation_issues p ON p.id=t.issue_id WHERE t.status IN ('queued','deferred','dispatched','running','waiting_local_directory')),
 'directory_operations',(SELECT count(*) FROM cockpit_meeting_directory_operation WHERE workspace_id=$1 AND meeting_id=$2 AND finished_at IS NULL),
 'nas_operations',(SELECT count(*) FROM cockpit_minutes_export WHERE workspace_id=$1 AND meeting_id=$2 AND status NOT IN ('succeeded')),
 'preparation_operations',(SELECT count(*) FROM cockpit_meeting_preparation_operation WHERE workspace_id=$1 AND meeting_id=$2 AND state<>'completed')) AS counts;

-- name: ReadCockpitMeetingRetainedTargets :many
WITH candidates AS (
 SELECT 'artifact'::text AS kind,a.id AS artifact_id,NULL::uuid AS operation_id,NULL::uuid AS directory_operation_id,a.title AS label,'fixed_artifact_source'::text AS purpose
 FROM cockpit_artifact a WHERE a.workspace_id=$1 AND EXISTS(SELECT 1 FROM cockpit_artifact_version v WHERE v.workspace_id=$1 AND v.artifact_id=a.id AND v.source_meeting_id=$2)
 UNION
 SELECT 'artifact',a.id,NULL::uuid,NULL::uuid,a.title,'fixed_artifact_reference'
 FROM cockpit_artifact_meeting_reference r JOIN cockpit_artifact a ON a.workspace_id=r.workspace_id AND a.id=r.artifact_id
 WHERE r.workspace_id=$1 AND r.meeting_id=$2 AND r.removed_at IS NULL
 UNION
 SELECT 'preparation_operation',NULL::uuid,o.id,NULL::uuid,COALESCE(tv.title,m.title),'preparation_history'
 FROM cockpit_meeting_preparation_operation o
 JOIN cockpit_meeting m ON m.workspace_id=o.workspace_id AND m.id=o.meeting_id
 LEFT JOIN cockpit_meeting_template_version tv ON tv.workspace_id=o.workspace_id AND tv.id=o.template_version_id
 WHERE o.workspace_id=$1 AND o.meeting_id=$2
 UNION
 SELECT 'directory_operation',NULL::uuid,NULL::uuid,o.id,o.directory,'meeting_directory_history'
 FROM cockpit_meeting_directory_operation o WHERE o.workspace_id=$1 AND o.meeting_id=$2
), grouped AS (SELECT kind,artifact_id,operation_id,directory_operation_id,min(label)::text AS label,min(purpose)::text AS purpose FROM candidates GROUP BY kind,artifact_id,operation_id,directory_operation_id), ranked AS (SELECT *,count(*) OVER() AS total FROM grouped)
SELECT * FROM ranked ORDER BY kind,artifact_id,operation_id,directory_operation_id LIMIT 3;
