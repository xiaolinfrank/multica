-- name: ListCockpitMeetingDirectoryMetadata :many
-- Empty directory records still participate in the folder-name fallback.
-- Keep the register ordering for duplicate-name matching; never load bodies.
SELECT id, code, title, meet_date, nas_dir
FROM cockpit_meeting
WHERE workspace_id = sqlc.arg('workspace_id')::uuid
  AND cockpit_id = sqlc.arg('cockpit_id')::uuid
ORDER BY meet_date DESC NULLS LAST, start_time DESC NULLS LAST, time_range DESC;

-- name: ListCockpitMeetingRecordedDirectories :many
SELECT nas_dir
FROM cockpit_meeting
WHERE workspace_id = sqlc.arg('workspace_id')::uuid
  AND cockpit_id = sqlc.arg('cockpit_id')::uuid
  AND btrim(nas_dir) <> '';
