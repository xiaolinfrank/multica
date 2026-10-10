-- name: GetCockpitMeetingCodeSequence :one
-- Only codes participate in sequence allocation; no meeting bodies are loaded.
WITH matching AS (
 SELECT substring(btrim(code) FROM 10) AS suffix FROM cockpit_meeting
 WHERE workspace_id=sqlc.arg('workspace_id')::uuid
 AND btrim(code) ~ ('^'||to_char(sqlc.arg('date')::date,'YYYYMMDD')||'-[0-9]{2,}$')
)
SELECT COALESCE(max(CASE WHEN length(suffix)<=18 THEN suffix::bigint END),0)::bigint AS maximum,
 COALESCE(bool_or(length(suffix)>18),FALSE)::bool AS unsupported FROM matching;

-- name: CockpitMeetingDirectoryRecorded :one
SELECT EXISTS(SELECT 1 FROM cockpit_meeting WHERE workspace_id=sqlc.arg('workspace_id')::uuid AND nas_dir=sqlc.arg('nas_dir')::text)::bool;

-- name: GetCockpitPlanMeetingMarkers :one
-- Aggregate every matching meeting for visible rows; preview metadata is capped
-- separately. A meeting linked to several descendants counts once per row/day.
WITH RECURSIVE args AS NOT MATERIALIZED (
 SELECT sqlc.arg('workspace_id')::uuid AS ws,sqlc.narg('project_id')::uuid AS project,sqlc.narg('module_id')::uuid AS module,
 sqlc.arg('node_ids')::uuid[] AS node_ids,sqlc.arg('rows')::jsonb AS row_defs,sqlc.arg('date_from')::date AS date_from,sqlc.arg('date_to')::date AS date_to,sqlc.arg('cursor_key')::text AS cursor_key
), requested_rows AS MATERIALIZED (
 SELECT value->>'row_key' AS row_key,ARRAY(SELECT jsonb_array_elements_text(value->'node_ids'))::uuid[] AS node_ids
 FROM args x,jsonb_array_elements(x.row_defs) AS entry(value)
), tree AS (
 SELECT n.id,n.project_id AS project,n.module_id AS module,ARRAY[n.id] AS path,TRUE AS valid FROM cockpit_node n,args x WHERE n.workspace_id=x.ws AND n.parent_id IS NULL
 UNION ALL
 SELECT n.id,COALESCE(n.project_id,t.project),COALESCE(n.module_id,t.module),t.path||n.id,
 t.valid AND (n.project_id IS NULL OR t.project IS NULL OR n.project_id=t.project)
 AND (n.module_id IS NULL OR (t.module IS NULL AND n.project_id IS NOT NULL))
 FROM cockpit_node n JOIN tree t ON t.id=n.parent_id CROSS JOIN args x WHERE n.workspace_id=x.ws AND NOT n.id=ANY(t.path)
), scoped AS MATERIALIZED (
 SELECT n.id,COALESCE(t.path,ARRAY[n.id]) AS path FROM cockpit_node n CROSS JOIN args x LEFT JOIN tree t ON t.id=n.id
 WHERE n.workspace_id=x.ws AND (x.project IS NULL OR t.valid AND t.project=x.project)
 AND (x.module IS NULL OR t.valid AND t.module=x.module)
), matched_nodes AS MATERIALIZED (
 -- Resolve the at-most-100 visible row groups against the tree once. Keeping
 -- this outside the meeting join prevents a generic date estimate from
 -- rescanning the recursive tree and JSON groups for each meeting link.
 SELECT wanted.row_key,n.id AS node_id FROM scoped n JOIN requested_rows wanted ON wanted.node_ids && n.path
), dated_meetings AS MATERIALIZED (
 SELECT m.id,m.meet_date,m.title,m.code,m.start_time FROM cockpit_meeting m,args x
 WHERE m.workspace_id=x.ws AND m.meet_date>=x.date_from AND m.meet_date<=x.date_to
), meeting_node_links AS NOT MATERIALIZED (
 SELECT l.workspace_id,l.meeting_id,l.node_id FROM cockpit_meeting_node l,args x WHERE l.workspace_id=x.ws
 UNION SELECT a.workspace_id,a.meeting_id,a.node_id FROM cockpit_meeting_agenda a,args x WHERE a.workspace_id=x.ws AND a.removed_at IS NULL AND a.node_id IS NOT NULL
), facts AS MATERIALIZED (
 SELECT DISTINCT wanted.row_key,m.id,m.meet_date,m.title,m.code,m.start_time
 FROM matched_nodes wanted CROSS JOIN args x JOIN meeting_node_links l ON l.workspace_id=x.ws AND l.node_id=wanted.node_id
 JOIN dated_meetings m ON m.id=l.meeting_id
), groups AS (
 SELECT f.row_key,f.meet_date AS date,count(*) AS total,f.row_key||'|'||f.meet_date::text AS sort_key FROM facts f GROUP BY f.row_key,f.meet_date
), page AS (
 SELECT g.* FROM groups g,args x WHERE x.cursor_key='' OR g.sort_key>x.cursor_key ORDER BY g.sort_key LIMIT 501
), ranked_previews AS (
 SELECT f.*,row_number() OVER(PARTITION BY f.row_key,f.meet_date ORDER BY f.start_time NULLS LAST,f.id) AS preview_rank
 FROM facts f JOIN page p ON p.row_key=f.row_key AND p.date=f.meet_date
), previews AS MATERIALIZED (
 -- Do not inline this aggregate into each page row: a generic plan can
 -- estimate one group and otherwise repeat the entire windowed preview.
 SELECT f.row_key,f.meet_date,jsonb_agg(jsonb_build_object('id',f.id,'title',f.title,'code',f.code,'start_time',to_char(f.start_time,'HH24:MI'))
 ORDER BY f.start_time NULLS LAST,f.id) AS items FROM ranked_previews f WHERE f.preview_rank<=5 GROUP BY f.row_key,f.meet_date
), cards AS (
 SELECT p.*,COALESCE(v.items,'[]'::jsonb) AS items FROM page p LEFT JOIN previews v ON v.row_key=p.row_key AND v.meet_date=p.date
)
SELECT jsonb_build_object('groups',COALESCE((SELECT jsonb_agg(c ORDER BY c.sort_key) FROM cards c),'[]'::jsonb),
 'total_groups',(SELECT count(*) FROM groups),
 'requested_nodes',(SELECT count(*) FROM cockpit_node n,args x WHERE n.workspace_id=x.ws AND n.id=ANY(x.node_ids)))::jsonb AS payload;
