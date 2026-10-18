-- name: ListCockpitScopedChanges :one
WITH RECURSIVE args AS NOT MATERIALIZED (
 SELECT sqlc.arg('workspace_id')::uuid AS ws,sqlc.narg('project_id')::uuid AS project,sqlc.narg('module_id')::uuid AS module,
 sqlc.arg('query')::text AS query,sqlc.arg('status')::text AS status
), tree AS (
 SELECT n.id,n.project_id AS project,n.module_id AS module,ARRAY[n.id] AS path,TRUE AS valid
 FROM cockpit_node n,args x WHERE n.workspace_id=x.ws AND n.parent_id IS NULL
 UNION ALL
 SELECT n.id,COALESCE(n.project_id,t.project),COALESCE(n.module_id,t.module),t.path||n.id,
 t.valid AND (n.project_id IS NULL OR t.project IS NULL OR n.project_id=t.project)
 AND (n.module_id IS NULL OR (t.module IS NULL AND n.project_id IS NOT NULL))
 FROM cockpit_node n JOIN tree t ON n.parent_id=t.id CROSS JOIN args x WHERE n.workspace_id=x.ws AND NOT n.id=ANY(t.path)
), scoped AS MATERIALIZED (
 SELECT c.*,COALESCE(n.code,'') AS node_code,COALESCE(n.name,'') AS node_name,(c.status='pending')::int AS cursor_priority,
 st.issue_id AS source_issue_id,si.number AS source_issue_number,si.title AS source_issue_title
 FROM cockpit_pending_change c CROSS JOIN args x LEFT JOIN cockpit_node n ON n.id=c.node_id AND n.workspace_id=x.ws
 LEFT JOIN agent_task_queue st ON st.id=c.source_task_id
 LEFT JOIN issue si ON si.id=st.issue_id
 LEFT JOIN tree t ON t.id=n.id
 WHERE c.workspace_id=x.ws AND c.cockpit_id=(SELECT id FROM cockpit WHERE workspace_id=x.ws)
 AND (x.project IS NULL OR t.valid AND t.project=x.project)
 AND (x.module IS NULL OR t.valid AND t.module=x.module AND EXISTS(SELECT 1 FROM module m WHERE m.workspace_id=x.ws AND m.id=t.module AND m.project_id=t.project))
 AND (x.query='' OR strpos(lower(concat_ws(' ',n.code,n.name,c.field,c.old_value,c.new_value,c.reason,c.created_by_label)),lower(x.query))>0)
), filtered AS MATERIALIZED (
 SELECT c.* FROM scoped c,args x WHERE x.status='all' OR c.status=x.status OR x.status='decided' AND c.status<>'pending'
), page AS (
 SELECT c.* FROM filtered c WHERE sqlc.narg('cursor_id')::uuid IS NULL
 OR (c.cursor_priority,c.created_at,c.id)<(sqlc.arg('cursor_priority')::int,sqlc.narg('cursor_time')::timestamptz,sqlc.narg('cursor_id')::uuid)
 ORDER BY c.cursor_priority DESC,c.created_at DESC,c.id DESC LIMIT sqlc.arg('page_size')::int+1
)
SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(p ORDER BY p.cursor_priority DESC,p.created_at DESC,p.id DESC) FROM page p),'[]'::jsonb),
 'total',(SELECT count(*) FROM filtered),'counts',jsonb_build_object('pending',(SELECT count(*) FROM scoped WHERE status='pending'),'decided',(SELECT count(*) FROM scoped WHERE status<>'pending')))::jsonb AS payload;

-- name: ListCockpitSnapshotPage :one
WITH filtered AS MATERIALIZED (
 SELECT id,trigger_kind,label,node_count,created_by_type,created_by_label,created_at FROM cockpit_snapshot
 WHERE workspace_id=sqlc.arg('workspace_id')::uuid
 AND cockpit_id=(SELECT id FROM cockpit WHERE workspace_id=sqlc.arg('workspace_id')::uuid)
 AND (sqlc.arg('query')::text='' OR strpos(lower(concat_ws(' ',label,created_by_label)),lower(sqlc.arg('query')::text))>0)
), page AS (
 SELECT s.* FROM filtered s WHERE sqlc.narg('cursor_id')::uuid IS NULL OR (s.created_at,s.id)<(sqlc.narg('cursor_time')::timestamptz,sqlc.narg('cursor_id')::uuid)
 ORDER BY s.created_at DESC,s.id DESC LIMIT sqlc.arg('page_size')::int+1
)
SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(p ORDER BY p.created_at DESC,p.id DESC) FROM page p),'[]'::jsonb),'total',(SELECT count(*) FROM filtered))::jsonb AS payload;
