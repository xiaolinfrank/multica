-- name: LockCockpitInputManifestSelection :exec
SELECT pg_advisory_xact_lock(hashtextextended(sqlc.arg(workspace_id)::text || '/input-manifest-selection/' || sqlc.arg(issue_id)::text, 0));

-- name: ReadCockpitRunInputRequiredItems :many
SELECT input_version_id,position,required FROM cockpit_issue_input_manifest_item
WHERE workspace_id=$1 AND manifest_version_id=$2 ORDER BY position LIMIT 201;

-- name: LockCockpitInputRun :one
SELECT t.* FROM agent_task_queue t JOIN agent a ON a.id=t.agent_id
WHERE a.workspace_id=$1 AND t.id=$2 FOR UPDATE OF t;

-- name: RecordCockpitRunInputPreparation :one
UPDATE agent_task_queue t SET input_preparation_state=sqlc.arg(preparation_state)::text,
input_preparation_hash=CASE WHEN sqlc.arg(preparation_state)::text='required_ready' THEN sqlc.arg(manifest_hash)::text ELSE NULL END,
input_prepared_at=CASE WHEN sqlc.arg(preparation_state)::text='required_ready' THEN now() ELSE NULL END,
input_prepared_dispatched_at=CASE WHEN sqlc.arg(preparation_state)::text='required_ready' THEN t.dispatched_at ELSE NULL END,
input_preparation_error_code=sqlc.arg(error_code)::text
WHERE t.id=sqlc.arg(task_id) AND t.runtime_id=sqlc.arg(runtime_id)
AND t.dispatched_at=sqlc.arg(dispatched_at)::timestamptz AND t.status IN ('dispatched','waiting_local_directory')
AND t.input_manifest_version_id=sqlc.arg(manifest_version_id)
AND EXISTS (SELECT 1 FROM agent a WHERE a.id=t.agent_id AND a.workspace_id=sqlc.arg(workspace_id))
RETURNING t.*;

-- name: ReadLockedCockpitRunInputManifest :one
SELECT * FROM cockpit_issue_input_manifest WHERE workspace_id=$1 AND issue_id=$2 FOR SHARE;
