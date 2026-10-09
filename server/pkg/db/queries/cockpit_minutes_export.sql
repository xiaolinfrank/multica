-- name: GetCockpitMinutesExport :one
SELECT * FROM cockpit_minutes_export WHERE workspace_id=$1 AND meeting_id=$2 AND id=$3;

-- name: LockCockpitMinutesExport :one
SELECT * FROM cockpit_minutes_export WHERE workspace_id=$1 AND meeting_id=$2 AND id=$3 FOR UPDATE;

-- name: ListCockpitMinutesExports :many
SELECT * FROM cockpit_minutes_export WHERE workspace_id=$1 AND meeting_id=$2 ORDER BY created_at DESC,id DESC;

-- name: GetCockpitMinutesExportDestination :one
SELECT * FROM cockpit_minutes_export WHERE workspace_id=$1 AND version_id=$2 AND root_id=$3 AND relative_path=$4;

-- name: CreateCockpitMinutesExport :one
INSERT INTO cockpit_minutes_export (
 id,workspace_id,meeting_id,version_id,version_number,source_issue_id,
 root_id,root_path,directory,relative_path,target_path,content_hash,created_by
) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
RETURNING *;

-- name: RetryCockpitMinutesExport :one
UPDATE cockpit_minutes_export SET status='queued',cycle_attempts=0,
 revision=revision+1,next_retry_at=now(),lease_token=NULL,lease_expires_at=NULL,
 last_error_code='',last_error='',updated_at=now()
WHERE workspace_id=$1 AND meeting_id=$2 AND id=$3 AND revision=$4
 AND status IN ('retry_wait','needs_attention')
RETURNING *;

-- name: ClaimCockpitMinutesExport :one
-- A lost eighth attempt is surfaced for manual reconciliation instead of
-- silently starting an unbounded ninth automatic filesystem operation.
WITH candidate AS (
 SELECT id FROM cockpit_minutes_export
 WHERE root_id=ANY(sqlc.arg('root_ids')::text[])
   AND ((status IN ('queued','retry_wait') AND next_retry_at <= now())
     OR (status='running' AND lease_expires_at <= now()))
 ORDER BY COALESCE(next_retry_at,lease_expires_at),created_at,id
 FOR UPDATE SKIP LOCKED LIMIT 1
)
UPDATE cockpit_minutes_export AS op SET
 status=CASE WHEN op.cycle_attempts >= 8 THEN 'needs_attention' ELSE 'running' END,
 attempts=op.attempts+CASE WHEN op.cycle_attempts >= 8 THEN 0 ELSE 1 END,
 cycle_attempts=op.cycle_attempts+CASE WHEN op.cycle_attempts >= 8 THEN 0 ELSE 1 END,
 revision=op.revision+1,next_retry_at=NULL,
 lease_token=CASE WHEN op.cycle_attempts >= 8 THEN NULL ELSE gen_random_uuid() END,
 lease_expires_at=CASE WHEN op.cycle_attempts >= 8 THEN NULL ELSE now()+interval '2 minutes' END,
 last_error_code=CASE WHEN op.cycle_attempts >= 8 THEN 'attempts_exhausted' ELSE op.last_error_code END,
 last_error=CASE WHEN op.cycle_attempts >= 8 THEN 'Automatic export attempts exhausted; inspect the destination and retry.' ELSE op.last_error END,
 updated_at=now()
FROM candidate WHERE op.id=candidate.id RETURNING op.*;

-- name: CompleteCockpitMinutesExport :one
UPDATE cockpit_minutes_export SET status='succeeded',revision=revision+1,
 completed_at=now(),updated_at=now(),size_bytes=sqlc.arg('size_bytes')::bigint,
 last_error_code='',last_error='',next_retry_at=NULL,lease_token=NULL,lease_expires_at=NULL
WHERE id=sqlc.arg('id')::uuid AND workspace_id=sqlc.arg('workspace_id')::uuid
 AND status='running' AND lease_token=sqlc.arg('lease_token')::uuid AND lease_expires_at > now()
RETURNING *;

-- name: FailCockpitMinutesExport :one
UPDATE cockpit_minutes_export SET
 status=CASE WHEN sqlc.arg('retryable')::bool AND cycle_attempts < 8 THEN 'retry_wait' ELSE 'needs_attention' END,
 revision=revision+1,updated_at=now(),last_error_code=sqlc.arg('error_code')::text,last_error=sqlc.arg('error_message')::text,
 next_retry_at=CASE WHEN sqlc.arg('retryable')::bool AND cycle_attempts < 8 THEN now()+sqlc.arg('backoff')::interval ELSE NULL END,
 lease_token=NULL,lease_expires_at=NULL
WHERE id=sqlc.arg('id')::uuid AND workspace_id=sqlc.arg('workspace_id')::uuid
 AND status='running' AND lease_token=sqlc.arg('lease_token')::uuid AND lease_expires_at > now()
RETURNING *;

-- name: DeleteCockpitMinutesExportsByWorkspace :exec
DELETE FROM cockpit_minutes_export WHERE workspace_id=$1;
