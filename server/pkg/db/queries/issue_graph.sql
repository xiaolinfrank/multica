-- Read-side queries for the issue graph endpoint (GET /api/issues/graph).
-- The graph is served as one whole-workspace snapshot: nodes are issues
-- (slimmed columns; filtering and layout happen client-side), edges are the
-- three issue-to-issue relations the product tracks:
--   child     — issue.parent_issue_id (source=parent, target=child)
--   blocks / blocked_by / related — issue_dependency rows, passed through
--   mention   — issue references extracted from issue descriptions and
--               comment bodies at read time (no persisted index)

-- name: ListIssueGraphNodes :many
-- Whole-workspace node set. Unlike ListIssues there is no LIMIT: the graph is
-- only useful as the full picture, and workspace issue counts stay in the
-- thousands (the same bet ListOpenIssues makes). An optional project_id narrows
-- the snapshot to one project; cross-project edges are dropped in the handler.
-- description rides along only to extract mention references. assignee_type
-- and assignee_id ride along to label nodes with their assignee display name
-- (resolved in the handler through the workspace member/agent lists).
SELECT i.id, i.number, i.title, i.description, i.status, i.priority,
       i.project_id, i.parent_issue_id, i.updated_at,
       i.assignee_type, i.assignee_id
FROM issue i
WHERE i.workspace_id = $1
  AND (sqlc.narg('project_id')::uuid IS NULL OR i.project_id = sqlc.narg('project_id')::uuid)
ORDER BY i.created_at ASC;

-- name: ListIssueGraphDependencies :many
-- issue_dependency has no workspace_id column of its own, so tenancy is
-- resolved through the referencing issue. Both endpoints of a dependency row
-- are re-validated against the visible node set in the handler.
SELECT d.issue_id, d.depends_on_issue_id, d.type
FROM issue_dependency d
JOIN issue i ON i.id = d.issue_id
WHERE i.workspace_id = $1;

-- name: ListIssueGraphCommentBodies :many
-- Raw comment text for mention extraction. All comment types are included:
-- agent progress and system comments carry markdown bodies that may reference
-- issues just like human comments do.
SELECT c.issue_id, c.content
FROM comment c
JOIN issue i ON i.id = c.issue_id
WHERE i.workspace_id = $1;

-- name: ListIssueIDsByNumbers :many
-- Batch-resolves bare identifiers (PREFIX-<number>) to issue UUIDs for the
-- current workspace only. Callers must have already checked the identifier
-- prefix against the workspace issue prefix; the (workspace_id, number)
-- unique index makes this lookup exact.
SELECT i.id, i.number
FROM issue i
WHERE i.workspace_id = $1
  AND i.number = ANY($2::int[]);
