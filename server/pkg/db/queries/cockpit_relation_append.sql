-- name: AppendCockpitNodeIssue :exec
INSERT INTO cockpit_node_issue (workspace_id,node_id,issue_id,position)
VALUES (sqlc.arg('workspace_id')::uuid,sqlc.arg('node_id')::uuid,sqlc.arg('issue_id')::uuid,0)
ON CONFLICT (node_id,issue_id) DO NOTHING;

-- name: GetCockpitNodeIssueLink :one
SELECT l.id,l.node_id,l.issue_id,l.position,
 i.number AS issue_number,i.title AS issue_title,i.status AS issue_status
FROM cockpit_node_issue l
JOIN cockpit_node n ON n.id=l.node_id AND n.workspace_id=l.workspace_id
JOIN issue i ON i.id=l.issue_id AND i.workspace_id=l.workspace_id
WHERE l.workspace_id=sqlc.arg('workspace_id')::uuid
 AND l.node_id=sqlc.arg('node_id')::uuid AND l.issue_id=sqlc.arg('issue_id')::uuid;

-- name: AppendCockpitMeetingIssue :exec
INSERT INTO cockpit_meeting_issue (workspace_id,meeting_id,issue_id,role,position)
VALUES (sqlc.arg('workspace_id')::uuid,sqlc.arg('meeting_id')::uuid,sqlc.arg('issue_id')::uuid,'',0)
ON CONFLICT (meeting_id,issue_id) DO NOTHING;

-- name: GetCockpitMeetingIssueLink :one
SELECT l.meeting_id,l.issue_id,l.role,l.roles,l.position,
 array_remove(ARRAY[
  CASE WHEN 'minutes'=ANY(l.roles) THEN 'minutes' END,
  CASE WHEN EXISTS(SELECT 1 FROM cockpit_minutes_version v WHERE v.workspace_id=l.workspace_id AND v.meeting_id=l.meeting_id AND v.review_issue_id=l.issue_id)
    OR EXISTS(SELECT 1 FROM cockpit_reviewer_handoff h WHERE h.workspace_id=l.workspace_id AND h.meeting_id=l.meeting_id AND (h.from_review_issue_id=l.issue_id OR h.to_review_issue_id=l.issue_id)) THEN 'review' END
 ]::text[],NULL)::text[] AS required_roles,
 i.number AS issue_number,i.title AS issue_title,i.status AS issue_status
FROM cockpit_meeting_issue l
JOIN cockpit_meeting m ON m.id=l.meeting_id AND m.workspace_id=l.workspace_id
JOIN issue i ON i.id=l.issue_id AND i.workspace_id=l.workspace_id
WHERE l.workspace_id=sqlc.arg('workspace_id')::uuid
 AND l.meeting_id=sqlc.arg('meeting_id')::uuid AND l.issue_id=sqlc.arg('issue_id')::uuid;

-- name: AppendCockpitMeetingNode :exec
INSERT INTO cockpit_meeting_node (workspace_id,meeting_id,node_id,position)
VALUES (sqlc.arg('workspace_id')::uuid,sqlc.arg('meeting_id')::uuid,sqlc.arg('node_id')::uuid,0)
ON CONFLICT (meeting_id,node_id) DO NOTHING;

-- name: GetCockpitMeetingNodeLink :one
SELECT l.meeting_id,l.node_id,l.position
FROM cockpit_meeting_node l
JOIN cockpit_meeting m ON m.id=l.meeting_id AND m.workspace_id=l.workspace_id
JOIN cockpit_node n ON n.id=l.node_id AND n.workspace_id=l.workspace_id
WHERE l.workspace_id=sqlc.arg('workspace_id')::uuid
 AND l.meeting_id=sqlc.arg('meeting_id')::uuid AND l.node_id=sqlc.arg('node_id')::uuid;
