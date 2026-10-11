-- name: ListCockpitDispositionIssueIDs :many
WITH preparation_issues AS MATERIALIZED (
 SELECT r.target_id AS id FROM cockpit_meeting_agenda_reference r
 JOIN cockpit_meeting_agenda a ON a.workspace_id=r.workspace_id AND a.meeting_id=r.meeting_id AND a.id=r.agenda_id AND a.removed_at IS NULL
 WHERE r.workspace_id=sqlc.arg(workspace_id) AND r.meeting_id=sqlc.arg(meeting_id) AND r.kind='issue' AND r.purpose='preparation' AND r.removed_at IS NULL
 UNION SELECT l.issue_id FROM cockpit_meeting_issue l WHERE l.workspace_id=sqlc.arg(workspace_id) AND l.meeting_id=sqlc.arg(meeting_id) AND ('preparation'=ANY(l.roles) OR 'task'=ANY(l.roles))
 UNION SELECT w.minutes_issue_id FROM cockpit_meeting_work_package w WHERE w.workspace_id=sqlc.arg(workspace_id) AND w.meeting_id=sqlc.arg(meeting_id)
)
SELECT i.id FROM preparation_issues p JOIN issue i ON i.id=p.id AND i.workspace_id=sqlc.arg(workspace_id)
WHERE (sqlc.arg(query)::text='' OR i.title ILIKE '%'||sqlc.arg(query)||'%' OR i.number::text=sqlc.arg(query))
AND (sqlc.narg(after_id)::uuid IS NULL OR i.id>sqlc.narg(after_id)) ORDER BY i.id LIMIT sqlc.arg(page_limit);

-- name: CountCockpitDispositionIssues :one
WITH preparation_issues AS MATERIALIZED (
 SELECT r.target_id AS id FROM cockpit_meeting_agenda_reference r
 JOIN cockpit_meeting_agenda a ON a.workspace_id=r.workspace_id AND a.meeting_id=r.meeting_id AND a.id=r.agenda_id AND a.removed_at IS NULL
 WHERE r.workspace_id=sqlc.arg(workspace_id) AND r.meeting_id=sqlc.arg(meeting_id) AND r.kind='issue' AND r.purpose='preparation' AND r.removed_at IS NULL
 UNION SELECT l.issue_id FROM cockpit_meeting_issue l WHERE l.workspace_id=sqlc.arg(workspace_id) AND l.meeting_id=sqlc.arg(meeting_id) AND ('preparation'=ANY(l.roles) OR 'task'=ANY(l.roles))
 UNION SELECT w.minutes_issue_id FROM cockpit_meeting_work_package w WHERE w.workspace_id=sqlc.arg(workspace_id) AND w.meeting_id=sqlc.arg(meeting_id)
)
SELECT count(*) FROM preparation_issues p JOIN issue i ON i.id=p.id AND i.workspace_id=sqlc.arg(workspace_id)
WHERE (sqlc.arg(query)::text='' OR i.title ILIKE '%'||sqlc.arg(query)||'%' OR i.number::text=sqlc.arg(query));

-- name: CockpitMeetingHasPreparationIssue :one
WITH preparation_issues AS MATERIALIZED (
 SELECT r.target_id AS id FROM cockpit_meeting_agenda_reference r
 JOIN cockpit_meeting_agenda a ON a.workspace_id=r.workspace_id AND a.meeting_id=r.meeting_id AND a.id=r.agenda_id AND a.removed_at IS NULL
 WHERE r.workspace_id=sqlc.arg(workspace_id) AND r.meeting_id=sqlc.arg(meeting_id) AND r.kind='issue' AND r.purpose='preparation' AND r.removed_at IS NULL
 UNION SELECT l.issue_id FROM cockpit_meeting_issue l WHERE l.workspace_id=sqlc.arg(workspace_id) AND l.meeting_id=sqlc.arg(meeting_id) AND ('preparation'=ANY(l.roles) OR 'task'=ANY(l.roles))
 UNION SELECT w.minutes_issue_id FROM cockpit_meeting_work_package w WHERE w.workspace_id=sqlc.arg(workspace_id) AND w.meeting_id=sqlc.arg(meeting_id)
)
SELECT EXISTS(SELECT 1 FROM preparation_issues p JOIN issue i ON i.id=p.id AND i.workspace_id=sqlc.arg(workspace_id) WHERE i.id=sqlc.arg(issue_id));

-- name: CountCockpitMeetingPreparationRuns :one
WITH preparation_issues AS MATERIALIZED (
 SELECT r.target_id AS id FROM cockpit_meeting_agenda_reference r
 JOIN cockpit_meeting_agenda a ON a.workspace_id=r.workspace_id AND a.meeting_id=r.meeting_id AND a.id=r.agenda_id AND a.removed_at IS NULL
 WHERE r.workspace_id=sqlc.arg(workspace_id) AND r.meeting_id=sqlc.arg(meeting_id) AND r.kind='issue' AND r.purpose='preparation' AND r.removed_at IS NULL
 UNION SELECT l.issue_id FROM cockpit_meeting_issue l WHERE l.workspace_id=sqlc.arg(workspace_id) AND l.meeting_id=sqlc.arg(meeting_id) AND ('preparation'=ANY(l.roles) OR 'task'=ANY(l.roles))
 UNION SELECT w.minutes_issue_id FROM cockpit_meeting_work_package w WHERE w.workspace_id=sqlc.arg(workspace_id) AND w.meeting_id=sqlc.arg(meeting_id)
)
SELECT count(*) FROM agent_task_queue t JOIN preparation_issues p ON p.id=t.issue_id
WHERE t.chat_session_id IS NULL AND t.status IN ('queued','deferred','dispatched','running','waiting_local_directory');

-- name: ReadCockpitDispositionAutomationFacts :many
WITH requested AS (SELECT i.id,i.parent_issue_id FROM issue i WHERE i.workspace_id=sqlc.arg(workspace_id) AND i.id=ANY(sqlc.arg(issue_ids)::uuid[]))
SELECT r.id,r.parent_issue_id,
 (SELECT count(*) FROM issue_wakeup w WHERE w.issue_id=r.id AND w.system_rule IS NULL AND w.disabled_at IS NULL)::bigint AS ordinary_wakeup_count,
 (SELECT count(*) FROM issue_wakeup w WHERE w.issue_id=r.id AND w.system_rule IS NOT NULL)::bigint AS system_rule_count,
 (SELECT count(*) FROM agent_task_queue t WHERE t.issue_id=r.id AND t.context->>'wakeup_id' IS NOT NULL AND t.status IN ('queued','deferred') AND t.started_at IS NULL)::bigint AS unstarted_wakeup_run_count,
 (SELECT count(*) FROM agent_task_queue t WHERE t.issue_id=r.id AND (t.context->>'wakeup_id' IS NULL OR t.started_at IS NOT NULL) AND t.status IN ('queued','deferred'))::bigint AS other_queued_run_count,
 (SELECT count(*) FROM agent_task_queue t WHERE t.issue_id=r.id AND t.status IN ('dispatched','running','waiting_local_directory'))::bigint AS active_run_count,
 (SELECT encode(sha256(convert_to(COALESCE(string_agg(w.id::text||':'||w.revision::text||':'||w.enabled::text||':'||COALESCE(extract(epoch FROM w.disabled_at)::text,''),',' ORDER BY w.id),''),'UTF8')),'hex') FROM issue_wakeup w WHERE w.issue_id=r.id)::text AS wakeup_hash,
 (SELECT encode(sha256(convert_to(COALESCE(string_agg(t.id::text||':'||t.status||':'||COALESCE(extract(epoch FROM t.started_at)::text,''),',' ORDER BY t.id),''),'UTF8')),'hex') FROM agent_task_queue t WHERE t.issue_id=r.id AND NOT(t.id=ANY(COALESCE(sqlc.arg(excluded_run_ids)::uuid[],ARRAY[]::uuid[]))) AND t.status IN ('queued','deferred','dispatched','running','waiting_local_directory'))::text AS task_hash,
 (SELECT encode(sha256(convert_to(COALESCE(string_agg(w.id::text,',' ORDER BY w.id),''),'UTF8')),'hex') FROM issue_wakeup w WHERE w.issue_id=r.id AND w.system_rule IS NULL AND w.disabled_at IS NULL)::text AS ordinary_wakeup_ids_hash,
 (SELECT COALESCE(jsonb_agg(s.id),'[]'::jsonb) FROM (SELECT w.id FROM issue_wakeup w WHERE w.issue_id=r.id AND w.system_rule IS NULL AND w.disabled_at IS NULL ORDER BY w.id LIMIT 100) s)::jsonb AS ordinary_wakeup_ids,
 COALESCE(EXISTS(SELECT 1 FROM cockpit_minutes_version v WHERE v.workspace_id=sqlc.arg(workspace_id) AND v.review_issue_id=r.id) OR EXISTS(SELECT 1 FROM cockpit_reviewer_handoff h WHERE h.workspace_id=sqlc.arg(workspace_id) AND h.from_review_issue_id=r.id) OR EXISTS(SELECT 1 FROM cockpit_reviewer_handoff h WHERE h.workspace_id=sqlc.arg(workspace_id) AND h.to_review_issue_id=r.id),false)::boolean AS is_minutes_review,
 (SELECT count(*) FROM cockpit_meeting_agenda_reference l JOIN cockpit_meeting_agenda a ON a.workspace_id=l.workspace_id AND a.id=l.agenda_id AND a.removed_at IS NULL WHERE l.workspace_id=sqlc.arg(workspace_id) AND l.meeting_id=sqlc.arg(meeting_id) AND l.kind='issue' AND l.target_id=r.id AND l.removed_at IS NULL)::bigint AS agenda_total
FROM requested r;

-- name: ListCockpitDispositionRuns :many
SELECT t.id,t.issue_id,t.agent_id,t.status,t.started_at,(t.context->>'wakeup_id' IS NOT NULL)::boolean AS is_wakeup,
 COALESCE(a.name,'')::text AS agent_name,a.owner_id,a.permission_mode,
 EXISTS(SELECT 1 FROM agent_invocation_target v WHERE v.agent_id=a.id AND (v.target_type='workspace' OR (v.target_type='member' AND v.target_id=sqlc.arg(actor_id))))::boolean AS target_matches
FROM agent_task_queue t LEFT JOIN agent a ON a.id=t.agent_id AND a.workspace_id=sqlc.arg(workspace_id)
JOIN issue i ON i.id=t.issue_id AND i.workspace_id=sqlc.arg(workspace_id)
WHERE t.issue_id=sqlc.arg(issue_id) AND t.chat_session_id IS NULL AND t.status IN ('queued','deferred','dispatched','running','waiting_local_directory')
AND (sqlc.narg(after_id)::uuid IS NULL OR t.id>sqlc.narg(after_id)) ORDER BY t.id LIMIT sqlc.arg(page_limit);

-- name: CountCockpitDispositionRuns :one
SELECT count(*) FROM agent_task_queue t JOIN issue i ON i.id=t.issue_id AND i.workspace_id=$1
WHERE t.issue_id=$2 AND t.chat_session_id IS NULL AND t.status IN ('queued','deferred','dispatched','running','waiting_local_directory');

-- name: FilterCockpitPreparationIssueIDs :many
WITH preparation_issues AS MATERIALIZED (
 SELECT r.target_id AS id FROM cockpit_meeting_agenda_reference r
 JOIN cockpit_meeting_agenda a ON a.workspace_id=r.workspace_id AND a.meeting_id=r.meeting_id AND a.id=r.agenda_id AND a.removed_at IS NULL
 WHERE r.workspace_id=sqlc.arg(workspace_id) AND r.meeting_id=sqlc.arg(meeting_id) AND r.kind='issue' AND r.purpose='preparation' AND r.removed_at IS NULL
 UNION SELECT l.issue_id FROM cockpit_meeting_issue l WHERE l.workspace_id=sqlc.arg(workspace_id) AND l.meeting_id=sqlc.arg(meeting_id) AND ('preparation'=ANY(l.roles) OR 'task'=ANY(l.roles))
 UNION SELECT w.minutes_issue_id FROM cockpit_meeting_work_package w WHERE w.workspace_id=sqlc.arg(workspace_id) AND w.meeting_id=sqlc.arg(meeting_id)
)
SELECT i.id FROM preparation_issues p JOIN issue i ON i.id=p.id AND i.workspace_id=sqlc.arg(workspace_id)
WHERE i.id=ANY(sqlc.arg(issue_ids)::uuid[]);

-- name: GetCockpitDispositionRunsByIDs :many
SELECT t.id,t.issue_id,t.agent_id,t.status,t.started_at,(t.context->>'wakeup_id' IS NOT NULL)::boolean AS is_wakeup,
 COALESCE(a.name,'')::text AS agent_name,a.owner_id,a.permission_mode,
 EXISTS(SELECT 1 FROM agent_invocation_target v WHERE v.agent_id=a.id AND (v.target_type='workspace' OR (v.target_type='member' AND v.target_id=sqlc.arg(actor_id))))::boolean AS target_matches
FROM agent_task_queue t LEFT JOIN agent a ON a.id=t.agent_id AND a.workspace_id=sqlc.arg(workspace_id)
JOIN issue i ON i.id=t.issue_id AND i.workspace_id=sqlc.arg(workspace_id)
WHERE t.id=ANY(sqlc.arg(run_ids)::uuid[]) AND t.chat_session_id IS NULL ORDER BY t.id;

-- name: ReadCockpitCancellationDirectoryFacts :one
WITH active AS MATERIALIZED (
 SELECT d.id,d.revision FROM cockpit_meeting_directory_operation d WHERE d.workspace_id=sqlc.arg(workspace_id) AND d.meeting_id=sqlc.arg(meeting_id) AND d.state='active' AND d.finished_at IS NULL
)
SELECT jsonb_build_object(
 'unfinished_total',(SELECT count(*) FROM cockpit_meeting_directory_operation d WHERE d.workspace_id=sqlc.arg(workspace_id) AND d.meeting_id=sqlc.arg(meeting_id) AND d.finished_at IS NULL),
 'will_pause_total',(SELECT count(*) FROM active),
 'sample_operation_ids',COALESCE((SELECT jsonb_agg(sample.id ORDER BY sample.id) FROM (SELECT id FROM active ORDER BY id LIMIT 100) sample),'[]'::jsonb),
 'facts_hash',(SELECT encode(sha256(convert_to(COALESCE(string_agg(id::text||':'||revision::text,',' ORDER BY id),''),'UTF8')),'hex') FROM active)
)::jsonb AS facts;

-- name: PauseCockpitDirectoriesForCancellation :one
WITH selected AS MATERIALIZED (
 SELECT d.id FROM cockpit_meeting_directory_operation d WHERE d.workspace_id=sqlc.arg(workspace_id) AND d.meeting_id=sqlc.arg(meeting_id) AND d.state='active' AND d.finished_at IS NULL ORDER BY d.id FOR UPDATE OF d
), paused AS (
 UPDATE cockpit_meeting_directory_operation o SET state='paused',revision=o.revision+1,updated_at=now()
 FROM selected s WHERE o.workspace_id=sqlc.arg(workspace_id) AND o.meeting_id=sqlc.arg(meeting_id) AND o.id=s.id RETURNING o.id,o.revision
), unscheduled AS (
 UPDATE cockpit_meeting_directory_step s SET next_attempt_at=NULL,revision=s.revision+1,updated_at=now()
 FROM paused p WHERE s.workspace_id=sqlc.arg(workspace_id) AND s.meeting_id=sqlc.arg(meeting_id) AND s.operation_id=p.id
 AND s.state IN ('pending','retry_wait') AND s.next_attempt_at IS NOT NULL
)
SELECT jsonb_build_object(
 'paused_total',(SELECT count(*) FROM paused),
 'sample_operation_ids',COALESCE((SELECT jsonb_agg(sample.id ORDER BY sample.id) FROM (SELECT id FROM paused ORDER BY id LIMIT 100) sample),'[]'::jsonb),
 'facts_hash',(SELECT encode(sha256(convert_to(COALESCE(string_agg(id::text||':'||revision::text,',' ORDER BY id),''),'UTF8')),'hex') FROM paused)
)::jsonb AS effects;
