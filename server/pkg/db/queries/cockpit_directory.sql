-- name: GetCockpitNodeByModuleID :one
-- A module's L2 row. The row and module.directory_name are kept identical:
-- the folder belongs to the module, and the row is what the tree reads.
SELECT * FROM cockpit_node
WHERE workspace_id = sqlc.arg('workspace_id')::uuid
  AND module_id = sqlc.arg('module_id')::uuid
ORDER BY position, id
LIMIT 1;

-- name: SetModuleDirectoryName :exec
-- Only the folder name; title/description presence semantics stay on
-- UpdateModule, which cannot express "set this and keep the description".
UPDATE module SET directory_name = sqlc.arg('directory_name')::text, updated_at = now()
WHERE workspace_id = sqlc.arg('workspace_id')::uuid
  AND id = sqlc.arg('id')::uuid;
