-- name: CountCockpitDirectoryPage :one
SELECT count(*)::bigint FROM cockpit_directory
WHERE workspace_id=sqlc.arg('workspace_id')::uuid
  AND cockpit_id=(SELECT c.id FROM cockpit c WHERE c.workspace_id=sqlc.arg('workspace_id')::uuid)
  AND (NOT sqlc.arg('filter_parties')::boolean OR party=ANY(sqlc.arg('parties')::text[]))
  AND (sqlc.arg('q')::text='' OR strpos(lower(party || ' ' || name || ' ' || position), lower(sqlc.arg('q')::text))>0);

-- name: ListCockpitDirectoryPage :many
SELECT * FROM cockpit_directory
WHERE workspace_id=sqlc.arg('workspace_id')::uuid
  AND cockpit_id=(SELECT c.id FROM cockpit c WHERE c.workspace_id=sqlc.arg('workspace_id')::uuid)
  AND (NOT sqlc.arg('filter_parties')::boolean OR party=ANY(sqlc.arg('parties')::text[]))
  AND (sqlc.arg('q')::text='' OR strpos(lower(party || ' ' || name || ' ' || position), lower(sqlc.arg('q')::text))>0)
  AND (NOT sqlc.arg('after')::boolean OR (party,name)>(sqlc.arg('after_party')::text,sqlc.arg('after_name')::text))
ORDER BY party,name LIMIT sqlc.arg('page_limit')::int;

-- name: UpsertCockpitDirectoryCompact :one
INSERT INTO cockpit_directory (workspace_id,cockpit_id,party,name,position)
SELECT sqlc.arg('workspace_id')::uuid,sqlc.arg('cockpit_id')::uuid,sqlc.arg('party')::text,sqlc.arg('name')::text,sqlc.arg('position')::text
WHERE NOT sqlc.arg('only_unknown_names')::boolean OR NOT EXISTS (
 SELECT 1 FROM cockpit_directory WHERE workspace_id=sqlc.arg('workspace_id')::uuid
 AND cockpit_id=sqlc.arg('cockpit_id')::uuid AND name=sqlc.arg('name')::text
)
ON CONFLICT (cockpit_id,party,name) DO UPDATE SET
 position=CASE WHEN sqlc.arg('clear_position')::boolean THEN ''
 WHEN EXCLUDED.position<>'' THEN EXCLUDED.position ELSE cockpit_directory.position END,
 updated_at=now()
WHERE cockpit_directory.workspace_id=EXCLUDED.workspace_id
RETURNING *;

-- name: LockCockpitDirectoryNaturalKey :one
SELECT * FROM cockpit_directory WHERE workspace_id=sqlc.arg('workspace_id')::uuid
AND cockpit_id=sqlc.arg('cockpit_id')::uuid AND party=sqlc.arg('party')::text AND name=sqlc.arg('name')::text FOR UPDATE;

-- name: DeleteCockpitDirectoryCompact :one
DELETE FROM cockpit_directory WHERE workspace_id=sqlc.arg('workspace_id')::uuid
AND cockpit_id=sqlc.arg('cockpit_id')::uuid AND party=sqlc.arg('party')::text AND name=sqlc.arg('name')::text AND source='user'
RETURNING *;
