-- name: GetCockpitMeetingAction :one
SELECT * FROM cockpit_meeting_action WHERE workspace_id=$1 AND meeting_id=$2 AND id=$3;

-- name: LockCockpitMeetingAction :one
SELECT * FROM cockpit_meeting_action WHERE workspace_id=$1 AND meeting_id=$2 AND id=$3 FOR UPDATE;

-- name: GetCockpitActionProposal :one
SELECT * FROM cockpit_meeting_action WHERE workspace_id=$1 AND meeting_id=$2 AND version_id=$3 AND proposal_key=$4;

-- name: CreateCockpitMeetingAction :one
INSERT INTO cockpit_meeting_action(id,workspace_id,meeting_id,version_id,version_number,source_content_hash,
 proposal_key,proposal_hash,title,description,source_quote,created_by)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *;

-- name: UpdateCockpitMeetingAction :one
UPDATE cockpit_meeting_action SET title=$4,description=$5,source_quote=$6,revision=revision+1,updated_at=now()
WHERE workspace_id=$1 AND meeting_id=$2 AND id=$3 AND revision=$7 AND status='draft' RETURNING *;

-- name: ResolveCockpitMeetingAction :one
UPDATE cockpit_meeting_action SET status=sqlc.arg('status')::text,resolution=sqlc.arg('resolution')::text,
 issue_id=sqlc.narg('issue_id')::uuid,node_id=sqlc.narg('node_id')::uuid,
 node_code=sqlc.arg('node_code')::text,node_name=sqlc.arg('node_name')::text,
 reason=sqlc.arg('reason')::text,decision_key=sqlc.arg('decision_key')::uuid,decision_hash=sqlc.arg('decision_hash')::text,
 decision_revision=sqlc.arg('expected_revision')::bigint,resolved_by=sqlc.arg('actor_id')::uuid,resolved_at=now(),
 revision=revision+1,updated_at=now()
WHERE workspace_id=sqlc.arg('workspace_id')::uuid AND meeting_id=sqlc.arg('meeting_id')::uuid AND id=sqlc.arg('id')::uuid
 AND revision=sqlc.arg('expected_revision')::bigint AND status='draft' RETURNING *;

-- name: ListCockpitMeetingActionsPage :many
SELECT * FROM cockpit_meeting_action
WHERE workspace_id=sqlc.arg('workspace_id')::uuid AND meeting_id=sqlc.arg('meeting_id')::uuid
 AND (sqlc.narg('version_id')::uuid IS NULL OR version_id=sqlc.narg('version_id')::uuid)
 AND (sqlc.arg('status')::text='' OR status=sqlc.arg('status')::text)
 AND (sqlc.arg('query')::text='' OR strpos(lower(title||' '||description),lower(sqlc.arg('query')::text))>0)
 AND (sqlc.narg('cursor_id')::uuid IS NULL OR id < sqlc.narg('cursor_id')::uuid)
ORDER BY id DESC LIMIT sqlc.arg('page_limit')::int;

-- name: CountCockpitMeetingActions :one
SELECT count(*)::bigint AS total,
 count(*) FILTER(WHERE (sqlc.arg('status')::text='' OR status=sqlc.arg('status')::text)
  AND (sqlc.arg('query')::text='' OR strpos(lower(title||' '||description),lower(sqlc.arg('query')::text))>0))::bigint AS filtered_total
FROM cockpit_meeting_action WHERE workspace_id=sqlc.arg('workspace_id')::uuid AND meeting_id=sqlc.arg('meeting_id')::uuid
 AND (sqlc.narg('version_id')::uuid IS NULL OR version_id=sqlc.narg('version_id')::uuid);

-- name: ListCockpitActionVersionFacts :many
SELECT id,reviewer_id,published_at,decision FROM cockpit_minutes_version
WHERE workspace_id=$1 AND meeting_id=$2 AND id=ANY(sqlc.arg('version_ids')::uuid[]);

-- name: GetCockpitActionVersionFact :one
SELECT id,reviewer_id,published_at,decision FROM cockpit_minutes_version
WHERE workspace_id=$1 AND meeting_id=$2 AND id=$3;

-- name: ReviseCockpitMeetingActionResolution :one
-- R2 (design-principles-2026-10-12): a resolution is a value, not a terminal
-- fact. Revising appends the previous resolution to the trail and writes the
-- new one; tasks created by an earlier decision stay untouched.
UPDATE cockpit_meeting_action SET
 previous_resolutions = previous_resolutions || jsonb_build_object(
   'status', status, 'resolution', resolution, 'issue_id', issue_id, 'node_id', node_id,
   'node_code', node_code, 'node_name', node_name, 'reason', reason,
   'resolved_by', resolved_by, 'resolved_at', resolved_at, 'decision_key', decision_key),
 status=sqlc.arg('status')::text, resolution=sqlc.arg('resolution')::text,
 issue_id=sqlc.narg('issue_id')::uuid, node_id=sqlc.narg('node_id')::uuid,
 node_code=sqlc.arg('node_code')::text, node_name=sqlc.arg('node_name')::text,
 reason=sqlc.arg('reason')::text, decision_key=sqlc.arg('decision_key')::uuid, decision_hash=sqlc.arg('decision_hash')::text,
 decision_revision=sqlc.arg('expected_revision')::bigint, resolved_by=sqlc.arg('actor_id')::uuid, resolved_at=now(),
 revision=revision+1, updated_at=now()
WHERE workspace_id=sqlc.arg('workspace_id')::uuid AND meeting_id=sqlc.arg('meeting_id')::uuid AND id=sqlc.arg('id')::uuid
 AND revision=sqlc.arg('expected_revision')::bigint AND status IN ('accepted','dismissed') RETURNING *;
