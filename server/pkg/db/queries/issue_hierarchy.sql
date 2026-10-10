-- name: LockIssueHierarchy :exec
-- Acquire after workspace KEY SHARE, before catalog/domain/Issue row locks.
-- This serializes existing-parent and inherited-scope changes within a workspace.
SELECT pg_advisory_xact_lock(hashtextextended(sqlc.arg(workspace_id)::uuid::text || ':issue_hierarchy',0));

-- name: GetIssueParentChainFacts :one
WITH RECURSIVE ancestors(id,parent_issue_id) AS (
 SELECT id,parent_issue_id FROM issue WHERE workspace_id=sqlc.arg(workspace_id)::uuid AND id=sqlc.arg(parent_id)::uuid
 UNION
 SELECT i.id,i.parent_issue_id FROM issue i JOIN ancestors a ON i.id=a.parent_issue_id WHERE i.workspace_id=sqlc.arg(workspace_id)::uuid
), facts AS (
 SELECT EXISTS(SELECT 1 FROM ancestors) AS parent_exists,
 EXISTS(SELECT 1 FROM ancestors WHERE id=sqlc.narg(issue_id)::uuid) AS would_cycle,
 EXISTS(SELECT 1 FROM ancestors a WHERE a.parent_issue_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM issue p WHERE p.id=a.parent_issue_id AND p.workspace_id=sqlc.arg(workspace_id)::uuid)) AS missing_ancestor,
 EXISTS(SELECT 1 FROM ancestors WHERE parent_issue_id IS NULL) AS has_root
)
SELECT parent_exists,would_cycle,missing_ancestor,(parent_exists AND NOT has_root AND NOT missing_ancestor)::boolean AS existing_cycle FROM facts;
