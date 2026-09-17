-- name: ListModules :many
-- project_id is optional: absent lists the whole workspace, present one
-- project. Order is display order with created_at as the stable tiebreak.
SELECT * FROM module
WHERE workspace_id = $1
  AND (sqlc.narg('project_id')::uuid IS NULL OR project_id = sqlc.narg('project_id'))
ORDER BY position ASC, created_at ASC;

-- name: GetModuleInWorkspace :one
SELECT * FROM module
WHERE id = $1 AND workspace_id = $2;

-- name: GetModulesByIDs :many
-- Reorder validation: resolve every submitted id inside one workspace read so
-- "all ids exist in workspace" and "share one project" are checked on one
-- snapshot.
SELECT * FROM module
WHERE workspace_id = $1 AND id = ANY(sqlc.arg('ids')::uuid[]);

-- name: CreateModule :one
-- Appends to the project: position is MAX+1 computed inside the INSERT. This
-- is NOT concurrency-safe: two concurrent creates can evaluate the same MAX
-- and land on the same position. Display order stays deterministic anyway —
-- ListModules tiebreaks on created_at — and ReorderModules rewrites the whole
-- set, which heals any collision.
INSERT INTO module (workspace_id, project_id, title, description, position)
VALUES (
    $1, $2, $3, sqlc.narg('description'),
    COALESCE((SELECT MAX(position) FROM module WHERE project_id = $2), 0) + 1
) RETURNING *;

-- name: UpdateModule :one
-- title and position keep the prior value when absent (COALESCE);
-- description is a bare narg, so presence semantics belong to the caller.
UPDATE module SET
    title = COALESCE(sqlc.narg('title'), title),
    description = sqlc.narg('description'),
    position = COALESCE(sqlc.narg('position'), position),
    updated_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING *;

-- name: ReorderModules :execrows
-- Atomic whole-set reorder. One statement, so a failure leaves the entire
-- order untouched instead of the partially-applied prefix a per-row loop
-- produces. Positions are the submitted order's indices (0..n-1).
UPDATE module m
SET position = (sqlc.arg('positions')::float8[])[v.ordinality],
    updated_at = now()
FROM unnest(sqlc.arg('ids')::uuid[]) WITH ORDINALITY AS v(id, ordinality)
WHERE m.id = v.id
  AND m.workspace_id = sqlc.arg('workspace_id')::uuid;

-- name: DeleteModule :execrows
-- Defense-in-depth: workspace_id is a SQL-layer tenant guard. See DeleteIssue.
DELETE FROM module WHERE id = $1 AND workspace_id = $2;

-- name: GetModuleIssueStats :many
-- Batched per-module issue counts, mirroring GetProjectIssueStats: done is
-- the terminal-status share the caller resolves from the workspace catalog.
SELECT module_id,
       count(*)::bigint AS total_count,
       count(*) FILTER (WHERE status = ANY(sqlc.arg('terminal_status_keys')::text[]))::bigint AS done_count
FROM issue
WHERE workspace_id = sqlc.arg('workspace_id')::uuid
  AND module_id = ANY(sqlc.arg('module_ids')::uuid[])
GROUP BY module_id;

-- name: DetachIssuesFromModule :execrows
-- Module deletion keeps the issues: they fall back to sitting directly under
-- the project. revision + 1 so clients holding the row refetch it.
UPDATE issue
SET module_id = NULL,
    revision = revision + 1,
    updated_at = now()
WHERE module_id = $1 AND workspace_id = $2;

-- name: DetachProjectModuleIssues :execrows
-- Project deletion, module half: issues in any of the project's modules are
-- detached before the module rows go, in the caller's transaction.
UPDATE issue
SET module_id = NULL,
    revision = revision + 1,
    updated_at = now()
WHERE issue.workspace_id = $1
  AND module_id IN (SELECT m.id FROM module m WHERE m.project_id = $2 AND m.workspace_id = $1);

-- name: DeleteModulesForProject :execrows
DELETE FROM module WHERE workspace_id = $1 AND project_id = $2;
