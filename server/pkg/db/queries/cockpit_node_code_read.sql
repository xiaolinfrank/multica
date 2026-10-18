-- name: GetCockpitNodeCodeSequence :one
WITH codes AS (
 SELECT code FROM cockpit_used_codes WHERE workspace_id=sqlc.arg('workspace_id')::uuid
 UNION ALL SELECT code FROM cockpit_node WHERE workspace_id=sqlc.arg('workspace_id')::uuid
), matching AS (
 SELECT substring(code FROM length(sqlc.arg('prefix')::text)+1) AS suffix FROM codes
 WHERE starts_with(code,sqlc.arg('prefix')::text)
 AND substring(code FROM length(sqlc.arg('prefix')::text)+1) ~ '^\+?[0-9]+$'
)
SELECT COALESCE(max(CASE WHEN length(ltrim(suffix,'+'))<=18 THEN suffix::bigint END),0)::bigint AS maximum,
 COALESCE(bool_or(length(ltrim(suffix,'+'))>18),FALSE)::bool AS unsupported FROM matching;

-- name: GetCockpitSiblingMaximumPosition :one
SELECT COALESCE(max(position),0)::double precision FROM cockpit_node
WHERE workspace_id=sqlc.arg('workspace_id')::uuid AND cockpit_id=sqlc.arg('cockpit_id')::uuid
AND (parent_id=sqlc.narg('parent_id')::uuid OR (sqlc.narg('parent_id')::uuid IS NULL AND parent_id IS NULL));

-- name: GetCockpitNodeBindingConflict :one
SELECT id FROM cockpit_node
WHERE workspace_id=sqlc.arg('workspace_id')::uuid AND cockpit_id=sqlc.arg('cockpit_id')::uuid
AND ((sqlc.narg('module_id')::uuid IS NOT NULL AND module_id=sqlc.narg('module_id')::uuid)
 OR (sqlc.narg('module_id')::uuid IS NULL AND sqlc.narg('project_id')::uuid IS NOT NULL AND project_id=sqlc.narg('project_id')::uuid AND module_id IS NULL))
LIMIT 1;
