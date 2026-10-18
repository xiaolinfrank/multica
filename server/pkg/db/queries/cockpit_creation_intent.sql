-- name: GetCockpitCreationIntent :one
SELECT * FROM cockpit_creation_intent WHERE workspace_id=$1 AND resource_kind=$2 AND creation_key=$3;

-- name: CreateCockpitCreationIntent :exec
INSERT INTO cockpit_creation_intent(workspace_id,resource_kind,creation_key,request_hash,actor_id,resource_id,receipt)
VALUES($1,$2,$3,$4,$5,$6,$7);

-- name: CockpitCreationResourceExists :one
SELECT CASE WHEN sqlc.arg('resource_kind')::text='node' THEN
 EXISTS(SELECT 1 FROM cockpit_node n JOIN cockpit c ON c.id=n.cockpit_id AND c.workspace_id=n.workspace_id WHERE n.workspace_id=sqlc.arg('workspace_id')::uuid AND n.id=sqlc.arg('resource_id')::uuid)
 WHEN sqlc.arg('resource_kind')::text='meeting' THEN
 EXISTS(SELECT 1 FROM cockpit_meeting m JOIN cockpit c ON c.id=m.cockpit_id AND c.workspace_id=m.workspace_id WHERE m.workspace_id=sqlc.arg('workspace_id')::uuid AND m.id=sqlc.arg('resource_id')::uuid)
 ELSE false END::bool AS exists;

-- name: DeleteCockpitCreationIntentsByWorkspace :exec
DELETE FROM cockpit_creation_intent WHERE workspace_id=$1;

-- name: LockCockpitCreationMember :one
SELECT user_id FROM member WHERE workspace_id=$1 AND user_id=$2 FOR KEY SHARE;
