-- name: GetCockpitIssuePrimary :one
SELECT * FROM cockpit_issue_primary WHERE workspace_id=$1 AND issue_id=$2;

-- name: TombstoneCockpitIssuePrimary :exec
UPDATE cockpit_issue_primary SET node_id=NULL,issue_deleted_at=now(),revision=revision+1,updated_at=now()
WHERE workspace_id=$1 AND issue_id=$2 AND issue_deleted_at IS NULL;

-- name: EnsureCockpitNodeReference :exec
INSERT INTO cockpit_node_issue(workspace_id,node_id,issue_id,position) VALUES($1,$2,$3,0)
ON CONFLICT(node_id,issue_id) DO NOTHING;

-- name: LockCockpitIssuePrimary :one
SELECT * FROM cockpit_issue_primary WHERE workspace_id=$1 AND issue_id=$2 FOR UPDATE;

-- name: GetCockpitNodeTaskCreation :one
SELECT * FROM cockpit_issue_primary WHERE workspace_id=$1 AND creation_key=$2;

-- name: CreateCockpitIssuePrimary :one
INSERT INTO cockpit_issue_primary(issue_id,workspace_id,node_id,creation_key,creation_node_id,creation_hash,created_by,updated_by)
VALUES($1,$2,sqlc.narg('node_id')::uuid,sqlc.narg('creation_key')::uuid,sqlc.narg('creation_node_id')::uuid,$3,$4,$4)
RETURNING *;

-- name: SetCockpitIssuePrimary :one
UPDATE cockpit_issue_primary SET node_id=sqlc.narg('node_id')::uuid,revision=revision+1,updated_by=sqlc.arg('actor_id')::uuid,updated_at=now()
WHERE workspace_id=sqlc.arg('workspace_id')::uuid AND issue_id=sqlc.arg('issue_id')::uuid
 AND revision=sqlc.arg('expected_revision')::bigint AND issue_deleted_at IS NULL RETURNING *;

-- name: ListCockpitIssueFacts :many
SELECT i.id,i.number,(w.issue_prefix||'-'||i.number::text)::text AS identifier,i.title,i.status,
 cockpit_issue_category(i.status,s.category)::text AS status_category,i.priority,i.assignee_type,i.assignee_id,
 COALESCE(u.name,a.name,sq.name,'')::text AS assignee_name,i.due_date,i.project_id,i.module_id,
 p.node_id AS primary_node_id,COALESCE(n.code,'')::text AS primary_node_code,COALESCE(n.name,'')::text AS primary_node_name,
 COALESCE(p.revision,0)::bigint AS primary_revision,p.creation_key
FROM issue i JOIN workspace w ON w.id=i.workspace_id
LEFT JOIN issue_status s ON s.workspace_id=i.workspace_id AND s.key=i.status
LEFT JOIN cockpit_issue_primary p ON p.workspace_id=i.workspace_id AND p.issue_id=i.id
LEFT JOIN cockpit_node n ON n.id=p.node_id AND n.workspace_id=i.workspace_id
LEFT JOIN "user" u ON i.assignee_type='member' AND u.id=i.assignee_id
LEFT JOIN agent a ON i.assignee_type='agent' AND a.id=i.assignee_id AND a.workspace_id=i.workspace_id
LEFT JOIN squad sq ON i.assignee_type='squad' AND sq.id=i.assignee_id AND sq.workspace_id=i.workspace_id
WHERE i.workspace_id=$1 AND i.id=ANY(sqlc.arg('issue_ids')::uuid[]);

-- name: ListCockpitNodeTaskIDs :many
WITH candidates AS (
 SELECT p.issue_id FROM cockpit_issue_primary p
 WHERE p.workspace_id=sqlc.arg('workspace_id')::uuid AND p.node_id=sqlc.arg('node_id')::uuid AND sqlc.arg('relation')::text='primary'
 UNION ALL
 SELECT l.issue_id FROM cockpit_node_issue l
 WHERE l.workspace_id=sqlc.arg('workspace_id')::uuid AND l.node_id=sqlc.arg('node_id')::uuid AND sqlc.arg('relation')::text='reference'
  AND NOT EXISTS(SELECT 1 FROM cockpit_issue_primary p WHERE p.workspace_id=l.workspace_id AND p.issue_id=l.issue_id AND p.node_id=l.node_id)
)
SELECT i.id,i.number FROM candidates c JOIN issue i ON i.id=c.issue_id JOIN workspace w ON w.id=i.workspace_id
LEFT JOIN issue_status s ON s.workspace_id=i.workspace_id AND s.key=i.status
WHERE i.workspace_id=sqlc.arg('workspace_id')::uuid

 AND (sqlc.arg('status')::text='' OR i.status=sqlc.arg('status')::text)
 AND (sqlc.arg('category')::text='' OR cockpit_issue_category(i.status,s.category)=sqlc.arg('category')::text OR (sqlc.arg('category')::text='active' AND cockpit_issue_category(i.status,s.category) NOT IN ('done','closed')))
 AND (sqlc.arg('query')::text='' OR strpos(lower(i.title||' '||w.issue_prefix||'-'||i.number::text),lower(sqlc.arg('query')::text))>0)
 AND (sqlc.narg('cursor_id')::uuid IS NULL OR (i.number,i.id)<(sqlc.arg('cursor_number')::int,sqlc.narg('cursor_id')::uuid))
ORDER BY i.number DESC,i.id DESC LIMIT sqlc.arg('page_limit')::int;

-- name: CountCockpitNodeTasksByStatus :many
WITH candidates AS (
 SELECT p.issue_id FROM cockpit_issue_primary p
 WHERE p.workspace_id=sqlc.arg('workspace_id')::uuid AND p.node_id=sqlc.arg('node_id')::uuid AND sqlc.arg('relation')::text='primary'
 UNION ALL
 SELECT l.issue_id FROM cockpit_node_issue l
 WHERE l.workspace_id=sqlc.arg('workspace_id')::uuid AND l.node_id=sqlc.arg('node_id')::uuid AND sqlc.arg('relation')::text='reference'
  AND NOT EXISTS(SELECT 1 FROM cockpit_issue_primary p WHERE p.workspace_id=l.workspace_id AND p.issue_id=l.issue_id AND p.node_id=l.node_id)
)
SELECT i.status,cockpit_issue_category(i.status,s.category)::text AS category,count(*)::bigint AS total,
 count(*) FILTER(WHERE (sqlc.arg('status')::text='' OR i.status=sqlc.arg('status')::text)
 AND (sqlc.arg('category')::text='' OR cockpit_issue_category(i.status,s.category)=sqlc.arg('category')::text OR (sqlc.arg('category')::text='active' AND cockpit_issue_category(i.status,s.category) NOT IN ('done','closed')))
 AND (sqlc.arg('query')::text='' OR strpos(lower(i.title||' '||w.issue_prefix||'-'||i.number::text),lower(sqlc.arg('query')::text))>0))::bigint AS filtered_total
FROM candidates c JOIN issue i ON i.id=c.issue_id JOIN workspace w ON w.id=i.workspace_id
LEFT JOIN issue_status s ON s.workspace_id=i.workspace_id AND s.key=i.status
WHERE i.workspace_id=sqlc.arg('workspace_id')::uuid

GROUP BY i.status,cockpit_issue_category(i.status,s.category) ORDER BY i.status;

-- name: HasCockpitPrimaryForProject :one
SELECT EXISTS(SELECT 1 FROM cockpit_issue_primary p JOIN issue i ON i.id=p.issue_id AND i.workspace_id=p.workspace_id
WHERE p.workspace_id=$1 AND p.node_id IS NOT NULL AND i.project_id=$2)::bool;

-- name: HasCockpitPlanningForBoard :one
SELECT EXISTS(SELECT 1 FROM cockpit_issue_primary p JOIN cockpit_node n ON n.id=p.node_id AND n.workspace_id=p.workspace_id
 WHERE p.workspace_id=sqlc.arg('workspace_id')::uuid AND n.cockpit_id=sqlc.arg('cockpit_id')::uuid
 UNION ALL SELECT 1 FROM cockpit_meeting_action a JOIN cockpit_meeting m ON m.id=a.meeting_id AND m.workspace_id=a.workspace_id
 WHERE a.workspace_id=sqlc.arg('workspace_id')::uuid AND m.cockpit_id=sqlc.arg('cockpit_id')::uuid
 UNION ALL SELECT 1 FROM cockpit_artifact a JOIN cockpit_node n ON n.workspace_id=a.workspace_id AND n.id=a.owner_node_id WHERE a.workspace_id=sqlc.arg('workspace_id')::uuid AND n.cockpit_id=sqlc.arg('cockpit_id')::uuid
 UNION ALL SELECT 1 FROM cockpit_acceptance_definition d JOIN cockpit_node n ON n.workspace_id=d.workspace_id AND n.id=d.node_id WHERE d.workspace_id=sqlc.arg('workspace_id')::uuid AND n.cockpit_id=sqlc.arg('cockpit_id')::uuid)::bool;

-- name: HasCockpitPrimaryForModule :one
SELECT EXISTS(SELECT 1 FROM cockpit_issue_primary p JOIN issue i ON i.id=p.issue_id AND i.workspace_id=p.workspace_id
WHERE p.workspace_id=$1 AND p.node_id IS NOT NULL AND i.module_id=$2)::bool;
