-- name: LockCockpitChangeForReview :one
SELECT * FROM cockpit_pending_change WHERE workspace_id=sqlc.arg('workspace_id')::uuid AND id=sqlc.arg('id')::uuid FOR UPDATE;

-- name: LockCockpitChangeNode :one
SELECT * FROM cockpit_node WHERE workspace_id=sqlc.arg('workspace_id')::uuid AND id=sqlc.arg('id')::uuid FOR UPDATE;
