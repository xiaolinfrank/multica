-- name: DeleteCockpitArtifactsByWorkspace :exec
-- Physical object cleanup retains durable ownership after workspace deletion.
WITH attempts AS (
 UPDATE cockpit_artifact_capture_attempt d SET cleanup_status='pending',cleanup_next_attempt_at=now(),updated_at=now() WHERE d.workspace_id=$1 AND cleanup_status<>'deleted'
), captures AS (DELETE FROM cockpit_artifact_capture d WHERE d.workspace_id=$1),
artifact_handoffs AS (DELETE FROM cockpit_artifact_reviewer_handoff d WHERE d.workspace_id=$1),
producers AS (DELETE FROM cockpit_artifact_producer_assignment d WHERE d.workspace_id=$1),
node_refs AS (DELETE FROM cockpit_artifact_node_reference d WHERE d.workspace_id=$1),
meeting_refs AS (DELETE FROM cockpit_artifact_meeting_reference d WHERE d.workspace_id=$1),
acceptance_handoffs AS (DELETE FROM cockpit_acceptance_reviewer_handoff d WHERE d.workspace_id=$1),
evidence AS (DELETE FROM cockpit_acceptance_evidence d WHERE d.workspace_id=$1),
request_criteria AS (DELETE FROM cockpit_acceptance_request_criterion d WHERE d.workspace_id=$1),
requests AS (DELETE FROM cockpit_acceptance_request d WHERE d.workspace_id=$1),
criteria AS (DELETE FROM cockpit_acceptance_criterion d WHERE d.workspace_id=$1),
definitions AS (DELETE FROM cockpit_acceptance_definition d WHERE d.workspace_id=$1),
versions AS (DELETE FROM cockpit_artifact_version d WHERE d.workspace_id=$1)
DELETE FROM cockpit_artifact d WHERE d.workspace_id=$1;

-- name: ClaimCockpitArtifactObjectCleanup :one
WITH due AS MATERIALIZED (
 SELECT id FROM cockpit_artifact_capture_attempt WHERE cleanup_status IN ('pending','deleting','deleted') AND io_finished_at IS NOT NULL
 AND cleanup_next_attempt_at<=now() AND (cleanup_lease_expires_at IS NULL OR cleanup_lease_expires_at<=now())
 ORDER BY cleanup_next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
)
UPDATE cockpit_artifact_capture_attempt a SET cleanup_status='deleting',cleanup_token=$1,cleanup_lease_expires_at=now()+interval '5 minutes',cleanup_attempts=cleanup_attempts+1,updated_at=now()
FROM due WHERE a.id=due.id RETURNING a.*;

-- name: CompleteCockpitArtifactObjectCleanup :execrows
UPDATE cockpit_artifact_capture_attempt SET cleanup_status='deleted',cleanup_token=NULL,cleanup_lease_expires_at=NULL,cleanup_error='',cleanup_next_attempt_at=now()+interval '24 hours',updated_at=now()
WHERE id=$1 AND cleanup_token=$2 AND cleanup_status='deleting';

-- name: FailCockpitArtifactObjectCleanup :execrows
UPDATE cockpit_artifact_capture_attempt SET cleanup_status='pending',cleanup_token=NULL,cleanup_lease_expires_at=NULL,cleanup_error=$3,cleanup_next_attempt_at=now()+interval '5 minutes',updated_at=now()
WHERE id=$1 AND cleanup_token=$2 AND cleanup_status='deleting';

-- name: HasCockpitArtifactScope :one
WITH RECURSIVE retained AS (
 SELECT a.owner_node_id AS id FROM cockpit_artifact a WHERE a.workspace_id=sqlc.arg(workspace_id)
 UNION SELECT d.node_id FROM cockpit_acceptance_definition d WHERE d.workspace_id=sqlc.arg(workspace_id)
 UNION SELECT r.node_id FROM cockpit_artifact_node_reference r WHERE r.workspace_id=sqlc.arg(workspace_id) AND r.removed_at IS NULL
), ancestors AS (
 SELECT n.id,n.parent_id,n.project_id,n.module_id FROM cockpit_node n JOIN retained r ON r.id=n.id WHERE n.workspace_id=sqlc.arg(workspace_id)
 UNION
 SELECT n.id,n.parent_id,n.project_id,n.module_id FROM cockpit_node n JOIN ancestors a ON n.id=a.parent_id WHERE n.workspace_id=sqlc.arg(workspace_id)
)
SELECT EXISTS(SELECT 1 FROM ancestors WHERE (sqlc.narg(project_id)::uuid IS NOT NULL AND project_id=sqlc.narg(project_id)) OR (sqlc.narg(module_id)::uuid IS NOT NULL AND module_id=sqlc.narg(module_id)))::boolean;

-- name: HasCockpitArtifactMeeting :one
SELECT EXISTS(SELECT 1 FROM cockpit_artifact_version v WHERE v.workspace_id=$1 AND v.source_meeting_id=$2
 UNION ALL SELECT 1 FROM cockpit_artifact_meeting_reference r WHERE r.workspace_id=$1 AND r.meeting_id=$2 AND r.removed_at IS NULL)::boolean;

-- name: ListCockpitArtifactOwnerLabels :many
SELECT id,name FROM cockpit_node WHERE workspace_id=$1 AND id=ANY($2::uuid[]);

-- name: ListCockpitArtifactEvidencePins :many
SELECT a.id,a.approved_version_id FROM cockpit_artifact a WHERE a.workspace_id=$1 AND a.id=ANY($2::uuid[]) AND a.approved_version_id IS NOT NULL
AND (a.owner_node_id=$3 OR EXISTS(SELECT 1 FROM cockpit_artifact_node_reference r WHERE r.workspace_id=a.workspace_id AND r.artifact_id=a.id AND r.version_id=a.approved_version_id AND r.node_id=$3 AND r.removed_at IS NULL));
