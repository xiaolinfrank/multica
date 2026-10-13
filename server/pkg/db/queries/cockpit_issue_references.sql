-- name: ReadCockpitIssueReferences :one
WITH args AS NOT MATERIALIZED (
 SELECT sqlc.arg('workspace_id')::uuid AS ws, sqlc.arg('issue_id')::uuid AS issue_id,
 sqlc.arg('kind')::text AS kind, sqlc.narg('cursor_id')::uuid AS cursor_id, sqlc.arg('page_size')::int AS page_size
), refs AS MATERIALIZED (
 SELECT l.node_id AS id FROM cockpit_node_issue l,args x
 WHERE x.kind='nodes' AND l.workspace_id=x.ws AND l.issue_id=x.issue_id
 AND NOT EXISTS(SELECT 1 FROM cockpit_issue_primary p WHERE p.workspace_id=x.ws AND p.issue_id=x.issue_id AND p.node_id=l.node_id)
 UNION ALL
 SELECT l.meeting_id AS id FROM cockpit_meeting_issue l,args x
 WHERE x.kind='meetings' AND l.workspace_id=x.ws AND l.issue_id=x.issue_id
), page AS (
 SELECT r.id FROM refs r,args x WHERE x.cursor_id IS NULL OR r.id>x.cursor_id
 ORDER BY r.id LIMIT (SELECT page_size+1 FROM args)
), items AS (
 SELECT p.id,jsonb_build_object('node_id',p.id,'code',COALESCE(n.code,''),'title',COALESCE(n.name,''),
 'available',n.id IS NOT NULL,'relation','reference','can_unlink',true) AS item
 FROM page p CROSS JOIN args x LEFT JOIN cockpit_node n ON n.workspace_id=x.ws AND n.id=p.id WHERE x.kind='nodes'
 UNION ALL
 SELECT p.id,jsonb_build_object('meeting_id',p.id,'code',COALESCE(m.code,''),'title',COALESCE(m.title,''),'meet_date',COALESCE(m.meet_date::text,''),
 'archived_at',m.archived_at,'available',m.id IS NOT NULL,'role',COALESCE(l.role,''),'roles',COALESCE(l.roles,ARRAY['preparation']::text[]),'required_roles',required.roles,'can_unlink',l.issue_id IS NOT NULL AND cardinality(required.roles)=0,
 'has_direct_reference',TRUE)
 FROM page p CROSS JOIN args x
 LEFT JOIN cockpit_meeting_issue l ON l.workspace_id=x.ws AND l.issue_id=x.issue_id AND l.meeting_id=p.id
 LEFT JOIN cockpit_meeting m ON m.workspace_id=x.ws AND m.id=p.id
 CROSS JOIN LATERAL (SELECT array_remove(ARRAY[
 CASE WHEN 'minutes'=ANY(l.roles) THEN 'minutes' END,
 CASE WHEN EXISTS(SELECT 1 FROM cockpit_minutes_version v WHERE v.workspace_id=x.ws AND v.meeting_id=p.id AND v.review_issue_id=x.issue_id)
 OR EXISTS(SELECT 1 FROM cockpit_reviewer_handoff h WHERE h.workspace_id=x.ws AND h.meeting_id=p.id AND (h.from_review_issue_id=x.issue_id OR h.to_review_issue_id=x.issue_id)) THEN 'review' END
 ]::text[],NULL)::text[] AS roles) required WHERE x.kind='meetings'
)
SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(item ORDER BY id) FROM items),'[]'::jsonb),
 'total',(SELECT count(*) FROM refs))::jsonb AS payload;

-- name: LockCockpitIssueNodeReference :one
SELECT id FROM cockpit_node_issue WHERE workspace_id=sqlc.arg('workspace_id')::uuid
 AND issue_id=sqlc.arg('issue_id')::uuid AND node_id=sqlc.arg('node_id')::uuid FOR UPDATE;

-- name: LockCockpitIssueMeetingReference :one
SELECT meeting_id FROM cockpit_meeting_issue WHERE workspace_id=sqlc.arg('workspace_id')::uuid
 AND issue_id=sqlc.arg('issue_id')::uuid AND meeting_id=sqlc.arg('meeting_id')::uuid FOR UPDATE;
