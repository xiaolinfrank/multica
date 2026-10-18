-- name: LockCockpitSnapshotBoard :one
SELECT id FROM cockpit WHERE workspace_id=$1 AND id=$2 FOR KEY SHARE;

-- name: GetCockpitSnapshotForDiff :one
-- Never transfer legacy meeting bodies or Issue relationship arrays to the comparer.
SELECT id,workspace_id,cockpit_id,created_at,
COALESCE(jsonb_typeof(payload)='object',false)::bool AS valid_document,
COALESCE(payload->'plan_identity','null'::jsonb)::jsonb AS plan_identity
FROM cockpit_snapshot WHERE workspace_id=$1 AND id=$2;

-- name: GetCockpitSnapshotPlanData :one
-- The complete counts distinguish a supported whole plan from a clipped read.
WITH args AS NOT MATERIALIZED (SELECT sqlc.arg('workspace_id')::uuid AS ws,sqlc.arg('cockpit_id')::uuid AS board),
nodes AS (SELECT n.* FROM cockpit_node n,args x WHERE n.workspace_id=x.ws AND n.cockpit_id=x.board ORDER BY n.id LIMIT 5001),
payments AS (SELECT p.* FROM cockpit_payment p,args x WHERE p.workspace_id=x.ws AND EXISTS(SELECT 1 FROM cockpit_node n WHERE n.id=p.node_id AND n.workspace_id=x.ws AND n.cockpit_id=x.board) ORDER BY p.id LIMIT 25001),
milestones AS (SELECT m.* FROM cockpit_milestone m,args x WHERE m.workspace_id=x.ws AND m.cockpit_id=x.board ORDER BY m.id LIMIT 2001)
SELECT jsonb_build_object('nodes',COALESCE((SELECT jsonb_agg(n) FROM nodes n),'[]'::jsonb),
'payments',COALESCE((SELECT jsonb_agg(p) FROM payments p),'[]'::jsonb),
'milestones',COALESCE((SELECT jsonb_agg(m) FROM milestones m),'[]'::jsonb))::jsonb AS payload;
