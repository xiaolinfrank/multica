-- name: ReadIssueOperationBasisFacts :one
WITH RECURSIVE args AS NOT MATERIALIZED (
 SELECT sqlc.arg(workspace_id)::uuid AS ws,sqlc.arg(issue_ids)::uuid[] AS ids
), requested AS MATERIALIZED (
 SELECT i.id,i.revision,i.title,i.parent_issue_id,i.project_id,i.module_id,i.triage_state,i.assignee_type,i.assignee_id,i.status
 FROM issue i,args x WHERE i.workspace_id=x.ws AND i.id=ANY(x.ids)
), descendants(root_id,id) AS (
 SELECT id,id FROM requested
 UNION
 SELECT d.root_id,i.id FROM descendants d JOIN issue i ON i.parent_issue_id=d.id AND i.workspace_id=(SELECT ws FROM args)
), related AS MATERIALIZED (SELECT DISTINCT id FROM descendants), artifact_edges AS MATERIALIZED (
 SELECT a.source_issue_id AS issue_id,a.id AS artifact_id,NULL::uuid AS version_id,a.owner_node_id AS node_id,NULL::uuid AS request_id,'artifact_source'::text AS purpose,30 AS rank
 FROM cockpit_artifact a JOIN related r ON r.id=a.source_issue_id WHERE a.workspace_id=(SELECT ws FROM args)
 UNION
 SELECT a.authorized_producer_issue_id,a.id,NULL::uuid,a.owner_node_id,NULL::uuid,'artifact_source',30 FROM cockpit_artifact a JOIN related r ON r.id=a.authorized_producer_issue_id WHERE a.workspace_id=(SELECT ws FROM args)
 UNION
 SELECT v.producer_issue_id,v.artifact_id,NULL::uuid,a.owner_node_id,NULL::uuid,'artifact_source',30 FROM cockpit_artifact_version v JOIN related r ON r.id=v.producer_issue_id LEFT JOIN cockpit_artifact a ON a.id=v.artifact_id AND a.workspace_id=v.workspace_id WHERE v.workspace_id=(SELECT ws FROM args)
 UNION
 SELECT p.from_issue_id,p.artifact_id,NULL::uuid,a.owner_node_id,NULL::uuid,'artifact_source',30 FROM cockpit_artifact_producer_assignment p JOIN related r ON r.id=p.from_issue_id LEFT JOIN cockpit_artifact a ON a.id=p.artifact_id AND a.workspace_id=p.workspace_id WHERE p.workspace_id=(SELECT ws FROM args)
 UNION
 SELECT p.to_issue_id,p.artifact_id,NULL::uuid,a.owner_node_id,NULL::uuid,'artifact_source',30 FROM cockpit_artifact_producer_assignment p JOIN related r ON r.id=p.to_issue_id LEFT JOIN cockpit_artifact a ON a.id=p.artifact_id AND a.workspace_id=p.workspace_id WHERE p.workspace_id=(SELECT ws FROM args)
 UNION
 SELECT v.review_issue_id,v.artifact_id,v.id,a.owner_node_id,NULL::uuid,'formal_review',0 FROM cockpit_artifact_version v JOIN related r ON r.id=v.review_issue_id LEFT JOIN cockpit_artifact a ON a.id=v.artifact_id AND a.workspace_id=v.workspace_id WHERE v.workspace_id=(SELECT ws FROM args)
 UNION
 SELECT h.from_review_issue_id,h.artifact_id,h.version_id,a.owner_node_id,NULL::uuid,'formal_review',0 FROM cockpit_artifact_reviewer_handoff h JOIN related r ON r.id=h.from_review_issue_id LEFT JOIN cockpit_artifact a ON a.id=h.artifact_id AND a.workspace_id=h.workspace_id WHERE h.workspace_id=(SELECT ws FROM args)
 UNION
 SELECT a.review_issue_id,NULL::uuid,NULL::uuid,a.node_id,a.id,'formal_review',0 FROM cockpit_acceptance_request a JOIN related r ON r.id=a.review_issue_id WHERE a.workspace_id=(SELECT ws FROM args)
 UNION
 SELECT h.from_review_issue_id,NULL::uuid,NULL::uuid,h.node_id,h.request_id,'formal_review',0 FROM cockpit_acceptance_reviewer_handoff h JOIN related r ON r.id=h.from_review_issue_id WHERE h.workspace_id=(SELECT ws FROM args)
), input_edges AS MATERIALIZED (
 SELECT v.issue_id,v.id AS manifest_id,v.version_number FROM cockpit_issue_input_manifest_version v JOIN requested r ON r.id=v.issue_id
 WHERE v.workspace_id=(SELECT ws FROM args) AND (EXISTS(SELECT 1 FROM agent_task_queue t WHERE t.input_manifest_version_id=v.id)
 OR EXISTS(SELECT 1 FROM cockpit_artifact_version a WHERE a.workspace_id=v.workspace_id AND a.input_manifest_version_id=v.id))
), retained AS MATERIALIZED (SELECT DISTINCT issue_id FROM artifact_edges), primary_edges AS MATERIALIZED (
 SELECT p.issue_id,p.node_id FROM cockpit_issue_primary p JOIN related r ON r.id=p.issue_id WHERE p.workspace_id=(SELECT ws FROM args) AND p.node_id IS NOT NULL
), meeting_edges AS MATERIALIZED (
 SELECT l.issue_id,l.meeting_id,NULL::uuid AS action_id,'meeting_workflow'::text AS purpose,
   EXISTS(SELECT 1 FROM cockpit_meeting m WHERE m.workspace_id=l.workspace_id AND m.id=l.meeting_id
     AND (m.ended_at IS NULL OR NOT m.minutes_materials_ready)) AS blocks_execution
 FROM cockpit_meeting_issue l JOIN requested r ON r.id=l.issue_id
 WHERE l.workspace_id=(SELECT ws FROM args) AND 'minutes'=ANY(l.roles)
 UNION
 SELECT v.source_issue_id,v.meeting_id,NULL::uuid,'meeting_workflow',false FROM cockpit_minutes_version v JOIN requested r ON r.id=v.source_issue_id WHERE v.workspace_id=(SELECT ws FROM args)
 UNION
 SELECT v.review_issue_id,v.meeting_id,NULL::uuid,'meeting_review',true FROM cockpit_minutes_version v JOIN requested r ON r.id=v.review_issue_id WHERE v.workspace_id=(SELECT ws FROM args)
 UNION
 SELECT h.from_review_issue_id,h.meeting_id,NULL::uuid,'meeting_review',true FROM cockpit_reviewer_handoff h JOIN requested r ON r.id=h.from_review_issue_id WHERE h.workspace_id=(SELECT ws FROM args)
 UNION
 SELECT h.to_review_issue_id,h.meeting_id,NULL::uuid,'meeting_review',true FROM cockpit_reviewer_handoff h JOIN requested r ON r.id=h.to_review_issue_id WHERE h.workspace_id=(SELECT ws FROM args)
 UNION
 SELECT a.issue_id,a.meeting_id,a.id,'meeting_action',false FROM cockpit_meeting_action a JOIN requested r ON r.id=a.issue_id WHERE a.workspace_id=(SELECT ws FROM args)
), scope_facts AS MATERIALIZED (
 SELECT d.root_id,bool_or(r.issue_id IS NOT NULL) AS retained_scope,bool_or(p.issue_id IS NOT NULL) AS primary_scope
 FROM descendants d LEFT JOIN retained r ON r.issue_id=d.id LEFT JOIN primary_edges p ON p.issue_id=d.id GROUP BY d.root_id
), targets AS MATERIALIZED (
 SELECT e.issue_id,e.rank,jsonb_strip_nulls(jsonb_build_object('kind',CASE WHEN e.request_id IS NOT NULL THEN 'acceptance_request' WHEN e.version_id IS NOT NULL THEN 'artifact_version' ELSE 'artifact' END,
 'node_id',e.node_id,'artifact_id',e.artifact_id,'version_id',e.version_id,'request_id',e.request_id,'view',CASE WHEN e.request_id IS NOT NULL THEN 'acceptance' END,
 'label',CASE WHEN e.request_id IS NOT NULL THEN coalesce(n.name,'') ELSE coalesce(a.title,'') END,'purpose',e.purpose)) AS target
 FROM artifact_edges e JOIN requested r ON r.id=e.issue_id LEFT JOIN cockpit_artifact a ON a.id=e.artifact_id AND a.workspace_id=(SELECT ws FROM args) LEFT JOIN cockpit_node n ON n.id=e.node_id AND n.workspace_id=(SELECT ws FROM args) WHERE e.node_id IS NOT NULL
 UNION
 SELECT e.issue_id,5,jsonb_build_object('kind','issue','issue_id',e.issue_id,'version_id',e.manifest_id,'view','inputs','label',r.title||' · v'||e.version_number::text,'purpose','input_manifest')
 FROM input_edges e JOIN requested r ON r.id=e.issue_id
 UNION
 SELECT p.issue_id,10,jsonb_build_object('kind','node','node_id',p.node_id,'view','tasks','label',coalesce(n.name,''),'purpose','primary') FROM primary_edges p JOIN requested r ON r.id=p.issue_id LEFT JOIN cockpit_node n ON n.id=p.node_id AND n.workspace_id=(SELECT ws FROM args)
 UNION
 SELECT e.issue_id,20,jsonb_strip_nulls(jsonb_build_object('kind','meeting','meeting_id',e.meeting_id,'action_id',e.action_id,'view','workflow','label',coalesce(m.title,''),'purpose',e.purpose)) FROM meeting_edges e LEFT JOIN cockpit_meeting m ON m.id=e.meeting_id AND m.workspace_id=(SELECT ws FROM args)
 UNION
 SELECT d.root_id,40,jsonb_build_object('kind','issue','issue_id',d.id,'label',i.title,'purpose','protected_descendant') FROM descendants d JOIN issue i ON i.id=d.id AND i.workspace_id=(SELECT ws FROM args) WHERE d.root_id<>d.id AND (EXISTS(SELECT 1 FROM retained r WHERE r.issue_id=d.id) OR EXISTS(SELECT 1 FROM primary_edges p WHERE p.issue_id=d.id))
 UNION
 SELECT r.id,50,jsonb_build_object('kind','issue','issue_id',p.id,'label',p.title,'purpose','parent_scope') FROM requested r JOIN issue p ON p.id=r.parent_issue_id AND p.workspace_id=(SELECT ws FROM args)
), ranked_targets AS (
 SELECT issue_id,target,row_number() OVER(PARTITION BY issue_id ORDER BY rank,target::text) AS ordinal,count(*) OVER(PARTITION BY issue_id) AS total FROM targets
), target_pages AS (
 SELECT issue_id,jsonb_agg(target ORDER BY ordinal) AS items,max(total) AS total FROM ranked_targets WHERE ordinal<=3 GROUP BY issue_id
), facts AS (
 SELECT r.id,r.revision,r.project_id,r.module_id,r.parent_issue_id,r.triage_state,r.assignee_type,r.assignee_id,r.status,
 cockpit_artifact_review_stage((SELECT ws FROM args),r.id)::text AS formal_stage,
 EXISTS(SELECT 1 FROM retained t WHERE t.issue_id=r.id) AS retained_self,
 EXISTS(SELECT 1 FROM input_edges t WHERE t.issue_id=r.id) AS input_history,
 s.retained_scope,s.primary_scope,EXISTS(SELECT 1 FROM primary_edges p WHERE p.issue_id=r.id) AS has_primary,
 EXISTS(SELECT 1 FROM meeting_edges e WHERE e.issue_id=r.id) AS meeting_history,
 EXISTS(SELECT 1 FROM meeting_edges e WHERE e.issue_id=r.id AND e.blocks_execution) AS meeting_execution_blocked,
 EXISTS(SELECT 1 FROM descendants d WHERE d.root_id=r.id AND d.id=r.parent_issue_id) AS hierarchy_cycle,
 coalesce(t.items,'[]'::jsonb) AS targets,coalesce(t.total,0) AS targets_total
 FROM requested r JOIN scope_facts s ON s.root_id=r.id LEFT JOIN target_pages t ON t.issue_id=r.id
)
SELECT coalesce(jsonb_agg(f ORDER BY id),'[]'::jsonb)::jsonb AS payload FROM facts f;

-- name: ReadCockpitNodeOperationBasisFacts :one
WITH RECURSIVE args AS NOT MATERIALIZED (SELECT sqlc.arg(workspace_id)::uuid AS ws,sqlc.arg(node_id)::uuid AS node_id),
 descendants(id,parent_id) AS (
 SELECT n.id,n.parent_id FROM cockpit_node n,args x WHERE n.workspace_id=x.ws AND n.id=x.node_id
 UNION SELECT n.id,n.parent_id FROM cockpit_node n JOIN descendants d ON n.parent_id=d.id WHERE n.workspace_id=(SELECT ws FROM args)
), protected AS MATERIALIZED (
 SELECT d.id,'artifact'::text AS reason FROM descendants d WHERE cockpit_artifact_references_node((SELECT ws FROM args),d.id)
 UNION SELECT d.id,'primary' FROM descendants d JOIN cockpit_issue_primary p ON p.node_id=d.id WHERE p.workspace_id=(SELECT ws FROM args)
 UNION SELECT d.id,'action' FROM descendants d JOIN cockpit_meeting_action a ON a.node_id=d.id WHERE a.workspace_id=(SELECT ws FROM args)
), targets AS (
 SELECT p.id,jsonb_build_object('kind','node','node_id',p.id,'view',CASE WHEN bool_or(p.reason='artifact') THEN CASE WHEN EXISTS(SELECT 1 FROM cockpit_acceptance_definition a WHERE a.workspace_id=(SELECT ws FROM args) AND a.node_id=p.id) THEN 'acceptance' ELSE 'artifacts' END ELSE 'tasks' END,'label',n.name,'purpose',CASE WHEN bool_or(p.reason='artifact') THEN 'retained_node' ELSE 'primary' END) AS target FROM protected p JOIN cockpit_node n ON n.id=p.id AND n.workspace_id=(SELECT ws FROM args) GROUP BY p.id,n.name
), facts AS (
 SELECT EXISTS(SELECT 1 FROM descendants) AS exists,
 EXISTS(SELECT 1 FROM protected WHERE reason='artifact') AS retained_scope,
 EXISTS(SELECT 1 FROM protected WHERE reason='primary') AS primary_scope,
 EXISTS(SELECT 1 FROM protected WHERE reason='action') AS action_scope,
 EXISTS(SELECT 1 FROM protected WHERE id=(SELECT node_id FROM args) AND reason='artifact') AS retained_self,
 EXISTS(SELECT 1 FROM protected WHERE id=(SELECT node_id FROM args) AND reason='primary') AS primary_self,
 EXISTS(SELECT 1 FROM descendants WHERE id=(SELECT parent_id FROM descendants WHERE id=(SELECT node_id FROM args))) AS hierarchy_cycle,
 EXISTS(SELECT 1 FROM descendants WHERE parent_id=(SELECT node_id FROM args)) AS has_children,
 coalesce((SELECT jsonb_agg(t.target ORDER BY t.id) FROM (SELECT * FROM targets ORDER BY id LIMIT 3) t),'[]'::jsonb) AS targets,
 (SELECT count(*) FROM targets) AS targets_total
) SELECT to_jsonb(f)::jsonb AS payload FROM facts f;

-- name: ReadContainerOperationBasisTargets :one
WITH RECURSIVE args AS NOT MATERIALIZED (SELECT sqlc.arg(workspace_id)::uuid AS ws,sqlc.narg(project_id)::uuid AS project_id,sqlc.narg(module_id)::uuid AS module_id),
 retained AS (
 SELECT a.owner_node_id AS id,'artifact'::text AS reason FROM cockpit_artifact a,args x WHERE a.workspace_id=x.ws
 UNION SELECT d.node_id,'acceptance' FROM cockpit_acceptance_definition d,args x WHERE d.workspace_id=x.ws
 UNION SELECT r.node_id,'reference' FROM cockpit_artifact_node_reference r,args x WHERE r.workspace_id=x.ws AND r.removed_at IS NULL
), ancestors(root_id,id,parent_id,project_id,module_id) AS (
 SELECT r.id,n.id,n.parent_id,n.project_id,n.module_id FROM retained r JOIN cockpit_node n ON n.id=r.id AND n.workspace_id=(SELECT ws FROM args)
 UNION SELECT a.root_id,n.id,n.parent_id,n.project_id,n.module_id FROM ancestors a JOIN cockpit_node n ON n.id=a.parent_id AND n.workspace_id=(SELECT ws FROM args)
), matching AS (
 SELECT DISTINCT a.root_id AS id FROM ancestors a,args x WHERE (x.project_id IS NOT NULL AND a.project_id=x.project_id) OR (x.module_id IS NOT NULL AND a.module_id=x.module_id)
 UNION SELECT p.node_id FROM cockpit_issue_primary p JOIN issue i ON i.id=p.issue_id AND i.workspace_id=p.workspace_id,args x WHERE p.workspace_id=x.ws AND p.node_id IS NOT NULL AND ((x.project_id IS NOT NULL AND i.project_id=x.project_id) OR (x.module_id IS NOT NULL AND i.module_id=x.module_id))
), page AS (SELECT m.id,n.name FROM matching m JOIN cockpit_node n ON n.id=m.id AND n.workspace_id=(SELECT ws FROM args) ORDER BY m.id LIMIT 3)
SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(jsonb_build_object('kind','node','node_id',p.id,'view','details','label',p.name,'purpose','retained_scope') ORDER BY p.id) FROM page p),'[]'::jsonb),'total',(SELECT count(*) FROM matching))::jsonb AS payload;
