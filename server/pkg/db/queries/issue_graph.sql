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

-- name: ListIssueGraphExecNodes :many
-- Level-3 cockpit nodes (the execution gantt's leaf rows) join the graph as
-- execution nodes. Depth is resolved through the parent chain rather than a
-- column: an L3 row's grandparent is a root L1 row (parent_id IS NULL), which
-- excludes L1/L2 rows above and any deeper L4 rows below.
SELECT n.id, n.code, n.name, n.status, n.progress, n.start_date, n.end_date, n.owner
FROM cockpit_node n
JOIN cockpit_node p2 ON p2.id = n.parent_id
JOIN cockpit_node p1 ON p1.id = p2.parent_id AND p1.parent_id IS NULL
WHERE n.workspace_id = $1
ORDER BY n.position ASC, n.code ASC;

-- name: ListIssueGraphExecNodeIssues :many
-- L3 node↔issue links (the gantt row's work items). Endpoints are
-- re-validated against the visible issue node set in the handler.
SELECT ni.node_id, ni.issue_id
FROM cockpit_node_issue ni
JOIN cockpit_node n ON n.id = ni.node_id
JOIN cockpit_node p2 ON p2.id = n.parent_id
JOIN cockpit_node p1 ON p1.id = p2.parent_id AND p1.parent_id IS NULL
WHERE ni.workspace_id = $1;

-- name: ListIssueGraphExecNodeMeetings :many
-- Meeting↔L3-node links (the meeting's agenda rows on the gantt), rendered as
-- meeting-kind edges from the meeting to the execution node.
SELECT mn.meeting_id, mn.node_id
FROM cockpit_meeting_node mn
JOIN cockpit_node n ON n.id = mn.node_id
JOIN cockpit_node p2 ON p2.id = n.parent_id
JOIN cockpit_node p1 ON p1.id = p2.parent_id AND p1.parent_id IS NULL
WHERE mn.workspace_id = $1;

-- name: ListIssueGraphCockpitNodeIndex :many
-- Slim (id, code, parent, position) index of the whole cockpit board. The
-- client rebuilds the tree from it to derive each execution row's POSITIONAL
-- row code (the "06.02.01" the gantt shows) — stored codes are the
-- programme's own addresses and drift out of sync with position, so the graph
-- labels rows the way the gantt does. Always the full tree, project scope
-- included: a row's number counts siblings that the scope may hide.
SELECT n.id, n.code, n.parent_id, n.position
FROM cockpit_node n
WHERE n.workspace_id = $1;
