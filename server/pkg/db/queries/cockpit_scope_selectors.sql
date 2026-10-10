-- name: ListCockpitScopeNodes :one
-- Resolve stable bindings once for the workspace; only one bounded metadata page leaves SQL.
WITH RECURSIVE args AS (
 SELECT sqlc.arg(workspace_id)::uuid AS ws,sqlc.narg(project_id)::uuid AS project,sqlc.narg(module_id)::uuid AS module,
 sqlc.arg(query)::text AS query,sqlc.arg(eligible_only)::bool AS eligible_only,
 sqlc.arg(cursor_key)::text AS cursor_key,sqlc.arg(row_limit)::int AS row_limit
), tree AS (
 SELECT n.id,n.cockpit_id,n.parent_id,n.project_id AS project,n.module_id AS module,ARRAY[n.id] AS path,
 (n.project_id IS NULL OR EXISTS(SELECT 1 FROM project p WHERE p.id=n.project_id AND p.workspace_id=x.ws))
 AND (n.module_id IS NULL OR EXISTS(SELECT 1 FROM module m WHERE m.id=n.module_id AND m.workspace_id=x.ws AND m.project_id=n.project_id)) AS valid
 FROM cockpit_node n CROSS JOIN args x WHERE n.workspace_id=x.ws AND n.parent_id IS NULL
 UNION ALL
 SELECT n.id,n.cockpit_id,n.parent_id,COALESCE(n.project_id,t.project),COALESCE(n.module_id,t.module),t.path||n.id,
 t.valid AND (n.project_id IS NULL OR t.project IS NULL OR n.project_id=t.project)
 AND (n.module_id IS NULL OR (t.module IS NULL AND n.project_id IS NOT NULL))
 AND (n.project_id IS NULL OR EXISTS(SELECT 1 FROM project p WHERE p.id=n.project_id AND p.workspace_id=x.ws))
 AND (n.module_id IS NULL OR EXISTS(SELECT 1 FROM module m WHERE m.id=n.module_id AND m.workspace_id=x.ws AND m.project_id=n.project_id))
 FROM cockpit_node n JOIN tree t ON n.parent_id=t.id AND n.cockpit_id=t.cockpit_id CROSS JOIN args x
 WHERE n.workspace_id=x.ws AND NOT n.id=ANY(t.path)
), facts AS (
 SELECT n.id,n.name AS title,n.code,t.project AS project_id,t.module AS module_id,
 CASE WHEN n.project_id IS NOT NULL OR n.module_id IS NOT NULL THEN 'structural_node'
 WHEN EXISTS(SELECT 1 FROM cockpit_node child WHERE child.parent_id=n.id AND child.workspace_id=x.ws) THEN 'not_leaf'
 WHEN t.id IS NULL THEN 'invalid_ancestry'
 WHEN NOT t.valid THEN 'binding_conflict'
 WHEN t.project IS NULL OR t.module IS NULL THEN 'module_binding_required'
 ELSE '' END AS reason
 FROM cockpit_node n CROSS JOIN args x LEFT JOIN tree t ON t.id=n.id
 WHERE n.workspace_id=x.ws
 AND (x.project IS NULL OR t.valid AND t.project=x.project)
 AND (x.module IS NULL OR t.valid AND t.module=x.module)
), candidates AS MATERIALIZED (
 SELECT f.id,f.title,f.project_id,f.module_id,f.code,(f.reason='') AS eligible,f.reason
 FROM facts f CROSS JOIN args x WHERE NOT x.eligible_only OR f.reason=''
), filtered AS MATERIALIZED (
 SELECT c.* FROM candidates c CROSS JOIN args x
 WHERE x.query='' OR c.id::text=lower(x.query) OR strpos(lower(c.title),lower(x.query))>0 OR strpos(lower(c.code),lower(x.query))>0
), page AS (
 SELECT f.* FROM filtered f CROSS JOIN args x WHERE x.cursor_key='' OR f.id::text>x.cursor_key
 ORDER BY f.id LIMIT (SELECT row_limit FROM args)
)
SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(p ORDER BY p.id) FROM page p),'[]'::jsonb),
 'total',(SELECT count(*) FROM candidates),'filtered_total',(SELECT count(*) FROM filtered))::jsonb AS payload;

-- name: ListCockpitScopeMembers :one
WITH args AS (
 SELECT sqlc.arg(workspace_id)::uuid AS ws,sqlc.arg(query)::text AS query,COALESCE(sqlc.arg(user_ids)::uuid[],'{}'::uuid[]) AS ids,
 sqlc.arg(cursor_key)::text AS cursor_key,sqlc.arg(row_limit)::int AS row_limit
), candidates AS MATERIALIZED (
 SELECT u.id,u.name AS title,COALESCE(u.avatar_url,'') AS avatar_url,u.email,m.role
 FROM member m JOIN "user" u ON u.id=m.user_id CROSS JOIN args x
 WHERE m.workspace_id=x.ws AND (cardinality(x.ids)=0 OR u.id=ANY(x.ids))
), filtered AS MATERIALIZED (
 SELECT c.* FROM candidates c CROSS JOIN args x WHERE x.query='' OR strpos(lower(c.title),lower(x.query))>0 OR strpos(lower(c.email),lower(x.query))>0
), page AS (
 SELECT f.* FROM filtered f CROSS JOIN args x WHERE x.cursor_key='' OR f.id::text>x.cursor_key
 ORDER BY f.id LIMIT (SELECT row_limit FROM args)
)
SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(p ORDER BY p.id) FROM page p),'[]'::jsonb),
 'total',(SELECT count(*) FROM candidates),'filtered_total',(SELECT count(*) FROM filtered))::jsonb AS payload;
