-- name: ListCockpitAssigneeChoices :one
WITH args AS NOT MATERIALIZED (
 SELECT sqlc.arg('workspace_id')::uuid AS ws,sqlc.arg('query')::text AS query,sqlc.arg('kind')::text AS kind,
 sqlc.arg('selected_type')::text AS selected_type,sqlc.narg('selected_id')::uuid AS selected_id,
 sqlc.arg('cursor_key')::text AS cursor_key,sqlc.arg('row_limit')::int AS row_limit
), candidates AS (
 SELECT u.id,'member'::text AS type,u.name AS title,u.email,COALESCE(u.avatar_url,'') AS avatar_url,'active'::text AS status,
 NULL::boolean AS runtime_bound,FALSE AS archived,FALSE AS leader_missing,FALSE AS leader_archived,NULL::jsonb AS permission_agent,'0:'||u.id::text AS sort_key
 FROM member m JOIN "user" u ON u.id=m.user_id CROSS JOIN args x WHERE m.workspace_id=x.ws
 AND (x.selected_id IS NULL AND x.kind IN ('all','member') OR x.selected_type='member' AND u.id=x.selected_id)
 UNION ALL
 SELECT a.id,'agent',a.name,'',COALESCE(a.avatar_url,''),CASE WHEN a.archived_at IS NOT NULL THEN 'archived' ELSE a.status END,
 (r.id IS NOT NULL),a.archived_at IS NOT NULL,FALSE,FALSE,
 jsonb_build_object('id',a.id,'workspace_id',a.workspace_id,'owner_id',a.owner_id,'permission_mode',a.permission_mode,'status',a.status),'1:'||a.id::text
 FROM agent a CROSS JOIN args x LEFT JOIN agent_runtime r ON r.id=a.runtime_id AND r.workspace_id=x.ws
 WHERE a.workspace_id=x.ws AND a.kind='user'
 AND (x.selected_id IS NULL AND x.kind IN ('all','agent') AND a.archived_at IS NULL OR x.selected_type='agent' AND a.id=x.selected_id)
 UNION ALL
 SELECT s.id,'squad',s.name,'',COALESCE(s.avatar_url,''),CASE WHEN s.archived_at IS NOT NULL THEN 'archived' ELSE 'active' END,
 (r.id IS NOT NULL),s.archived_at IS NOT NULL,(a.id IS NULL OR a.kind<>'user'),COALESCE(a.archived_at IS NOT NULL,FALSE),
 CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object('id',a.id,'workspace_id',a.workspace_id,'owner_id',a.owner_id,'permission_mode',a.permission_mode,'status',a.status) END,'2:'||s.id::text
 FROM squad s CROSS JOIN args x LEFT JOIN agent a ON a.id=s.leader_id AND a.workspace_id=x.ws
 LEFT JOIN agent_runtime r ON r.id=a.runtime_id AND r.workspace_id=x.ws
 WHERE s.workspace_id=x.ws AND (x.selected_id IS NULL AND x.kind IN ('all','squad') AND s.archived_at IS NULL OR x.selected_type='squad' AND s.id=x.selected_id)
), filtered AS MATERIALIZED (
 SELECT c.* FROM candidates c CROSS JOIN args x WHERE x.query='' OR strpos(lower(c.title),lower(x.query))>0 OR strpos(lower(c.email),lower(x.query))>0
), page AS (
 SELECT f.* FROM filtered f,args x WHERE x.cursor_key='' OR f.sort_key>x.cursor_key ORDER BY f.sort_key LIMIT (SELECT row_limit FROM args)
)
SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(p ORDER BY p.sort_key) FROM page p),'[]'::jsonb),'total',(SELECT count(*) FROM filtered))::jsonb AS payload;
