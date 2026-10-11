-- name: GetCockpitOverviewBoard :one
SELECT id,title,goal_title,goal_date FROM cockpit WHERE workspace_id=$1;

-- name: GetCockpitOverviewProject :one
SELECT id,title FROM project WHERE workspace_id=$1 AND id=$2;

-- name: GetCockpitOverviewReadModel :one
-- Only bounded cards leave the database. Counts use the same fact CTEs as pages.
-- A date scopes overdue/recent facts; unresolved governance is never date-limited.
-- Gate entire section payloads: filtering an inactive page alone can still
-- evaluate its candidate CTE before the planner applies the section predicate.
WITH RECURSIVE args AS NOT MATERIALIZED (
 SELECT sqlc.arg('workspace_id')::uuid AS ws,sqlc.narg('project_id')::uuid AS project,sqlc.narg('module_id')::uuid AS module,
 sqlc.arg('actor_id')::uuid AS actor,sqlc.arg('human')::bool AS human,sqlc.arg('actor_role')::text AS actor_role,
 sqlc.arg('as_of')::date AS as_of,sqlc.arg('view')::text AS view,sqlc.arg('kind')::text AS kind,
 sqlc.arg('section')::text AS section,sqlc.arg('cursor_key')::text AS cursor_key,
 sqlc.arg('page_size')::int AS page_size,sqlc.arg('days')::int AS days
), node_tree AS (
 SELECT n.id,n.parent_id,n.project_id,n.module_id,n.project_id AS resolved_project,n.module_id AS resolved_module,
 ARRAY[n.id] AS path,TRUE AS valid
 FROM cockpit_node n,args x WHERE n.workspace_id=x.ws AND n.parent_id IS NULL
 UNION ALL
 SELECT n.id,n.parent_id,n.project_id,n.module_id,COALESCE(n.project_id,t.resolved_project),COALESCE(n.module_id,t.resolved_module),
 t.path||n.id,t.valid AND (n.project_id IS NULL OR t.resolved_project IS NULL OR n.project_id=t.resolved_project)
 AND (n.module_id IS NULL OR (t.resolved_module IS NULL AND n.project_id IS NOT NULL))
 FROM cockpit_node n JOIN node_tree t ON n.parent_id=t.id CROSS JOIN args x
 WHERE n.workspace_id=x.ws AND NOT n.id=ANY(t.path)
), execution AS (
 SELECT n.id,n.code,n.name,n.owner,n.status,n.start_date,n.end_date,p.id AS project_id,p.title AS project_title,
 m.id AS module_id,m.title AS module_title
 FROM node_tree t JOIN cockpit_node n ON n.id=t.id CROSS JOIN args x
 JOIN module m ON m.workspace_id=x.ws AND m.id=t.resolved_module AND m.project_id=t.resolved_project
 JOIN project p ON p.workspace_id=x.ws AND p.id=t.resolved_project
 WHERE t.valid AND t.project_id IS NULL AND t.module_id IS NULL
 AND NOT EXISTS(SELECT 1 FROM cockpit_node child WHERE child.workspace_id=x.ws AND child.parent_id=t.id)
 AND (x.project IS NULL OR p.id=x.project) AND (x.module IS NULL OR m.id=x.module)
), primary_facts AS (
 SELECT i.id,i.title,i.status,cockpit_issue_category(i.status,st.category) AS category,
 i.assignee_type,i.assignee_id,i.due_date,i.created_at,p.node_id,
 (cockpit_issue_category(i.status,st.category) NOT IN ('done','closed') AND i.due_date<x.as_of)::bool AS overdue,
 (cockpit_issue_category(i.status,st.category) NOT IN ('done','closed') AND (i.status='blocked' OR st.category='blocked'))::bool AS blocked
 FROM cockpit_issue_primary p JOIN issue i ON i.id=p.issue_id AND i.workspace_id=p.workspace_id CROSS JOIN args x
 LEFT JOIN issue_status st ON st.workspace_id=i.workspace_id AND st.key=i.status
 WHERE p.workspace_id=x.ws AND p.node_id IS NOT NULL AND p.issue_deleted_at IS NULL AND (x.project IS NULL OR i.project_id=x.project) AND (x.module IS NULL OR i.module_id=x.module)
), meetings AS (
 SELECT m.id,m.code,m.title,m.meet_date,m.time_range,m.status,m.created_at,m.ended_at,m.archived_at
 FROM cockpit_meeting m CROSS JOIN args x
 WHERE m.workspace_id=x.ws AND (x.project IS NULL
 OR EXISTS(SELECT 1 FROM cockpit_meeting_node l JOIN node_tree t ON t.id=l.node_id WHERE l.workspace_id=x.ws AND l.meeting_id=m.id AND t.valid AND t.resolved_project=x.project)
 OR EXISTS(SELECT 1 FROM cockpit_meeting_agenda a JOIN node_tree t ON t.id=a.node_id WHERE a.workspace_id=x.ws AND a.meeting_id=m.id AND a.removed_at IS NULL AND t.valid AND t.resolved_project=x.project)
 OR EXISTS(SELECT 1 FROM cockpit_meeting_agenda_reference r JOIN cockpit_meeting_agenda a ON a.workspace_id=r.workspace_id AND a.id=r.agenda_id JOIN issue i ON i.workspace_id=r.workspace_id AND i.id=r.target_id WHERE r.workspace_id=x.ws AND r.meeting_id=m.id AND r.kind='issue' AND r.removed_at IS NULL AND a.removed_at IS NULL AND i.project_id=x.project)
 OR EXISTS(SELECT 1 FROM cockpit_meeting_work_package w JOIN issue i ON i.workspace_id=w.workspace_id AND i.id=w.minutes_issue_id WHERE w.workspace_id=x.ws AND w.meeting_id=m.id AND i.project_id=x.project)
 OR EXISTS(SELECT 1 FROM cockpit_meeting_issue l JOIN issue i ON i.workspace_id=l.workspace_id AND i.id=l.issue_id WHERE l.workspace_id=x.ws AND l.meeting_id=m.id AND i.project_id=x.project)
 OR EXISTS(SELECT 1 FROM cockpit_meeting_action a JOIN issue i ON i.workspace_id=a.workspace_id AND i.id=a.issue_id WHERE a.workspace_id=x.ws AND a.meeting_id=m.id AND a.status='accepted' AND i.project_id=x.project))
 AND (x.module IS NULL
 OR EXISTS(SELECT 1 FROM cockpit_meeting_node l JOIN node_tree t ON t.id=l.node_id WHERE l.workspace_id=x.ws AND l.meeting_id=m.id AND t.valid AND t.resolved_module=x.module)
 OR EXISTS(SELECT 1 FROM cockpit_meeting_agenda a JOIN node_tree t ON t.id=a.node_id WHERE a.workspace_id=x.ws AND a.meeting_id=m.id AND a.removed_at IS NULL AND t.valid AND t.resolved_module=x.module)
 OR EXISTS(SELECT 1 FROM cockpit_meeting_agenda_reference r JOIN cockpit_meeting_agenda a ON a.workspace_id=r.workspace_id AND a.id=r.agenda_id JOIN issue i ON i.workspace_id=r.workspace_id AND i.id=r.target_id WHERE r.workspace_id=x.ws AND r.meeting_id=m.id AND r.kind='issue' AND r.removed_at IS NULL AND a.removed_at IS NULL AND i.module_id=x.module)
 OR EXISTS(SELECT 1 FROM cockpit_meeting_work_package w JOIN issue i ON i.workspace_id=w.workspace_id AND i.id=w.minutes_issue_id WHERE w.workspace_id=x.ws AND w.meeting_id=m.id AND i.module_id=x.module)
 OR EXISTS(SELECT 1 FROM cockpit_meeting_issue l JOIN issue i ON i.workspace_id=l.workspace_id AND i.id=l.issue_id WHERE l.workspace_id=x.ws AND l.meeting_id=m.id AND i.module_id=x.module)
 OR EXISTS(SELECT 1 FROM cockpit_meeting_action a JOIN issue i ON i.workspace_id=a.workspace_id AND i.id=a.issue_id WHERE a.workspace_id=x.ws AND a.meeting_id=m.id AND a.status='accepted' AND i.module_id=x.module))
), workflow AS (
 SELECT m.*,w.minutes_issue_id,w.reviewer_id AS default_reviewer,w.created_by,w.materials_ready,w.released_at,
 w.current_version_id,w.published_version_id,v.version_number,v.reviewer_id,v.review_issue_id,v.decision,v.published_at,
 i.status AS minutes_status,i.assignee_type,i.assignee_id,
 (x.actor_role IN ('owner','admin') OR w.created_by=x.actor)::bool AS manager,
 CASE
 WHEN w.released_at IS NULL THEN CASE
  WHEN m.ended_at IS NOT NULL AND w.materials_ready AND i.status='backlog' THEN 'release_ready'
  WHEN m.ended_at IS NOT NULL AND w.materials_ready THEN 'restore_backlog'
  WHEN m.ended_at IS NOT NULL THEN 'materials_needed'
  WHEN m.meet_date<x.as_of THEN 'readiness_needed' ELSE '' END
 WHEN v.decision='pending' AND NOT EXISTS(SELECT 1 FROM member u WHERE u.workspace_id=x.ws AND u.user_id=v.reviewer_id) THEN 'reviewer_missing'
 WHEN v.decision='pending' THEN 'review_pending'
 WHEN v.decision='approved' AND v.published_at IS NULL THEN 'publish_ready'
 WHEN v.published_at IS NOT NULL AND w.published_version_id=v.id THEN ''
 WHEN NOT EXISTS(SELECT 1 FROM member u WHERE u.workspace_id=x.ws AND u.user_id=w.reviewer_id) THEN 'reviewer_missing'
 WHEN v.decision IN ('changes_requested','rejected') THEN 'minutes_rework'
 ELSE 'minutes_needed' END::text AS reason
 FROM meetings m CROSS JOIN args x JOIN cockpit_meeting_work_package w ON w.workspace_id=x.ws AND w.meeting_id=m.id
 JOIN issue i ON i.workspace_id=x.ws AND i.id=w.minutes_issue_id
 LEFT JOIN cockpit_minutes_version v ON v.workspace_id=x.ws AND v.meeting_id=m.id AND v.id=w.current_version_id
), attention AS (
 SELECT w.id,'workflow'::text AS kind,w.reason,w.title,w.created_at,NULL::date AS due_date,
 CASE WHEN w.reason='review_pending' THEN 'formal_reviewer'
 WHEN w.reason IN ('minutes_needed','minutes_rework') THEN CASE WHEN w.assignee_id IS NULL THEN 'unassigned' ELSE CASE w.assignee_type WHEN 'member' THEN 'assigned_member' WHEN 'agent' THEN 'assigned_agent' WHEN 'squad' THEN 'assigned_squad' ELSE 'unassigned' END END
 ELSE 'team_management' END::text AS responsibility,
 CASE WHEN w.reason IN ('review_pending','reviewer_missing') THEN 'member' WHEN w.reason IN ('minutes_needed','minutes_rework') THEN w.assignee_type ELSE NULL END::text AS assignee_type,
 CASE WHEN w.reason='review_pending' THEN w.reviewer_id WHEN w.reason='reviewer_missing' THEN CASE WHEN w.decision='pending' THEN w.reviewer_id ELSE w.default_reviewer END WHEN w.reason IN ('minutes_needed','minutes_rework') THEN w.assignee_id ELSE NULL END AS assignee_id,
 COALESCE(w.reason='review_pending' AND w.reviewer_id=x.actor OR w.reason IN ('minutes_needed','minutes_rework') AND w.assignee_type='member' AND w.assignee_id=x.actor,FALSE)::bool AS mine,
 (x.human AND CASE WHEN w.reason='review_pending' THEN w.reviewer_id=x.actor
 WHEN w.reason='publish_ready' THEN w.manager OR w.reviewer_id=x.actor
 WHEN w.reason IN ('minutes_needed','minutes_rework') THEN w.manager OR (w.assignee_type='member' AND w.assignee_id=x.actor)
 ELSE w.manager END)::bool AS can_act,
 CASE w.reason WHEN 'review_pending' THEN 'review_minutes' WHEN 'reviewer_missing' THEN 'reassign_reviewer' WHEN 'publish_ready' THEN 'publish_minutes'
 WHEN 'release_ready' THEN 'release_minutes' WHEN 'restore_backlog' THEN 'restore_backlog' WHEN 'minutes_needed' THEN 'submit_minutes' WHEN 'minutes_rework' THEN 'revise_minutes' ELSE 'manage_readiness' END::text AS next_action,
 w.id AS meeting_id,w.current_version_id AS version_id,w.version_number,NULL::uuid AS node_id,
 CASE WHEN w.reason IN ('review_pending','reviewer_missing') THEN COALESCE(w.review_issue_id,w.minutes_issue_id) ELSE w.minutes_issue_id END AS issue_id,
 NULL::uuid AS action_id,NULL::uuid AS export_id,ARRAY[]::text[] AS flags,1 AS rank
 FROM workflow w CROSS JOIN args x WHERE w.reason<>''
 UNION ALL
 SELECT a.id,'action',CASE WHEN a.version_id=w.published_version_id THEN 'action_pending' ELSE 'action_superseded' END,a.title,a.created_at,NULL::date,
 'team_management',NULL::text,NULL::uuid,FALSE,x.human AND (x.actor_role IN ('owner','admin') OR w.created_by=x.actor OR v.reviewer_id=x.actor),
 CASE WHEN a.version_id=w.published_version_id THEN 'resolve_action' ELSE 'dismiss_superseded_action' END,
 a.meeting_id,a.version_id,a.version_number,NULL::uuid,NULL::uuid,a.id,NULL::uuid,
 CASE WHEN a.version_id=w.published_version_id THEN ARRAY[]::text[] ELSE ARRAY['source_superseded']::text[] END,2
 FROM cockpit_meeting_action a CROSS JOIN args x JOIN meetings m ON m.id=a.meeting_id
 JOIN cockpit_meeting_work_package w ON w.workspace_id=x.ws AND w.meeting_id=a.meeting_id
 JOIN cockpit_minutes_version v ON v.workspace_id=x.ws AND v.meeting_id=a.meeting_id AND v.id=a.version_id AND v.decision='approved' AND v.published_at IS NOT NULL
 WHERE a.workspace_id=x.ws AND a.status='draft'
 UNION ALL
 SELECT e.id,'nas',e.status,m.title,e.created_at,NULL::date,'team_management',NULL::text,NULL::uuid,FALSE,
 x.human AND (x.actor_role IN ('owner','admin') OR w.created_by=x.actor OR v.reviewer_id=x.actor),'inspect_nas',
 e.meeting_id,e.version_id,e.version_number,NULL::uuid,e.source_issue_id,NULL::uuid,e.id,ARRAY[e.last_error_code]::text[],3
 FROM cockpit_minutes_export e CROSS JOIN args x JOIN meetings m ON m.id=e.meeting_id
 JOIN cockpit_meeting_work_package w ON w.workspace_id=x.ws AND w.meeting_id=e.meeting_id
 JOIN cockpit_minutes_version v ON v.workspace_id=x.ws AND v.meeting_id=e.meeting_id AND v.id=e.version_id AND v.decision='approved' AND v.published_at IS NOT NULL
 WHERE e.workspace_id=x.ws AND e.status IN ('retry_wait','needs_attention')
 UNION ALL
 SELECT p.id,'issue','active_issue',p.title,p.created_at,p.due_date,
 CASE WHEN p.assignee_id IS NULL THEN 'unassigned' ELSE CASE p.assignee_type WHEN 'member' THEN 'assigned_member' WHEN 'agent' THEN 'assigned_agent' WHEN 'squad' THEN 'assigned_squad' ELSE 'unassigned' END END,
 p.assignee_type,p.assignee_id,COALESCE(p.assignee_type='member' AND p.assignee_id=x.actor,FALSE),x.human,'open_issue',
 NULL::uuid,NULL::uuid,NULL::int,p.node_id,p.id,NULL::uuid,NULL::uuid,
 array_remove(ARRAY[CASE WHEN p.overdue THEN 'overdue' END,CASE WHEN p.blocked THEN 'blocked' END,CASE WHEN p.assignee_id IS NULL THEN 'unassigned' END,CASE WHEN p.category='unknown' THEN 'unknown_status' END],NULL),4
 FROM primary_facts p CROSS JOIN args x
 WHERE p.category NOT IN ('done','closed')
 AND NOT EXISTS(SELECT 1 FROM cockpit_meeting_work_package w WHERE w.workspace_id=x.ws AND w.minutes_issue_id=p.id)
 AND NOT EXISTS(SELECT 1 FROM cockpit_minutes_version v WHERE v.workspace_id=x.ws AND v.review_issue_id=p.id)
 AND NOT EXISTS(SELECT 1 FROM cockpit_reviewer_handoff h WHERE h.workspace_id=x.ws AND (h.from_review_issue_id=p.id OR h.to_review_issue_id=p.id))
), attention_filtered AS (
 SELECT a.*,a.rank::text||':'||CASE WHEN 'overdue'=ANY(a.flags) THEN '0' WHEN 'blocked'=ANY(a.flags) THEN '1' ELSE '2' END||':'||a.id::text AS sort_key FROM attention a CROSS JOIN args x
 WHERE (x.view='team' OR a.mine) AND (x.kind='' OR x.kind=a.kind)
), attention_page AS (
 SELECT a.* FROM attention_filtered a CROSS JOIN args x
 WHERE x.section IN ('overview','attention') AND (x.cursor_key='' OR a.sort_key>x.cursor_key)
 ORDER BY a.sort_key LIMIT (SELECT CASE WHEN section='overview' THEN 9 ELSE page_size+1 END FROM args)
), attention_cards AS (
 SELECT p.sort_key,jsonb_build_object('id',p.id,'kind',p.kind,'reason',p.reason,'title',p.title,'flags',p.flags,'created_at',p.created_at,'due_date',p.due_date,
 'responsibility',p.responsibility,'assignee_type',p.assignee_type,'assignee_id',p.assignee_id,'assignee_name',COALESCE(u.name,ag.name,sq.name,''),
 'can_act',COALESCE(p.can_act,FALSE),'next_action',p.next_action,'sort_key',p.sort_key,
 'target',jsonb_build_object('kind',CASE p.kind WHEN 'issue' THEN 'issue' WHEN 'action' THEN 'action' ELSE 'meeting' END,
 'id',CASE WHEN p.kind='issue' THEN p.issue_id WHEN p.kind='action' THEN p.action_id ELSE p.meeting_id END,
 'meeting_id',p.meeting_id,'version_id',p.version_id,'node_id',p.node_id,'issue_id',p.issue_id,'action_id',p.action_id,'export_id',p.export_id),
 'meeting_code',COALESCE(m.code,''),'meeting_title',COALESCE(m.title,''),'version_number',p.version_number,
 'node_code',COALESCE(n.code,''),'node_name',COALESCE(n.name,''),'issue_identifier',CASE WHEN i.id IS NULL THEN '' ELSE ws.issue_prefix||'-'||i.number::text END,
 'issue_status',COALESCE(i.status,''),'issue_status_category',CASE WHEN i.id IS NULL THEN '' ELSE cockpit_issue_category(i.status,st.category) END) AS card
 FROM attention_page p CROSS JOIN args x JOIN workspace ws ON ws.id=x.ws
 LEFT JOIN meetings m ON m.id=p.meeting_id LEFT JOIN cockpit_node n ON n.workspace_id=x.ws AND n.id=p.node_id
 LEFT JOIN issue i ON i.workspace_id=x.ws AND i.id=p.issue_id LEFT JOIN issue_status st ON st.workspace_id=x.ws AND st.key=i.status
 LEFT JOIN "user" u ON p.assignee_type='member' AND u.id=p.assignee_id
 LEFT JOIN agent ag ON p.assignee_type='agent' AND ag.workspace_id=x.ws AND ag.id=p.assignee_id
 LEFT JOIN squad sq ON p.assignee_type='squad' AND sq.workspace_id=x.ws AND sq.id=p.assignee_id
), execution_counts AS MATERIALIZED (
 SELECT node_id,count(*) FILTER(WHERE category NOT IN ('done','closed')) AS active_total,
 jsonb_build_object('total',count(*) FILTER (WHERE (TRUE) AND (TRUE)),'active',count(*) FILTER (WHERE (TRUE) AND (category NOT IN ('done','closed'))),'unstarted',count(*) FILTER (WHERE (TRUE) AND (category='unstarted')),'started',count(*) FILTER (WHERE (TRUE) AND (category='started')),'done',count(*) FILTER (WHERE (TRUE) AND (category='done')),'closed',count(*) FILTER (WHERE (TRUE) AND (category='closed')),'unknown',count(*) FILTER (WHERE (TRUE) AND (category='unknown')),'overdue',count(*) FILTER (WHERE (TRUE) AND (overdue)),'blocked',count(*) FILTER (WHERE (TRUE) AND (blocked)),'unassigned',count(*) FILTER (WHERE (TRUE) AND (category NOT IN ('done','closed') AND assignee_id IS NULL))) AS counts FROM primary_facts GROUP BY node_id
), execution_page AS (
 SELECT e.* FROM execution e CROSS JOIN args x WHERE x.section IN ('overview','execution') AND (x.cursor_key='' OR e.id::text>x.cursor_key)
 ORDER BY e.id LIMIT (SELECT CASE WHEN section='overview' THEN 7 ELSE page_size+1 END FROM args)
), execution_cards AS (
 SELECT e.id,jsonb_build_object('id',e.id,'code',e.code,'name',e.name,'project_id',e.project_id,'project_title',e.project_title,
 'module_id',e.module_id,'module_title',e.module_title,'plan_owner',e.owner,'plan_status',e.status,'plan_start_date',e.start_date,'plan_end_date',e.end_date,
 'issue_counts',COALESCE(c.counts,jsonb_build_object('total',0,'active',0,'unstarted',0,'started',0,'done',0,'closed',0,'unknown',0,'overdue',0,'blocked',0,'unassigned',0))) AS card FROM execution_page e LEFT JOIN execution_counts c ON c.node_id=e.id
), recent AS (
 SELECT m.*,w.minutes_issue_id,w.current_version_id,w.version_number,w.published_version_id,
 CASE WHEN w.id IS NULL THEN 'not_enabled' WHEN w.reason<>'' THEN w.reason WHEN w.released_at IS NULL THEN 'waiting_meeting' ELSE 'published' END::text AS workflow_stage,
 m.meet_date::text||':'||m.id::text AS sort_key
 FROM meetings m CROSS JOIN args x LEFT JOIN workflow w ON w.id=m.id
 WHERE m.archived_at IS NULL AND m.meet_date BETWEEN x.as_of-(x.days-1) AND x.as_of+7
), recent_page AS (
 SELECT r.* FROM recent r CROSS JOIN args x WHERE x.section IN ('overview','meetings') AND (x.cursor_key='' OR r.sort_key<x.cursor_key)
 ORDER BY r.sort_key DESC LIMIT (SELECT CASE WHEN section='overview' THEN 7 ELSE page_size+1 END FROM args)
), recent_cards AS (
 SELECT r.sort_key,jsonb_build_object('id',r.id,'code',r.code,'title',r.title,'meet_date',r.meet_date,'time_range',r.time_range,'meeting_status',r.status,
 'ended_at',r.ended_at,'workflow_enabled',r.minutes_issue_id IS NOT NULL,'workflow_stage',r.workflow_stage,
 'minutes_issue_id',r.minutes_issue_id,'current_version_id',r.current_version_id,'current_version_number',r.version_number,'published_version_id',r.published_version_id) AS card FROM recent_page r
)
SELECT jsonb_build_object(
 'summary',CASE WHEN x.section='overview' THEN jsonb_build_object(
  'primary_issues',(SELECT jsonb_build_object('total',count(*) FILTER (WHERE (TRUE) AND (TRUE)),'active',count(*) FILTER (WHERE (TRUE) AND (category NOT IN ('done','closed'))),'unstarted',count(*) FILTER (WHERE (TRUE) AND (category='unstarted')),'started',count(*) FILTER (WHERE (TRUE) AND (category='started')),'done',count(*) FILTER (WHERE (TRUE) AND (category='done')),'closed',count(*) FILTER (WHERE (TRUE) AND (category='closed')),'unknown',count(*) FILTER (WHERE (TRUE) AND (category='unknown')),'overdue',count(*) FILTER (WHERE (TRUE) AND (overdue)),'blocked',count(*) FILTER (WHERE (TRUE) AND (blocked)),'unassigned',count(*) FILTER (WHERE (TRUE) AND (category NOT IN ('done','closed') AND assignee_id IS NULL))) FROM primary_facts),
  'my_primary_issues',(SELECT jsonb_build_object('total',count(*) FILTER (WHERE (assignee_type='member' AND assignee_id=x.actor) AND (TRUE)),'active',count(*) FILTER (WHERE (assignee_type='member' AND assignee_id=x.actor) AND (category NOT IN ('done','closed'))),'unstarted',count(*) FILTER (WHERE (assignee_type='member' AND assignee_id=x.actor) AND (category='unstarted')),'started',count(*) FILTER (WHERE (assignee_type='member' AND assignee_id=x.actor) AND (category='started')),'done',count(*) FILTER (WHERE (assignee_type='member' AND assignee_id=x.actor) AND (category='done')),'closed',count(*) FILTER (WHERE (assignee_type='member' AND assignee_id=x.actor) AND (category='closed')),'unknown',count(*) FILTER (WHERE (assignee_type='member' AND assignee_id=x.actor) AND (category='unknown')),'overdue',count(*) FILTER (WHERE (assignee_type='member' AND assignee_id=x.actor) AND (overdue)),'blocked',count(*) FILTER (WHERE (assignee_type='member' AND assignee_id=x.actor) AND (blocked)),'unassigned',count(*) FILTER (WHERE (assignee_type='member' AND assignee_id=x.actor) AND (category NOT IN ('done','closed') AND assignee_id IS NULL))) FROM primary_facts),
  'execution_nodes',jsonb_build_object('total',(SELECT count(*) FROM execution),'with_active_issues',(SELECT count(*) FROM execution e JOIN execution_counts c ON c.node_id=e.id WHERE c.active_total>0)),
  'attention',jsonb_build_object('team_total',(SELECT count(*) FROM attention),'mine_total',(SELECT count(*) FROM attention WHERE mine),
  'team_by_kind',jsonb_build_object('workflow',(SELECT count(*) FROM attention WHERE kind='workflow'),'action',(SELECT count(*) FROM attention WHERE kind='action'),'nas',(SELECT count(*) FROM attention WHERE kind='nas'),'issue',(SELECT count(*) FROM attention WHERE kind='issue')),
  'mine_by_kind',jsonb_build_object('workflow',(SELECT count(*) FROM attention WHERE mine AND kind='workflow'),'action',(SELECT count(*) FROM attention WHERE mine AND kind='action'),'nas',(SELECT count(*) FROM attention WHERE mine AND kind='nas'),'issue',(SELECT count(*) FROM attention WHERE mine AND kind='issue')))) ELSE NULL END,
 'attention',CASE WHEN x.section IN ('overview','attention') THEN jsonb_build_object(
 'items',COALESCE((SELECT jsonb_agg(card ORDER BY sort_key) FROM attention_cards),'[]'::jsonb),'total',(SELECT count(*) FROM attention_filtered))
 ELSE jsonb_build_object('items','[]'::jsonb,'total',0) END,
 'execution_nodes',CASE WHEN x.section IN ('overview','execution') THEN jsonb_build_object(
 'items',COALESCE((SELECT jsonb_agg(card ORDER BY id) FROM execution_cards),'[]'::jsonb),'total',(SELECT count(*) FROM execution))
 ELSE jsonb_build_object('items','[]'::jsonb,'total',0) END,
 'recent_meetings',CASE WHEN x.section IN ('overview','meetings') THEN jsonb_build_object(
 'items',COALESCE((SELECT jsonb_agg(card ORDER BY sort_key DESC) FROM recent_cards),'[]'::jsonb),'total',(SELECT count(*) FROM recent))
 ELSE jsonb_build_object('items','[]'::jsonb,'total',0) END
)::jsonb AS payload FROM args x;
