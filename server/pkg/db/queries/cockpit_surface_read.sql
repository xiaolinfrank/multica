-- name: GetCockpitPlanSurface :one
-- Counts and bounded payloads share one snapshot. Context ancestors retain their
-- identity but do not contribute their own payments to a narrower scope.
WITH RECURSIVE args AS NOT MATERIALIZED (
 SELECT sqlc.arg('workspace_id')::uuid AS ws, sqlc.narg('project_id')::uuid AS project, sqlc.narg('module_id')::uuid AS module
), tree AS (
 SELECT n.id,n.parent_id,n.project_id AS project,n.module_id AS module,ARRAY[n.id] AS path,TRUE AS valid
 FROM cockpit_node n,args x WHERE n.workspace_id=x.ws AND n.parent_id IS NULL
 UNION ALL
 SELECT n.id,n.parent_id,COALESCE(n.project_id,t.project),COALESCE(n.module_id,t.module),t.path||n.id,
 t.valid AND (n.project_id IS NULL OR t.project IS NULL OR n.project_id=t.project)
 AND (n.module_id IS NULL OR (t.module IS NULL AND n.project_id IS NOT NULL))
 FROM cockpit_node n JOIN tree t ON n.parent_id=t.id CROSS JOIN args x
 WHERE n.workspace_id=x.ws AND NOT n.id=ANY(t.path)
), scoped AS MATERIALIZED (
 SELECT n.id,COALESCE(t.path,ARRAY[n.id]) AS path FROM cockpit_node n CROSS JOIN args x LEFT JOIN tree t ON t.id=n.id
 WHERE n.workspace_id=x.ws AND (x.project IS NULL OR t.valid AND t.project=x.project
 AND EXISTS(SELECT 1 FROM project p WHERE p.workspace_id=x.ws AND p.id=t.project))
 AND (x.module IS NULL OR t.valid AND t.module=x.module
 AND EXISTS(SELECT 1 FROM module m WHERE m.workspace_id=x.ws AND m.id=t.module AND m.project_id=t.project))
), visible AS MATERIALIZED (
 SELECT DISTINCT unnest(path) AS id FROM scoped
), bounded_nodes AS (
 SELECT n.* FROM cockpit_node n JOIN visible v ON v.id=n.id CROSS JOIN args x WHERE n.workspace_id=x.ws ORDER BY n.position,n.id LIMIT 5001
), bounded_payments AS (
 SELECT p.* FROM cockpit_payment p JOIN scoped n ON n.id=p.node_id CROSS JOIN args x WHERE p.workspace_id=x.ws ORDER BY p.position,p.id LIMIT 25001
), bounded_milestones AS (
 SELECT m.* FROM cockpit_milestone m CROSS JOIN args x WHERE m.workspace_id=x.ws
 AND (x.project IS NULL AND x.module IS NULL OR EXISTS(SELECT 1 FROM scoped n WHERE n.id=m.node_id)) ORDER BY m.position,m.id LIMIT 2001
), node_index AS (
 SELECT n.id,n.parent_id,n.code,n.position FROM cockpit_node n,args x WHERE n.workspace_id=x.ws ORDER BY n.position,n.id LIMIT 20001
), primary_counts AS MATERIALIZED (
 SELECT p.node_id,count(*) AS primary_total,
 count(*) FILTER(WHERE cockpit_issue_category(i.status,st.category) NOT IN ('done','closed')) AS active,
 count(*) FILTER(WHERE cockpit_issue_category(i.status,st.category)='done') AS done,
 count(*) FILTER(WHERE cockpit_issue_category(i.status,st.category)='closed') AS closed
 FROM cockpit_issue_primary p JOIN scoped n ON n.id=p.node_id CROSS JOIN args x
 JOIN issue i ON i.id=p.issue_id AND i.workspace_id=x.ws LEFT JOIN issue_status st ON st.workspace_id=x.ws AND st.key=i.status
 WHERE p.workspace_id=x.ws AND p.issue_deleted_at IS NULL GROUP BY p.node_id
), reference_counts AS MATERIALIZED (
 SELECT l.node_id,count(*) AS reference_total FROM cockpit_node_issue l JOIN scoped n ON n.id=l.node_id CROSS JOIN args x
 JOIN issue i ON i.id=l.issue_id AND i.workspace_id=x.ws
 WHERE l.workspace_id=x.ws AND NOT EXISTS(SELECT 1 FROM cockpit_issue_primary p WHERE p.workspace_id=x.ws AND p.issue_id=l.issue_id AND p.node_id=l.node_id AND p.issue_deleted_at IS NULL)
 GROUP BY l.node_id
), task_counts AS (
 SELECT n.id AS node_id,COALESCE(p.primary_total,0) AS primary_total,COALESCE(r.reference_total,0) AS reference_total,
 COALESCE(p.active,0) AS active,COALESCE(p.done,0) AS done,COALESCE(p.closed,0) AS closed
 FROM bounded_nodes n LEFT JOIN primary_counts p ON p.node_id=n.id LEFT JOIN reference_counts r ON r.node_id=n.id
 WHERE EXISTS(SELECT 1 FROM scoped s WHERE s.id=n.id)
)
SELECT jsonb_build_object(
 'complete',TRUE,
 'nodes',COALESCE((SELECT jsonb_agg(n ORDER BY n.position,n.id) FROM bounded_nodes n),'[]'::jsonb),
 'payments',COALESCE((SELECT jsonb_agg(p ORDER BY p.position,p.id) FROM bounded_payments p),'[]'::jsonb),
 'milestones',COALESCE((SELECT jsonb_agg(m ORDER BY m.position,m.id) FROM bounded_milestones m),'[]'::jsonb),
 'node_index',COALESCE((SELECT jsonb_agg(n ORDER BY n.position,n.id) FROM node_index n),'[]'::jsonb),
 'context_node_ids',COALESCE((SELECT jsonb_agg(n.id) FROM bounded_nodes n WHERE NOT EXISTS(SELECT 1 FROM scoped s WHERE s.id=n.id)),'[]'::jsonb),
 'task_counts',COALESCE((SELECT jsonb_agg(t) FROM task_counts t),'[]'::jsonb),
 'counts',jsonb_build_object('nodes',(SELECT count(*) FROM visible),
   'payments',(SELECT count(*) FROM cockpit_payment p,args x WHERE p.workspace_id=x.ws AND EXISTS(SELECT 1 FROM scoped n WHERE n.id=p.node_id)),
   'milestones',(SELECT count(*) FROM cockpit_milestone m,args x WHERE m.workspace_id=x.ws AND (x.project IS NULL AND x.module IS NULL OR EXISTS(SELECT 1 FROM scoped n WHERE n.id=m.node_id))),
   'index_nodes',(SELECT count(*) FROM cockpit_node n,args x WHERE n.workspace_id=x.ws))
)::jsonb AS payload;

-- name: ListCockpitScopeChoices :one
WITH choices AS (
 SELECT p.id,p.title,NULL::uuid AS project_id FROM project p
 WHERE p.workspace_id=sqlc.arg('workspace_id')::uuid AND sqlc.arg('kind')::text='projects'
 AND (sqlc.arg('query')::text='' OR strpos(lower(p.title),lower(sqlc.arg('query')::text))>0)
 UNION ALL
 SELECT m.id,m.title,m.project_id FROM module m
 WHERE m.workspace_id=sqlc.arg('workspace_id')::uuid AND sqlc.arg('kind')::text='modules' AND m.project_id=sqlc.narg('project_id')::uuid
 AND (sqlc.arg('query')::text='' OR strpos(lower(m.title),lower(sqlc.arg('query')::text))>0)
), page AS (
 SELECT * FROM choices WHERE sqlc.arg('cursor_key')::text='' OR id::text>sqlc.arg('cursor_key')::text ORDER BY id LIMIT 21
)
SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(p ORDER BY p.id) FROM page p),'[]'::jsonb),'total',(SELECT count(*) FROM choices))::jsonb AS payload;

-- name: ListCockpitMeetingRegister :one
-- Search sees full source text; list rows return metadata and a short excerpt.
-- Calendar counts deliberately precede pagination.
WITH RECURSIVE args AS NOT MATERIALIZED (
 SELECT sqlc.arg('workspace_id')::uuid AS ws,sqlc.narg('project_id')::uuid AS project,sqlc.narg('module_id')::uuid AS module,
 COALESCE(sqlc.arg('node_ids')::uuid[],'{}'::uuid[]) AS node_ids,sqlc.arg('words')::text[] AS words,
 sqlc.arg('tracks')::text[] AS tracks,sqlc.arg('kinds')::text[] AS kinds,sqlc.arg('statuses')::text[] AS statuses,
 sqlc.arg('parties')::text[] AS parties,sqlc.arg('only_flags')::text[] AS only_flags,sqlc.arg('workflow_stage')::text AS stage,
 sqlc.narg('date_from')::date AS date_from,sqlc.narg('date_to')::date AS date_to,
 sqlc.arg('calendar_counts')::bool AS calendar_counts,sqlc.arg('cursor_key')::text AS cursor_key,sqlc.arg('page_size')::int AS page_size
), tree AS (
 SELECT n.id,n.project_id AS project,n.module_id AS module,ARRAY[n.id] AS path,TRUE AS valid
 FROM cockpit_node n,args x WHERE n.workspace_id=x.ws AND n.parent_id IS NULL
 UNION ALL
 SELECT n.id,COALESCE(n.project_id,t.project),COALESCE(n.module_id,t.module),t.path||n.id,
 t.valid AND (n.project_id IS NULL OR t.project IS NULL OR n.project_id=t.project)
 AND (n.module_id IS NULL OR (t.module IS NULL AND n.project_id IS NOT NULL))
 FROM cockpit_node n JOIN tree t ON n.parent_id=t.id CROSS JOIN args x WHERE n.workspace_id=x.ws AND NOT n.id=ANY(t.path)
), meeting_node_links AS NOT MATERIALIZED (
 SELECT l.workspace_id,l.meeting_id,l.node_id FROM cockpit_meeting_node l,args x WHERE l.workspace_id=x.ws
 UNION SELECT a.workspace_id,a.meeting_id,a.node_id FROM cockpit_meeting_agenda a,args x WHERE a.workspace_id=x.ws AND a.removed_at IS NULL AND a.node_id IS NOT NULL
), meeting_issue_links AS NOT MATERIALIZED (
 SELECT l.workspace_id,l.meeting_id,l.issue_id FROM cockpit_meeting_issue l,args x WHERE l.workspace_id=x.ws
 UNION SELECT r.workspace_id,r.meeting_id,r.target_id FROM cockpit_meeting_agenda_reference r JOIN cockpit_meeting_agenda a ON a.workspace_id=r.workspace_id AND a.id=r.agenda_id CROSS JOIN args x
 WHERE r.workspace_id=x.ws AND r.kind='issue' AND r.removed_at IS NULL AND a.removed_at IS NULL
), node_meetings AS MATERIALIZED (
 SELECT DISTINCT l.meeting_id FROM meeting_node_links l CROSS JOIN args x LEFT JOIN tree t ON t.id=l.node_id
 WHERE cardinality(x.node_ids)>0 AND l.workspace_id=x.ws AND (l.node_id=ANY(x.node_ids) OR t.path && x.node_ids)
), scope_meetings AS MATERIALIZED (
 SELECT l.meeting_id FROM meeting_node_links l CROSS JOIN args x JOIN tree t ON t.id=l.node_id
 WHERE (x.project IS NOT NULL OR x.module IS NOT NULL) AND l.workspace_id=x.ws AND t.valid
 AND (x.project IS NULL OR t.project=x.project) AND (x.module IS NULL OR t.module=x.module)
 UNION
 SELECT l.meeting_id FROM meeting_issue_links l CROSS JOIN args x JOIN issue i ON i.workspace_id=x.ws AND i.id=l.issue_id
 WHERE (x.project IS NOT NULL OR x.module IS NOT NULL) AND l.workspace_id=x.ws
 AND (x.project IS NULL OR i.project_id=x.project) AND (x.module IS NULL OR i.module_id=x.module)
 UNION
 SELECT w.meeting_id FROM cockpit_meeting_work_package w CROSS JOIN args x JOIN issue i ON i.workspace_id=x.ws AND i.id=w.minutes_issue_id
 WHERE (x.project IS NOT NULL OR x.module IS NOT NULL) AND w.workspace_id=x.ws
 AND (x.project IS NULL OR i.project_id=x.project) AND (x.module IS NULL OR i.module_id=x.module)
 UNION
 SELECT a.meeting_id FROM cockpit_meeting_action a CROSS JOIN args x JOIN issue i ON i.workspace_id=x.ws AND i.id=a.issue_id
 WHERE (x.project IS NOT NULL OR x.module IS NOT NULL) AND a.workspace_id=x.ws AND a.status='accepted'
 AND (x.project IS NULL OR i.project_id=x.project) AND (x.module IS NULL OR i.module_id=x.module)
), party_chars AS (
 SELECT m.id,m.parties,0 AS pos,0 AS depth,0 AS segment,''::text AS ch
 FROM cockpit_meeting m,args x WHERE m.workspace_id=x.ws AND cardinality(x.parties)>0
 UNION ALL
 SELECT c.id,c.parties,c.pos+1,
 CASE WHEN strpos('（(【[〔《',substring(c.parties FROM c.pos+1 FOR 1))>0 THEN c.depth+1
  WHEN strpos('）)】]〕》',substring(c.parties FROM c.pos+1 FOR 1))>0 THEN greatest(c.depth-1,0) ELSE c.depth END,
 CASE WHEN c.depth=0 AND strpos('、,，;；/|×x',substring(c.parties FROM c.pos+1 FOR 1))>0 THEN c.segment+1 ELSE c.segment END,
 CASE WHEN c.depth=0 AND strpos('、,，;；/|×x',substring(c.parties FROM c.pos+1 FOR 1))>0 THEN '' ELSE substring(c.parties FROM c.pos+1 FOR 1) END
 FROM party_chars c WHERE c.pos<char_length(c.parties)
), party_tokens AS (
 SELECT id,btrim(string_agg(ch,'' ORDER BY pos)) AS value FROM party_chars GROUP BY id,segment
), workflow_facts AS MATERIALIZED (
 SELECT w.meeting_id,
 CASE WHEN w.released_at IS NULL THEN CASE WHEN m.ended_at IS NULL THEN 'waiting_meeting' WHEN w.materials_ready AND i.status='backlog' THEN 'release_ready' WHEN w.materials_ready THEN 'restore_backlog' ELSE 'materials_needed' END
 WHEN v.decision='pending' THEN CASE WHEN EXISTS(SELECT 1 FROM member u WHERE u.workspace_id=w.workspace_id AND u.user_id=v.reviewer_id) THEN 'review_pending' ELSE 'reviewer_missing' END
 WHEN v.decision='approved' AND v.published_at IS NULL THEN 'publish_ready'
 WHEN v.published_at IS NOT NULL AND w.published_version_id=v.id THEN 'published'
 WHEN NOT EXISTS(SELECT 1 FROM member u WHERE u.workspace_id=w.workspace_id AND u.user_id=w.reviewer_id) THEN 'reviewer_missing'
 WHEN v.decision IN ('changes_requested','rejected') THEN 'minutes_rework' ELSE 'minutes_needed' END AS workflow_stage
 FROM cockpit_meeting_work_package w CROSS JOIN args x
 JOIN cockpit_meeting m ON m.workspace_id=w.workspace_id AND m.id=w.meeting_id
 LEFT JOIN issue i ON i.workspace_id=w.workspace_id AND i.id=w.minutes_issue_id
 LEFT JOIN cockpit_minutes_version v ON v.workspace_id=w.workspace_id AND v.meeting_id=w.meeting_id AND v.id=w.current_version_id
 WHERE w.workspace_id=x.ws
), candidates AS (
 SELECT m.id,m.meet_date,
 (wf.meeting_id IS NOT NULL)::bool AS workflow_enabled,
 COALESCE(wf.workflow_stage,'not_enabled') AS workflow_stage
 FROM cockpit_meeting m CROSS JOIN args x
 LEFT JOIN workflow_facts wf ON wf.meeting_id=m.id
 WHERE m.workspace_id=x.ws
 AND (cardinality(x.node_ids)=0 OR m.id IN (SELECT meeting_id FROM node_meetings))
 AND (x.project IS NULL AND x.module IS NULL OR m.id IN (SELECT meeting_id FROM scope_meetings))
 AND (x.date_from IS NULL OR m.meet_date>=x.date_from) AND (x.date_to IS NULL OR m.meet_date<=x.date_to)
 AND (cardinality(x.tracks)=0 OR btrim(m.track)=ANY(x.tracks))
 AND (cardinality(x.kinds)=0 OR m.kind=ANY(x.kinds)) AND (cardinality(x.statuses)=0 OR m.status=ANY(x.statuses))
 AND (cardinality(x.words)=0 OR NOT EXISTS(SELECT 1 FROM unnest(x.words) AS word WHERE strpos(lower(concat_ws(' ',m.title,m.code,m.track,m.kind,m.status,m.parties,m.organizer,m.attendees,m.location,m.meet_no,m.note,m.minutes,m.decisions,m.actions)),word)=0))
 AND (NOT 'consensus'=ANY(x.only_flags) OR btrim(m.decisions)<>'' OR btrim(m.actions)<>'')
 AND (NOT 'folder'=ANY(x.only_flags) OR btrim(m.nas_dir)<>'') AND (NOT 'detected'=ANY(x.only_flags) OR m.detected)
 -- Match the UI's bracket-aware party tokenizer, including legacy separators.
 AND (cardinality(x.parties)=0 OR m.id IN (SELECT token.id FROM party_tokens token WHERE token.value=ANY(x.parties)))
 AND (NOT 'links'=ANY(x.only_flags)
 OR EXISTS(SELECT 1 FROM meeting_issue_links l JOIN issue linked ON linked.workspace_id=l.workspace_id AND linked.id=l.issue_id WHERE l.workspace_id=x.ws AND l.meeting_id=m.id)
 OR EXISTS(SELECT 1 FROM meeting_node_links l JOIN cockpit_node linked ON linked.workspace_id=l.workspace_id AND linked.id=l.node_id WHERE l.workspace_id=x.ws AND l.meeting_id=m.id))
), filtered AS MATERIALIZED (
 SELECT c.*,(COALESCE(c.meet_date::text,'0001-01-01')||'|'||c.id::text) AS sort_key
 FROM candidates c,args x WHERE (x.stage='' OR c.workflow_stage=x.stage)
), page AS (
 SELECT f.* FROM filtered f,args x WHERE x.cursor_key='' OR f.sort_key<x.cursor_key ORDER BY f.sort_key DESC LIMIT (SELECT page_size+1 FROM args)
), cards AS (
 SELECT m.id,m.meet_date,m.time_range,to_char(m.start_time,'HH24:MI') AS start_time,to_char(m.end_time,'HH24:MI') AS end_time,
 m.title,m.code,m.kind,m.status,m.occurrence_state,m.ended_at,m.actual_started_at,m.actual_ended_at,m.track,m.parties,m.organizer,m.location,m.attendees,m.meet_no,m.link,m.nas_dir,m.detected,
 (SELECT count(*) FROM meeting_issue_links l JOIN issue linked ON linked.workspace_id=l.workspace_id AND linked.id=l.issue_id WHERE l.workspace_id=x.ws AND l.meeting_id=m.id) AS issue_count,
 (SELECT count(*) FROM meeting_node_links l JOIN cockpit_node linked ON linked.workspace_id=l.workspace_id AND linked.id=l.node_id WHERE l.workspace_id=x.ws AND l.meeting_id=m.id) AS node_count,
 p.workflow_enabled,p.workflow_stage,p.sort_key,
 left(COALESCE(NULLIF(btrim(m.decisions),''),NULLIF(btrim(m.actions),''),NULLIF(btrim(m.minutes),''),NULLIF(btrim(m.note),''),''),200) AS display_excerpt
 FROM page p CROSS JOIN args x JOIN cockpit_meeting m ON m.id=p.id AND m.workspace_id=x.ws
), day_counts AS (
 SELECT f.meet_date AS date,count(*) AS total FROM filtered f,args x WHERE x.calendar_counts GROUP BY f.meet_date
)
SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(c ORDER BY c.sort_key DESC) FROM cards c),'[]'::jsonb),
 'total',(SELECT count(*) FROM filtered),'day_counts',COALESCE((SELECT jsonb_agg(d ORDER BY d.date) FROM day_counts d),'[]'::jsonb))::jsonb AS payload;

-- name: ListCockpitSurfaceAncestors :many
WITH RECURSIVE ancestors AS (
 SELECT n.id,n.parent_id,0 AS depth,ARRAY[n.id] AS path FROM cockpit_node n WHERE n.workspace_id=sqlc.arg('workspace_id')::uuid AND n.id=sqlc.arg('node_id')::uuid
 UNION ALL
 SELECT n.id,n.parent_id,a.depth+1,a.path||n.id FROM cockpit_node n JOIN ancestors a ON a.parent_id=n.id
 WHERE n.workspace_id=sqlc.arg('workspace_id')::uuid AND NOT n.id=ANY(a.path) AND a.depth<128
)
SELECT sqlc.embed(n),a.depth FROM ancestors a JOIN cockpit_node n ON n.id=a.id AND n.workspace_id=sqlc.arg('workspace_id')::uuid ORDER BY a.depth;

-- name: GetCockpitSurfaceNodeIndex :one
SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(n ORDER BY n.position,n.id) FROM (
 SELECT id,parent_id,code,position FROM cockpit_node WHERE workspace_id=sqlc.arg('workspace_id')::uuid ORDER BY position,id LIMIT 20001
) n),'[]'::jsonb),'total',(SELECT count(*) FROM cockpit_node WHERE workspace_id=sqlc.arg('workspace_id')::uuid))::jsonb AS payload;

-- name: CountCockpitSurfaceChildren :one
SELECT count(*) FROM cockpit_node WHERE workspace_id=sqlc.arg('workspace_id')::uuid AND parent_id=sqlc.arg('node_id')::uuid;

-- name: GetCockpitSurfaceObjectPage :one
-- Only one source branch executes for a requested relation kind.
WITH args AS (
 SELECT sqlc.arg('workspace_id')::uuid AS ws,sqlc.arg('object_id')::uuid AS object_id,sqlc.arg('kind')::text AS kind,
 sqlc.narg('cursor_id')::uuid AS cursor_id,sqlc.arg('cursor_position')::double precision AS cursor_position,sqlc.arg('page_size')::int AS page_size
), agenda_refs AS MATERIALIZED (
 SELECT r.target_id AS issue_id,min(r.agenda_id::text)::uuid AS agenda_id,count(DISTINCT r.agenda_id)::bigint AS agenda_total
 FROM cockpit_meeting_agenda_reference r JOIN cockpit_meeting_agenda a ON a.workspace_id=r.workspace_id AND a.meeting_id=r.meeting_id AND a.id=r.agenda_id CROSS JOIN args x
 WHERE x.kind='meeting_issues' AND r.workspace_id=x.ws AND r.meeting_id=x.object_id AND r.kind='issue' AND r.removed_at IS NULL AND a.removed_at IS NULL GROUP BY r.target_id
), meeting_issue_ids AS (
 SELECT l.issue_id FROM cockpit_meeting_issue l,args x WHERE x.kind='meeting_issues' AND l.workspace_id=x.ws AND l.meeting_id=x.object_id
 UNION SELECT issue_id FROM agenda_refs
), source AS (
 SELECT p.id,p.position,p.amount AS amount,to_jsonb(p) AS item FROM cockpit_payment p,args x
 WHERE x.kind='payments' AND p.workspace_id=x.ws AND p.node_id=x.object_id
 UNION ALL
 SELECT mi.issue_id,COALESCE(l.position,0)::double precision,0::numeric,jsonb_build_object('meeting_id',x.object_id,'issue_id',mi.issue_id,'position',COALESCE(l.position,0),
 'role',COALESCE(l.role,''),'roles',COALESCE(l.roles,ARRAY['preparation']::text[]),'has_direct_reference',l.issue_id IS NOT NULL,'has_agenda_reference',ar.issue_id IS NOT NULL,'agenda_id',ar.agenda_id,'agenda_total',COALESCE(ar.agenda_total,0),'issue_number',i.number,'issue_identifier',ws.issue_prefix||'-'||i.number::text,'issue_title',i.title,'issue_status',i.status,
 'required_roles',array_remove(ARRAY[
 CASE WHEN EXISTS(SELECT 1 FROM cockpit_meeting_work_package w WHERE w.workspace_id=x.ws AND w.meeting_id=x.object_id AND w.minutes_issue_id=mi.issue_id) THEN 'minutes' END,
 CASE WHEN EXISTS(SELECT 1 FROM cockpit_minutes_version v WHERE v.workspace_id=x.ws AND v.meeting_id=x.object_id AND v.review_issue_id=mi.issue_id)
 OR EXISTS(SELECT 1 FROM cockpit_reviewer_handoff h WHERE h.workspace_id=x.ws AND h.meeting_id=x.object_id AND (h.from_review_issue_id=mi.issue_id OR h.to_review_issue_id=mi.issue_id)) THEN 'review' END
 ]::text[],NULL)::text[])
 FROM meeting_issue_ids mi CROSS JOIN args x JOIN issue i ON i.workspace_id=x.ws AND i.id=mi.issue_id JOIN workspace ws ON ws.id=x.ws
 LEFT JOIN cockpit_meeting_issue l ON l.workspace_id=x.ws AND l.meeting_id=x.object_id AND l.issue_id=mi.issue_id
 LEFT JOIN agenda_refs ar ON ar.issue_id=mi.issue_id
 WHERE x.kind='meeting_issues'
 UNION ALL
 SELECT l.node_id,l.position,0::numeric,jsonb_build_object('meeting_id',l.meeting_id,'node_id',l.node_id,'position',l.position,'code',n.code,'name',n.name)
 FROM cockpit_meeting_node l CROSS JOIN args x JOIN cockpit_node n ON n.workspace_id=x.ws AND n.id=l.node_id
 WHERE x.kind='meeting_nodes' AND l.workspace_id=x.ws AND l.meeting_id=x.object_id
), page AS (
 SELECT s.* FROM source s,args x WHERE x.cursor_id IS NULL OR (s.position,s.id)>(x.cursor_position,x.cursor_id)
 ORDER BY s.position,s.id LIMIT (SELECT page_size+1 FROM args)
)
SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(p.item ORDER BY p.position,p.id) FROM page p),'[]'::jsonb),
 'total',(SELECT count(*) FROM source),'payment_total',COALESCE((SELECT sum(amount) FROM source),0),
 'cursor_items',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'position',p.position) ORDER BY p.position,p.id) FROM page p),'[]'::jsonb))::jsonb AS payload;

-- name: CockpitMeetingMatchesSurfaceScope :one
WITH RECURSIVE meeting_nodes AS (
 SELECT l.node_id FROM cockpit_meeting_node l WHERE l.workspace_id=sqlc.arg('workspace_id')::uuid AND l.meeting_id=sqlc.arg('meeting_id')::uuid
 UNION SELECT a.node_id FROM cockpit_meeting_agenda a WHERE a.workspace_id=sqlc.arg('workspace_id')::uuid AND a.meeting_id=sqlc.arg('meeting_id')::uuid AND a.removed_at IS NULL AND a.node_id IS NOT NULL
), ancestors AS (
 SELECT n.id,n.parent_id,n.project_id,n.module_id,ARRAY[n.id] AS path
 FROM meeting_nodes l JOIN cockpit_node n ON n.id=l.node_id AND n.workspace_id=sqlc.arg('workspace_id')::uuid
 UNION ALL
 SELECT n.id,n.parent_id,n.project_id,n.module_id,a.path||n.id FROM cockpit_node n JOIN ancestors a ON a.parent_id=n.id
 WHERE n.workspace_id=sqlc.arg('workspace_id')::uuid AND NOT n.id=ANY(a.path)
), related_issues AS (
 SELECT i.project_id,i.module_id FROM cockpit_meeting_agenda_reference r JOIN cockpit_meeting_agenda a ON a.workspace_id=r.workspace_id AND a.id=r.agenda_id JOIN issue i ON i.workspace_id=r.workspace_id AND i.id=r.target_id
 WHERE r.workspace_id=sqlc.arg('workspace_id')::uuid AND r.meeting_id=sqlc.arg('meeting_id')::uuid AND r.kind='issue' AND r.removed_at IS NULL AND a.removed_at IS NULL
 UNION ALL
 SELECT i.project_id,i.module_id FROM cockpit_meeting_issue l JOIN issue i ON i.workspace_id=l.workspace_id AND i.id=l.issue_id
 WHERE l.workspace_id=sqlc.arg('workspace_id')::uuid AND l.meeting_id=sqlc.arg('meeting_id')::uuid
 UNION ALL
 SELECT i.project_id,i.module_id FROM cockpit_meeting_work_package w JOIN issue i ON i.workspace_id=w.workspace_id AND i.id=w.minutes_issue_id
 WHERE w.workspace_id=sqlc.arg('workspace_id')::uuid AND w.meeting_id=sqlc.arg('meeting_id')::uuid
 UNION ALL
 SELECT i.project_id,i.module_id FROM cockpit_meeting_action a JOIN issue i ON i.workspace_id=a.workspace_id AND i.id=a.issue_id
 WHERE a.workspace_id=sqlc.arg('workspace_id')::uuid AND a.meeting_id=sqlc.arg('meeting_id')::uuid AND a.status='accepted'
)
SELECT (sqlc.narg('project_id')::uuid IS NULL AND sqlc.narg('module_id')::uuid IS NULL
 OR EXISTS(SELECT 1 FROM ancestors a WHERE (sqlc.narg('project_id')::uuid IS NULL OR a.project_id=sqlc.narg('project_id')::uuid)
 AND (sqlc.narg('module_id')::uuid IS NULL OR a.module_id=sqlc.narg('module_id')::uuid))
 OR EXISTS(SELECT 1 FROM related_issues i WHERE (sqlc.narg('project_id')::uuid IS NULL OR i.project_id=sqlc.narg('project_id')::uuid)
 AND (sqlc.narg('module_id')::uuid IS NULL OR i.module_id=sqlc.narg('module_id')::uuid)))::bool;

-- name: GetCockpitSurfaceMeeting :one
SELECT (to_jsonb(m)||jsonb_build_object('start_time',to_char(m.start_time,'HH24:MI'),'end_time',to_char(m.end_time,'HH24:MI')))::jsonb AS payload
FROM cockpit_meeting m WHERE m.workspace_id=sqlc.arg('workspace_id')::uuid AND m.id=sqlc.arg('meeting_id')::uuid;

-- name: CountCockpitSurfaceNodesInWorkspace :one
SELECT count(*) FROM cockpit_node WHERE workspace_id=sqlc.arg('workspace_id')::uuid AND id=ANY(sqlc.arg('node_ids')::uuid[]);
