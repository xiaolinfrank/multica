-- name: ListCockpitIssueArtifactContexts :one
WITH args AS NOT MATERIALIZED (SELECT sqlc.arg(workspace_id)::uuid AS ws,sqlc.arg(issue_id)::uuid AS issue_id),
roles AS (
 SELECT 'artifact'::text AS kind,a.id,a.id AS artifact_id,NULL::uuid AS version_id,a.owner_node_id AS node_id,NULL::uuid AS request_id,'origin'::text AS role FROM cockpit_artifact a,args x WHERE a.workspace_id=x.ws AND a.source_issue_id=x.issue_id
 UNION ALL SELECT 'artifact',a.id,a.id,NULL::uuid,a.owner_node_id,NULL::uuid,'current_producer' FROM cockpit_artifact a,args x WHERE a.workspace_id=x.ws AND a.authorized_producer_issue_id=x.issue_id
 UNION ALL SELECT 'artifact',a.id,a.id,NULL::uuid,a.owner_node_id,NULL::uuid,'former_producer' FROM cockpit_artifact a,args x WHERE a.workspace_id=x.ws AND a.authorized_producer_issue_id<>x.issue_id AND EXISTS(SELECT 1 FROM cockpit_artifact_producer_assignment p WHERE p.workspace_id=x.ws AND p.artifact_id=a.id AND (p.from_issue_id=x.issue_id OR p.to_issue_id=x.issue_id))
 UNION ALL SELECT 'artifact_version',v.id,v.artifact_id,v.id,a.owner_node_id,NULL::uuid,'version_producer' FROM cockpit_artifact_version v JOIN cockpit_artifact a ON a.workspace_id=v.workspace_id AND a.id=v.artifact_id,args x WHERE v.workspace_id=x.ws AND v.producer_issue_id=x.issue_id
 UNION ALL SELECT 'artifact_version',v.id,v.artifact_id,v.id,a.owner_node_id,NULL::uuid,'review' FROM cockpit_artifact_version v JOIN cockpit_artifact a ON a.workspace_id=v.workspace_id AND a.id=v.artifact_id,args x WHERE v.workspace_id=x.ws AND v.review_issue_id=x.issue_id
 UNION ALL SELECT 'artifact_version',h.version_id,h.artifact_id,h.version_id,a.owner_node_id,NULL::uuid,'retired_review' FROM cockpit_artifact_reviewer_handoff h JOIN cockpit_artifact a ON a.workspace_id=h.workspace_id AND a.id=h.artifact_id,args x WHERE h.workspace_id=x.ws AND h.from_review_issue_id=x.issue_id
 UNION ALL SELECT 'acceptance_request',r.id,NULL::uuid,NULL::uuid,r.node_id,r.id,'acceptance_review' FROM cockpit_acceptance_request r,args x WHERE r.workspace_id=x.ws AND r.review_issue_id=x.issue_id
 UNION ALL SELECT 'acceptance_request',h.request_id,NULL::uuid,NULL::uuid,h.node_id,h.request_id,'retired_review' FROM cockpit_acceptance_reviewer_handoff h,args x WHERE h.workspace_id=x.ws AND h.from_review_issue_id=x.issue_id
), grouped AS MATERIALIZED (
 SELECT kind,id,artifact_id,version_id,node_id,request_id,array_agg(DISTINCT role ORDER BY role) AS roles,kind||':'||id::text AS sort_key
 FROM roles GROUP BY kind,id,artifact_id,version_id,node_id,request_id
), page AS (
 SELECT * FROM grouped WHERE sqlc.arg(cursor_key)::text='' OR sort_key>sqlc.arg(cursor_key) ORDER BY sort_key LIMIT sqlc.arg(page_limit)
), facts AS (
 SELECT p.*,coalesce(a.title,'') AS artifact_title,coalesce(n.name,'') AS node_label,v.version_number,coalesce(v.decision,r.decision,'') AS decision,coalesce(v.reviewer_id,r.reviewer_id) AS reviewer_id,
 CASE WHEN p.kind='artifact_version' THEN a.current_version_id=v.id AND v.decision='pending' AND v.review_issue_id=(SELECT issue_id FROM args)
 WHEN p.kind='acceptance_request' THEN r.decision='pending' AND r.superseded_at IS NULL AND r.review_issue_id=(SELECT issue_id FROM args) ELSE false END::boolean AS is_current_review
 FROM page p LEFT JOIN cockpit_artifact a ON a.workspace_id=(SELECT ws FROM args) AND a.id=p.artifact_id
 LEFT JOIN cockpit_artifact_version v ON v.workspace_id=(SELECT ws FROM args) AND v.id=p.version_id
 LEFT JOIN cockpit_acceptance_request r ON r.workspace_id=(SELECT ws FROM args) AND r.id=p.request_id
 LEFT JOIN cockpit_node n ON n.workspace_id=(SELECT ws FROM args) AND n.id=p.node_id
)
SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(f ORDER BY sort_key) FROM facts f),'[]'::jsonb),'total',(SELECT count(*) FROM grouped),
 'formal_review',(SELECT jsonb_build_object('kind',g.kind,'stage',cockpit_artifact_review_stage(x.ws,x.issue_id),'node_id',g.node_id,'artifact_id',g.artifact_id,'version_id',g.version_id,'request_id',g.request_id)
 FROM grouped g CROSS JOIN args x WHERE g.roles && ARRAY['review','retired_review','acceptance_review']::text[] ORDER BY g.kind,g.id LIMIT 1))::jsonb AS payload;
