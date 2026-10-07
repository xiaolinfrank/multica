-- Read-side queries for the issue graph endpoint (GET /api/issues/graph).
-- The graph is served as one whole-workspace snapshot: nodes are issues
-- (slimmed columns; filtering and layout happen client-side), edges are the
-- three issue-to-issue relations the product tracks:
--   child     — issue.parent_issue_id (source=parent, target=child)
--   blocks / blocked_by / related — issue_dependency rows, passed through
--   mention   — issue references extracted from issue descriptions and
--               comment bodies at read time (no persisted index)

-- name: ListIssueGraphNodes :many
-- Whole-workspace node set. Unlike ListIssues there is no LIMIT: the graph is
-- only useful as the full picture, and workspace issue counts stay in the
-- thousands (the same bet ListOpenIssues makes). An optional project_id narrows
-- the snapshot to one project; cross-project edges are dropped in the handler.
-- description rides along only to extract mention references. assignee_type
-- and assignee_id ride along to label nodes with their assignee display name
-- (resolved in the handler through the workspace member/agent lists).
SELECT i.id, i.number, i.title, i.description, i.status, i.priority,
       i.project_id, i.parent_issue_id, i.updated_at,
       i.assignee_type, i.assignee_id
FROM issue i
WHERE i.workspace_id = $1
  AND (sqlc.narg('project_id')::uuid IS NULL OR i.project_id = sqlc.narg('project_id')::uuid)
ORDER BY i.created_at ASC;

-- name: ListIssueGraphDependencies :many
-- issue_dependency has no workspace_id column of its own, so tenancy is
-- resolved through the referencing issue. Both endpoints of a dependency row
-- are re-validated against the visible node set in the handler.
SELECT d.issue_id, d.depends_on_issue_id, d.type
FROM issue_dependency d
JOIN issue i ON i.id = d.issue_id
WHERE i.workspace_id = $1;

-- name: ListIssueGraphCommentBodies :many
-- Raw comment text for mention extraction. All comment types are included:
-- agent progress and system comments carry markdown bodies that may reference
-- issues just like human comments do.
SELECT c.issue_id, c.content
FROM comment c
JOIN issue i ON i.id = c.issue_id
WHERE i.workspace_id = $1;

-- name: ListIssueIDsByNumbers :many
-- Batch-resolves bare identifiers (PREFIX-<number>) to issue UUIDs for the
-- current workspace only. Callers must have already checked the identifier
-- prefix against the workspace issue prefix; the (workspace_id, number)
-- unique index makes this lookup exact.
SELECT i.id, i.number
FROM issue i
WHERE i.workspace_id = $1
  AND i.number = ANY($2::int[]);

-- name: ListIssueGraphMeetings :many
-- Meetings of the workspace's cockpit board, rendered as meeting nodes in the
-- graph. Empty for a workspace without a board. nas_dir is the meeting's
-- folder on the shared storage (empty = never provisioned).
SELECT cm.id, cm.code, cm.title, cm.meet_date, cm.status, cm.track, cm.nas_dir
FROM cockpit_meeting cm
JOIN cockpit c ON c.id = cm.cockpit_id
WHERE c.workspace_id = $1
ORDER BY cm.meet_date ASC, cm.code ASC;

-- name: ListIssueGraphMeetingIssues :many
-- Meeting↔issue links, both the meeting's own provisioned task (role='task')
-- and hand-attached ones (role=''). Endpoints are re-validated against the
-- visible issue node set in the handler.
SELECT cmi.meeting_id, cmi.issue_id, cmi.role
FROM cockpit_meeting_issue cmi
WHERE cmi.workspace_id = $1;

-- name: ListIssueGraphRuns :many
-- Execution nodes for the graph: the latest TERMINAL run per issue (the last
-- completed/failed/cancelled — "what last happened on this task") plus EVERY
-- active run (queued/dispatched/running — "what is happening now"), so a task
-- mid-rerun shows both its last outcome and the in-flight attempt. History
-- beyond that is deliberately not graphed — a workspace's queue table grows
-- without bound, the graph does not. issue_id is nullable on the queue (chat
-- tasks); the JOIN both enforces tenancy and drops issue-less rows.
WITH terminal AS (
  SELECT q.id, q.issue_id, q.agent_id, q.status, q.started_at, q.completed_at,
         q.trigger_comment_id, q.created_at,
         ROW_NUMBER() OVER (PARTITION BY q.issue_id ORDER BY q.created_at DESC) AS rn
  FROM agent_task_queue q
  JOIN issue i ON i.id = q.issue_id
  WHERE i.workspace_id = $1
    AND q.status IN ('completed', 'failed', 'cancelled')
),
active AS (
  SELECT q.id, q.issue_id, q.agent_id, q.status, q.started_at, q.completed_at,
         q.trigger_comment_id, q.created_at, 0 AS rn
  FROM agent_task_queue q
  JOIN issue i ON i.id = q.issue_id
  WHERE i.workspace_id = $1
    AND q.status IN ('queued', 'dispatched', 'running')
)
SELECT r.id, r.issue_id, r.status, r.started_at, r.completed_at, r.trigger_comment_id,
       a.name AS agent_name
FROM (SELECT id, issue_id, agent_id, status, started_at, completed_at,
             trigger_comment_id, created_at FROM terminal WHERE rn = 1
      UNION ALL
      SELECT id, issue_id, agent_id, status, started_at, completed_at,
             trigger_comment_id, created_at FROM active) r
JOIN agent a ON a.id = r.agent_id
ORDER BY r.created_at DESC;
