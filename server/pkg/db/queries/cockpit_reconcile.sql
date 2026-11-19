-- Reconciliation reads and writes. One-off plan migration (§3 of the
-- implementation plan): the service loads the board, computes the target
-- structure, and applies it inside one transaction.

-- name: ListCockpitReconcileIssues :many
SELECT i.id,i.number,i.title,i.status,i.project_id,i.module_id,i.work_item_id,i.parent_issue_id
FROM issue i
WHERE i.workspace_id=sqlc.arg('workspace_id')::uuid
ORDER BY i.number,i.id;

-- name: ListCockpitNodeDependents :many
-- What stops a structural merge: money, milestones, issue references, meeting
-- links and artifact ownership on the node itself.
SELECT n.id AS node_id,
 (SELECT count(*) FROM cockpit_payment p WHERE p.node_id=n.id)::bigint AS payments,
 (SELECT count(*) FROM cockpit_milestone m WHERE m.node_id=n.id)::bigint AS milestones,
 (SELECT count(*) FROM cockpit_node_issue l WHERE l.node_id=n.id)::bigint AS issue_links,
 (SELECT count(*) FROM cockpit_meeting_node l WHERE l.node_id=n.id)::bigint AS meeting_links,
 (SELECT count(*) FROM cockpit_artifact a WHERE a.owner_node_id=n.id)::bigint AS artifacts
FROM cockpit_node n
WHERE n.workspace_id=sqlc.arg('workspace_id')::uuid;

-- name: UpdateCockpitNodeStructure :exec
UPDATE cockpit_node SET
    parent_id=sqlc.narg('parent_id')::uuid,
    project_id=sqlc.narg('project_id')::uuid,
    module_id=sqlc.narg('module_id')::uuid,
    code=sqlc.arg('code')::text,
    name=sqlc.arg('name')::text,
    position=sqlc.arg('position')::double precision,
    updated_at=now()
WHERE workspace_id=sqlc.arg('workspace_id')::uuid AND id=sqlc.arg('id')::uuid;

-- name: UpdateCockpitNodeCode :exec
UPDATE cockpit_node SET code=sqlc.arg('code')::text, updated_at=now()
WHERE workspace_id=sqlc.arg('workspace_id')::uuid AND id=sqlc.arg('id')::uuid;

-- name: SetCockpitNodeDirectoryName :exec
UPDATE cockpit_node SET directory_name=sqlc.arg('directory_name')::text, updated_at=now()
WHERE workspace_id=sqlc.arg('workspace_id')::uuid AND id=sqlc.arg('id')::uuid;

-- name: DeleteCockpitNodeRow :exec
DELETE FROM cockpit_node WHERE workspace_id=sqlc.arg('workspace_id')::uuid AND id=sqlc.arg('id')::uuid;

-- name: CreateProjectForReconcile :one
INSERT INTO project (id, workspace_id, title, status, collab_path, creator_type, creator_id)
VALUES (
    sqlc.arg('id')::uuid,
    sqlc.arg('workspace_id')::uuid,
    sqlc.arg('title')::text,
    sqlc.arg('status')::text,
    sqlc.narg('collab_path')::text,
    sqlc.narg('creator_type')::text,
    sqlc.narg('creator_id')::uuid
) RETURNING *;

-- name: CreateModuleForReconcile :one
INSERT INTO module (id, workspace_id, project_id, title, description, directory_name, position)
VALUES (
    sqlc.arg('id')::uuid,
    sqlc.arg('workspace_id')::uuid,
    sqlc.arg('project_id')::uuid,
    sqlc.arg('title')::text,
    NULL,
    sqlc.narg('directory_name')::text,
    COALESCE((SELECT MAX(position) FROM module WHERE project_id=sqlc.arg('project_id')::uuid), 0) + 1
) RETURNING *;

-- name: CreateCockpitReconcileNode :one
INSERT INTO cockpit_node (id, workspace_id, cockpit_id, parent_id, project_id, module_id, code, name, position, directory_name)
VALUES (
    sqlc.arg('id')::uuid,
    sqlc.arg('workspace_id')::uuid,
    sqlc.arg('cockpit_id')::uuid,
    sqlc.narg('parent_id')::uuid,
    sqlc.narg('project_id')::uuid,
    sqlc.narg('module_id')::uuid,
    sqlc.arg('code')::text,
    sqlc.arg('name')::text,
    sqlc.arg('position')::double precision,
    sqlc.narg('directory_name')::text
) RETURNING *;

-- name: UpdateProjectTitle :exec
UPDATE project SET title=sqlc.arg('title')::text, updated_at=now()
WHERE workspace_id=sqlc.arg('workspace_id')::uuid AND id=sqlc.arg('id')::uuid;

-- name: UpdateModuleTitle :exec
UPDATE module SET title=sqlc.arg('title')::text, updated_at=now()
WHERE workspace_id=sqlc.arg('workspace_id')::uuid AND id=sqlc.arg('id')::uuid;

-- name: SetIssueWorkItem :exec
-- Single-issue filing used by the backfill pass. The parent/child pass decides
-- the final target before this runs, so it does not cascade on its own.
UPDATE issue i SET
    work_item_id=sqlc.narg('work_item_id')::uuid,
    project_id=sqlc.narg('project_id')::uuid,
    module_id=sqlc.narg('module_id')::uuid,
    revision=i.revision+1,
    last_activity_at=GREATEST(COALESCE(i.last_activity_at,i.updated_at),now()),
    updated_at=now()
WHERE i.workspace_id=sqlc.arg('workspace_id')::uuid AND i.id=sqlc.arg('issue_id')::uuid;

-- name: DeleteDanglingCockpitNodeIssue :exec
DELETE FROM cockpit_node_issue l
WHERE l.workspace_id=sqlc.arg('workspace_id')::uuid
  AND NOT EXISTS(SELECT 1 FROM issue i WHERE i.workspace_id=l.workspace_id AND i.id=l.issue_id);

-- name: MarkCockpitPlanReconciled :exec
UPDATE cockpit SET plan_reconciled_at=now(), updated_at=now()
WHERE workspace_id=sqlc.arg('workspace_id')::uuid;

-- name: ListCockpitNodeIssueLinks :many
SELECT * FROM cockpit_node_issue WHERE workspace_id=sqlc.arg('workspace_id')::uuid;

-- name: MoveCockpitMilestonesToNode :exec
UPDATE cockpit_milestone SET node_id=sqlc.arg('node_id')::uuid, updated_at=now()
WHERE workspace_id=sqlc.arg('workspace_id')::uuid AND node_id=sqlc.arg('from_node_id')::uuid;

-- name: SaveCockpitReconcileReport :exec
-- Keeps the applied report next to the plan it rewrote: the snapshot freezes
-- structure only, so filings, title splits and created rows live here.
UPDATE cockpit SET reconcile_report=sqlc.arg('report')::jsonb, updated_at=now()
WHERE workspace_id=sqlc.arg('workspace_id')::uuid;
