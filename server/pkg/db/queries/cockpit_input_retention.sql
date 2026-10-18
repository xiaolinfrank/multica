-- name: HasCockpitInputIssueHistory :one
SELECT EXISTS(SELECT 1 FROM cockpit_issue_input_manifest_version v WHERE v.workspace_id=$1 AND v.issue_id=$2
AND (EXISTS(SELECT 1 FROM agent_task_queue t WHERE t.input_manifest_version_id=v.id)
OR EXISTS(SELECT 1 FROM cockpit_artifact_version a WHERE a.workspace_id=v.workspace_id AND a.input_manifest_version_id=v.id)))::boolean;

-- name: HasCockpitInputMeetingReferences :one
SELECT EXISTS(SELECT 1 FROM cockpit_input_reference WHERE workspace_id=$1 AND meeting_id=$2 AND removed_at IS NULL)::boolean;

-- name: DeleteCockpitInputManifestItemsByIssue :exec
DELETE FROM cockpit_issue_input_manifest_item i WHERE i.workspace_id=sqlc.arg(workspace_id) AND i.manifest_version_id IN
(SELECT v.id FROM cockpit_issue_input_manifest_version v WHERE v.workspace_id=sqlc.arg(workspace_id) AND v.issue_id=sqlc.arg(issue_id));

-- name: DeleteCockpitInputManifestHeadByIssue :exec
DELETE FROM cockpit_issue_input_manifest WHERE workspace_id=$1 AND issue_id=$2;

-- name: DeleteCockpitInputManifestVersionsByIssue :exec
DELETE FROM cockpit_issue_input_manifest_version WHERE workspace_id=$1 AND issue_id=$2;

-- name: DeleteRemovedCockpitInputReferencesByMeeting :exec
DELETE FROM cockpit_input_reference WHERE workspace_id=$1 AND meeting_id=$2 AND removed_at IS NOT NULL;

-- name: HasCockpitInputReferencesForBoard :one
SELECT EXISTS(SELECT 1 FROM cockpit_input_reference r JOIN cockpit_meeting m ON m.workspace_id=r.workspace_id AND m.id=r.meeting_id
WHERE r.workspace_id=sqlc.arg(workspace_id) AND m.cockpit_id=sqlc.arg(cockpit_id) AND r.removed_at IS NULL)::boolean;

-- name: DeleteRemovedCockpitInputReferencesByBoard :exec
DELETE FROM cockpit_input_reference r WHERE r.workspace_id=sqlc.arg(workspace_id) AND r.removed_at IS NOT NULL
AND EXISTS(SELECT 1 FROM cockpit_meeting m WHERE m.workspace_id=r.workspace_id AND m.id=r.meeting_id AND m.cockpit_id=sqlc.arg(cockpit_id));

-- name: ReadCockpitInputReferencedMeetings :many
SELECT m.id,m.title,count(*) OVER()::bigint AS total FROM cockpit_meeting m
WHERE m.workspace_id=sqlc.arg(workspace_id) AND m.cockpit_id=sqlc.arg(cockpit_id)
AND EXISTS(SELECT 1 FROM cockpit_input_reference r WHERE r.workspace_id=m.workspace_id AND r.meeting_id=m.id AND r.removed_at IS NULL)
ORDER BY m.id LIMIT 3;
