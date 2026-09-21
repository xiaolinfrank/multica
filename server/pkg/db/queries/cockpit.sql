-- Project cockpit (BayClaw fork). One board per workspace: a work-breakdown
-- tree, its instalment plan, its milestones, its meeting log, and the links
-- from a work item to the issues that carry it out.
--
-- Every statement filters by workspace_id even when the id alone would be
-- unique. A cockpit is programme-level planning data; a query that could read
-- across workspaces because a UUID leaked is not one worth having.

-- name: GetCockpitByWorkspace :one
SELECT * FROM cockpit
WHERE workspace_id = sqlc.arg('workspace_id')::uuid;

-- name: CreateCockpit :one
-- Lazily created on first read. ON CONFLICT makes two pods racing the same
-- first visit a no-op for the loser rather than a 500.
INSERT INTO cockpit (workspace_id, title, goal_title, goal_date, basis)
VALUES (
    sqlc.arg('workspace_id')::uuid,
    sqlc.arg('title')::text,
    sqlc.arg('goal_title')::text,
    sqlc.narg('goal_date')::date,
    sqlc.arg('basis')::text
)
ON CONFLICT (workspace_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id
RETURNING *;

-- name: UpdateCockpit :one
-- COALESCE on a nullable arg is the partial-update idiom used across this
-- schema: an omitted field arrives NULL and leaves the column untouched.
UPDATE cockpit SET
    title           = COALESCE(sqlc.narg('title')::text, title),
    goal_title      = COALESCE(sqlc.narg('goal_title')::text, goal_title),
    goal_date       = CASE WHEN sqlc.arg('clear_goal_date')::bool THEN NULL
                           ELSE COALESCE(sqlc.narg('goal_date')::date, goal_date) END,
    summary_overall = COALESCE(sqlc.narg('summary_overall')::text, summary_overall),
    summary_next    = COALESCE(sqlc.narg('summary_next')::text, summary_next),
    summary_support = COALESCE(sqlc.narg('summary_support')::text, summary_support),
    basis           = COALESCE(sqlc.narg('basis')::text, basis),
    -- Where a new meeting's task and folder go. Cleared explicitly (the
    -- clear_* flags) rather than by sending NULL, which the COALESCE idiom
    -- above reads as "leave it alone".
    meeting_project_id = CASE WHEN sqlc.arg('clear_meeting_project')::bool THEN NULL
                              ELSE COALESCE(sqlc.narg('meeting_project_id')::uuid, meeting_project_id) END,
    meeting_module_id  = CASE WHEN sqlc.arg('clear_meeting_module')::bool THEN NULL
                              ELSE COALESCE(sqlc.narg('meeting_module_id')::uuid, meeting_module_id) END,
    meeting_node_id    = CASE WHEN sqlc.arg('clear_meeting_node')::bool THEN NULL
                              ELSE COALESCE(sqlc.narg('meeting_node_id')::uuid, meeting_node_id) END,
    meeting_dir        = COALESCE(sqlc.narg('meeting_dir')::text, meeting_dir),
    updated_at      = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
RETURNING *;

-- name: ListCockpitNodes :many
-- The whole tree in render order. Depth is derived client-side by walking
-- parent_id, so a node moved between levels needs no column rewrite.
SELECT * FROM cockpit_node
WHERE cockpit_id = sqlc.arg('cockpit_id')::uuid
ORDER BY position, code;

-- name: GetCockpitNode :one
SELECT * FROM cockpit_node
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid;

-- name: GetCockpitNodeByCode :one
SELECT * FROM cockpit_node
WHERE cockpit_id = sqlc.arg('cockpit_id')::uuid
  AND code = sqlc.arg('code')::text;

-- name: CreateCockpitNode :one
INSERT INTO cockpit_node (
    workspace_id, cockpit_id, parent_id, code, name, position, color,
    owner, collaborators, start_date, end_date, status, progress,
    deliverable, dependencies, note, current_progress, vendor,
    budget_category, budget_amount, exec_status, contract, source,
    updated_by_type, updated_by_id
) VALUES (
    sqlc.arg('workspace_id')::uuid,
    sqlc.arg('cockpit_id')::uuid,
    sqlc.narg('parent_id')::uuid,
    sqlc.arg('code')::text,
    sqlc.arg('name')::text,
    sqlc.arg('position')::double precision,
    sqlc.arg('color')::text,
    sqlc.arg('owner')::text,
    sqlc.arg('collaborators')::text,
    sqlc.narg('start_date')::date,
    sqlc.narg('end_date')::date,
    sqlc.arg('status')::text,
    sqlc.arg('progress')::double precision,
    sqlc.arg('deliverable')::text,
    sqlc.arg('dependencies')::text,
    sqlc.arg('note')::text,
    sqlc.arg('current_progress')::text,
    sqlc.arg('vendor')::text,
    sqlc.arg('budget_category')::text,
    sqlc.narg('budget_amount')::numeric,
    sqlc.arg('exec_status')::text,
    sqlc.arg('contract')::text,
    sqlc.arg('source')::text,
    sqlc.arg('updated_by_type')::text,
    sqlc.narg('updated_by_id')::uuid
)
RETURNING *;

-- name: UpdateCockpitNode :one
-- `clear_start_date` / `clear_end_date` / `clear_budget_amount` exist because
-- NULL is already spoken for by "field omitted". Emptying a date is a real
-- edit — a task whose planned end is withdrawn is not a task whose end is
-- unchanged — so it gets its own flag rather than an in-band sentinel.
UPDATE cockpit_node SET
    parent_id        = CASE WHEN sqlc.arg('clear_parent')::bool THEN NULL
                            ELSE COALESCE(sqlc.narg('parent_id')::uuid, parent_id) END,
    code             = COALESCE(sqlc.narg('code')::text, code),
    name             = COALESCE(sqlc.narg('name')::text, name),
    position         = COALESCE(sqlc.narg('position')::double precision, position),
    color            = COALESCE(sqlc.narg('color')::text, color),
    owner            = COALESCE(sqlc.narg('owner')::text, owner),
    collaborators    = COALESCE(sqlc.narg('collaborators')::text, collaborators),
    start_date       = CASE WHEN sqlc.arg('clear_start_date')::bool THEN NULL
                            ELSE COALESCE(sqlc.narg('start_date')::date, start_date) END,
    end_date         = CASE WHEN sqlc.arg('clear_end_date')::bool THEN NULL
                            ELSE COALESCE(sqlc.narg('end_date')::date, end_date) END,
    status           = COALESCE(sqlc.narg('status')::text, status),
    progress         = COALESCE(sqlc.narg('progress')::double precision, progress),
    deliverable      = COALESCE(sqlc.narg('deliverable')::text, deliverable),
    dependencies     = COALESCE(sqlc.narg('dependencies')::text, dependencies),
    note             = COALESCE(sqlc.narg('note')::text, note),
    current_progress = COALESCE(sqlc.narg('current_progress')::text, current_progress),
    vendor           = COALESCE(sqlc.narg('vendor')::text, vendor),
    budget_category  = COALESCE(sqlc.narg('budget_category')::text, budget_category),
    budget_amount    = CASE WHEN sqlc.arg('clear_budget_amount')::bool THEN NULL
                            ELSE COALESCE(sqlc.narg('budget_amount')::numeric, budget_amount) END,
    exec_status      = COALESCE(sqlc.narg('exec_status')::text, exec_status),
    contract         = COALESCE(sqlc.narg('contract')::text, contract),
    source           = COALESCE(sqlc.narg('source')::text, source),
    updated_by_type  = sqlc.arg('updated_by_type')::text,
    updated_by_id    = sqlc.narg('updated_by_id')::uuid,
    updated_at       = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
RETURNING *;

-- name: DeleteCockpitNode :exec
DELETE FROM cockpit_node
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid;

-- name: ListCockpitNodeChildIDs :many
-- Used to refuse deleting a branch that still has children, so a mis-typed
-- delete cannot orphan half the board.
SELECT id FROM cockpit_node
WHERE cockpit_id = sqlc.arg('cockpit_id')::uuid
  AND parent_id = sqlc.arg('parent_id')::uuid;

-- name: DeleteCockpitNodes :exec
-- Used only by import, which replaces the whole board in one transaction.
DELETE FROM cockpit_node WHERE cockpit_id = sqlc.arg('cockpit_id')::uuid;

-- name: ListCockpitPayments :many
SELECT p.* FROM cockpit_payment p
JOIN cockpit_node n ON n.id = p.node_id
WHERE n.cockpit_id = sqlc.arg('cockpit_id')::uuid
ORDER BY p.position, p.pay_date;

-- name: CreateCockpitPayment :one
INSERT INTO cockpit_payment (workspace_id, node_id, label, pay_date, amount, position)
VALUES (
    sqlc.arg('workspace_id')::uuid,
    sqlc.arg('node_id')::uuid,
    sqlc.arg('label')::text,
    sqlc.narg('pay_date')::date,
    sqlc.arg('amount')::numeric,
    sqlc.arg('position')::double precision
)
RETURNING *;

-- name: UpdateCockpitPayment :one
UPDATE cockpit_payment SET
    label      = COALESCE(sqlc.narg('label')::text, label),
    pay_date   = CASE WHEN sqlc.arg('clear_pay_date')::bool THEN NULL
                      ELSE COALESCE(sqlc.narg('pay_date')::date, pay_date) END,
    amount     = COALESCE(sqlc.narg('amount')::numeric, amount),
    position   = COALESCE(sqlc.narg('position')::double precision, position),
    updated_at = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
RETURNING *;

-- name: DeleteCockpitPayment :exec
DELETE FROM cockpit_payment
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid;

-- name: DeleteCockpitPaymentsByNode :exec
DELETE FROM cockpit_payment
WHERE node_id = sqlc.arg('node_id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid;

-- name: ListCockpitNodeIssues :many
-- Joined to issue so a link to a deleted issue simply stops being returned —
-- there is no foreign key to have cascaded it away (repository rule).
SELECT
    l.id, l.node_id, l.issue_id, l.position,
    i.number AS issue_number,
    i.title  AS issue_title,
    i.status AS issue_status
FROM cockpit_node_issue l
JOIN cockpit_node n ON n.id = l.node_id
JOIN issue i ON i.id = l.issue_id AND i.workspace_id = l.workspace_id
WHERE n.cockpit_id = sqlc.arg('cockpit_id')::uuid
ORDER BY l.position, i.number;

-- name: CreateCockpitNodeIssue :one
INSERT INTO cockpit_node_issue (workspace_id, node_id, issue_id, position)
VALUES (
    sqlc.arg('workspace_id')::uuid,
    sqlc.arg('node_id')::uuid,
    sqlc.arg('issue_id')::uuid,
    sqlc.arg('position')::double precision
)
ON CONFLICT (node_id, issue_id) DO UPDATE SET position = EXCLUDED.position
RETURNING *;

-- name: DeleteCockpitNodeIssue :exec
DELETE FROM cockpit_node_issue
WHERE node_id = sqlc.arg('node_id')::uuid
  AND issue_id = sqlc.arg('issue_id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid;

-- name: DeleteCockpitNodeIssuesByNode :exec
DELETE FROM cockpit_node_issue
WHERE node_id = sqlc.arg('node_id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid;

-- name: ListCockpitMilestones :many
SELECT * FROM cockpit_milestone
WHERE cockpit_id = sqlc.arg('cockpit_id')::uuid
ORDER BY position, plan_date;

-- name: CreateCockpitMilestone :one
INSERT INTO cockpit_milestone (
    workspace_id, cockpit_id, name, plan_date, actual_date, status,
    node_id, condition, guard, position
) VALUES (
    sqlc.arg('workspace_id')::uuid,
    sqlc.arg('cockpit_id')::uuid,
    sqlc.arg('name')::text,
    sqlc.narg('plan_date')::date,
    sqlc.narg('actual_date')::date,
    sqlc.arg('status')::text,
    sqlc.narg('node_id')::uuid,
    sqlc.arg('condition')::text,
    sqlc.arg('guard')::text,
    sqlc.arg('position')::double precision
)
RETURNING *;

-- name: UpdateCockpitMilestone :one
UPDATE cockpit_milestone SET
    name        = COALESCE(sqlc.narg('name')::text, name),
    plan_date   = CASE WHEN sqlc.arg('clear_plan_date')::bool THEN NULL
                       ELSE COALESCE(sqlc.narg('plan_date')::date, plan_date) END,
    actual_date = CASE WHEN sqlc.arg('clear_actual_date')::bool THEN NULL
                       ELSE COALESCE(sqlc.narg('actual_date')::date, actual_date) END,
    status      = COALESCE(sqlc.narg('status')::text, status),
    node_id     = CASE WHEN sqlc.arg('clear_node')::bool THEN NULL
                       ELSE COALESCE(sqlc.narg('node_id')::uuid, node_id) END,
    condition   = COALESCE(sqlc.narg('condition')::text, condition),
    guard       = COALESCE(sqlc.narg('guard')::text, guard),
    position    = COALESCE(sqlc.narg('position')::double precision, position),
    updated_at  = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
RETURNING *;

-- name: DeleteCockpitMilestone :exec
DELETE FROM cockpit_milestone
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid;

-- name: DeleteCockpitMilestones :exec
DELETE FROM cockpit_milestone WHERE cockpit_id = sqlc.arg('cockpit_id')::uuid;

-- name: ListCockpitMeetings :many
-- Newest first, which is what a register reads as. start_time orders the
-- meetings of one day; time_range is the tiebreak for rows that only ever
-- carried free text (see migration 929).
SELECT * FROM cockpit_meeting
WHERE cockpit_id = sqlc.arg('cockpit_id')::uuid
ORDER BY meet_date DESC NULLS LAST, start_time DESC NULLS LAST, time_range DESC;

-- name: GetCockpitMeeting :one
SELECT * FROM cockpit_meeting
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid;

-- name: CreateCockpitMeeting :one
INSERT INTO cockpit_meeting (
    workspace_id, cockpit_id, meet_date, time_range, title,
    attendees, meet_no, link, note,
    code, kind, status, series, parties, organizer, location,
    start_time, end_time, minutes, decisions, actions, nas_dir, detected
) VALUES (
    sqlc.arg('workspace_id')::uuid,
    sqlc.arg('cockpit_id')::uuid,
    sqlc.narg('meet_date')::date,
    sqlc.arg('time_range')::text,
    sqlc.arg('title')::text,
    sqlc.arg('attendees')::text,
    sqlc.arg('meet_no')::text,
    sqlc.arg('link')::text,
    sqlc.arg('note')::text,
    sqlc.arg('code')::text,
    sqlc.arg('kind')::text,
    sqlc.arg('status')::text,
    sqlc.arg('series')::text,
    sqlc.arg('parties')::text,
    sqlc.arg('organizer')::text,
    sqlc.arg('location')::text,
    sqlc.narg('start_time')::time,
    sqlc.narg('end_time')::time,
    sqlc.arg('minutes')::text,
    sqlc.arg('decisions')::text,
    sqlc.arg('actions')::text,
    sqlc.arg('nas_dir')::text,
    sqlc.arg('detected')::bool
)
RETURNING *;

-- name: UpdateCockpitMeeting :one
UPDATE cockpit_meeting SET
    meet_date  = CASE WHEN sqlc.arg('clear_meet_date')::bool THEN NULL
                      ELSE COALESCE(sqlc.narg('meet_date')::date, meet_date) END,
    time_range = COALESCE(sqlc.narg('time_range')::text, time_range),
    title      = COALESCE(sqlc.narg('title')::text, title),
    attendees  = COALESCE(sqlc.narg('attendees')::text, attendees),
    meet_no    = COALESCE(sqlc.narg('meet_no')::text, meet_no),
    link       = COALESCE(sqlc.narg('link')::text, link),
    note       = COALESCE(sqlc.narg('note')::text, note),
    code       = COALESCE(sqlc.narg('code')::text, code),
    kind       = COALESCE(sqlc.narg('kind')::text, kind),
    status     = COALESCE(sqlc.narg('status')::text, status),
    series     = COALESCE(sqlc.narg('series')::text, series),
    parties    = COALESCE(sqlc.narg('parties')::text, parties),
    organizer  = COALESCE(sqlc.narg('organizer')::text, organizer),
    location   = COALESCE(sqlc.narg('location')::text, location),
    start_time = CASE WHEN sqlc.arg('clear_start_time')::bool THEN NULL
                      ELSE COALESCE(sqlc.narg('start_time')::time, start_time) END,
    end_time   = CASE WHEN sqlc.arg('clear_end_time')::bool THEN NULL
                      ELSE COALESCE(sqlc.narg('end_time')::time, end_time) END,
    minutes    = COALESCE(sqlc.narg('minutes')::text, minutes),
    decisions  = COALESCE(sqlc.narg('decisions')::text, decisions),
    actions    = COALESCE(sqlc.narg('actions')::text, actions),
    nas_dir    = COALESCE(sqlc.narg('nas_dir')::text, nas_dir),
    detected   = COALESCE(sqlc.narg('detected')::bool, detected),
    updated_at = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
RETURNING *;

-- name: DeleteCockpitMeeting :exec
DELETE FROM cockpit_meeting
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid;

-- name: DeleteCockpitMeetings :exec
DELETE FROM cockpit_meeting WHERE cockpit_id = sqlc.arg('cockpit_id')::uuid;

-- ---------------------------------------------------------------------------
-- What a meeting is attached to
-- ---------------------------------------------------------------------------

-- name: ListCockpitMeetingIssues :many
-- Joined to issue so a link to a deleted issue simply stops being returned —
-- there is no foreign key to have cascaded it away (repository rule). Joined
-- to cockpit_meeting so one read serves the whole board.
SELECT
    l.meeting_id, l.issue_id, l.role, l.position,
    i.number AS issue_number,
    i.title  AS issue_title,
    i.status AS issue_status
FROM cockpit_meeting_issue l
JOIN cockpit_meeting m ON m.id = l.meeting_id
JOIN issue i ON i.id = l.issue_id AND i.workspace_id = l.workspace_id
WHERE m.cockpit_id = sqlc.arg('cockpit_id')::uuid
ORDER BY l.position, i.number;

-- name: CreateCockpitMeetingIssue :one
INSERT INTO cockpit_meeting_issue (workspace_id, meeting_id, issue_id, role, position)
VALUES (
    sqlc.arg('workspace_id')::uuid,
    sqlc.arg('meeting_id')::uuid,
    sqlc.arg('issue_id')::uuid,
    sqlc.arg('role')::text,
    sqlc.arg('position')::double precision
)
ON CONFLICT (meeting_id, issue_id) DO UPDATE SET
    role = EXCLUDED.role, position = EXCLUDED.position
RETURNING *;

-- name: DeleteCockpitMeetingIssue :exec
DELETE FROM cockpit_meeting_issue
WHERE meeting_id = sqlc.arg('meeting_id')::uuid
  AND issue_id = sqlc.arg('issue_id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid;

-- name: DeleteCockpitMeetingIssuesByMeeting :exec
DELETE FROM cockpit_meeting_issue
WHERE meeting_id = sqlc.arg('meeting_id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid;

-- name: DeleteCockpitMeetingIssuesByCockpit :exec
-- Import only: clears the board's meeting links before the meetings that own
-- them are replaced. There is no cascade to do it (repository rule).
DELETE FROM cockpit_meeting_issue
WHERE meeting_id IN (SELECT id FROM cockpit_meeting WHERE cockpit_id = sqlc.arg('cockpit_id')::uuid);

-- name: ListCockpitMeetingNodes :many
-- Joined to cockpit_node so a link to a deleted work item stops being
-- returned, same contract as the issue links above.
SELECT l.meeting_id, l.node_id, l.position
FROM cockpit_meeting_node l
JOIN cockpit_meeting m ON m.id = l.meeting_id
JOIN cockpit_node n ON n.id = l.node_id
WHERE m.cockpit_id = sqlc.arg('cockpit_id')::uuid
ORDER BY l.position, n.code;

-- name: CreateCockpitMeetingNode :one
INSERT INTO cockpit_meeting_node (workspace_id, meeting_id, node_id, position)
VALUES (
    sqlc.arg('workspace_id')::uuid,
    sqlc.arg('meeting_id')::uuid,
    sqlc.arg('node_id')::uuid,
    sqlc.arg('position')::double precision
)
ON CONFLICT (meeting_id, node_id) DO UPDATE SET position = EXCLUDED.position
RETURNING *;

-- name: DeleteCockpitMeetingNode :exec
DELETE FROM cockpit_meeting_node
WHERE meeting_id = sqlc.arg('meeting_id')::uuid
  AND node_id = sqlc.arg('node_id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid;

-- name: DeleteCockpitMeetingNodesByMeeting :exec
DELETE FROM cockpit_meeting_node
WHERE meeting_id = sqlc.arg('meeting_id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid;

-- name: DeleteCockpitMeetingNodesByNode :exec
-- A deleted work item takes its meeting links with it; nothing cascades.
DELETE FROM cockpit_meeting_node
WHERE node_id = sqlc.arg('node_id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid;

-- name: DeleteCockpitMeetingNodesByCockpit :exec
-- Import only, same reason as DeleteCockpitMeetingIssuesByCockpit.
DELETE FROM cockpit_meeting_node
WHERE meeting_id IN (SELECT id FROM cockpit_meeting WHERE cockpit_id = sqlc.arg('cockpit_id')::uuid);

-- name: DeleteCockpitPaymentsByCockpit :exec
-- Import only: clears the board's instalments before the nodes that own them
-- are replaced. There is no cascade to do it (repository rule).
DELETE FROM cockpit_payment
WHERE node_id IN (SELECT id FROM cockpit_node WHERE cockpit_id = sqlc.arg('cockpit_id')::uuid);

-- name: DeleteCockpitNodeIssuesByCockpit :exec
-- Import only, same reason as DeleteCockpitPaymentsByCockpit.
DELETE FROM cockpit_node_issue
WHERE node_id IN (SELECT id FROM cockpit_node WHERE cockpit_id = sqlc.arg('cockpit_id')::uuid);

-- name: DeleteWorkspaceCockpitData :exec
-- Workspace teardown. One statement with data-modifying CTEs so the whole board
-- goes in a single round trip; there are no foreign keys to cascade it
-- (repository rule), and every cockpit table carries workspace_id for exactly
-- this sweep.
WITH del_changes AS (
    DELETE FROM cockpit_pending_change WHERE workspace_id = sqlc.arg('workspace_id')::uuid
), del_snapshots AS (
    DELETE FROM cockpit_snapshot WHERE workspace_id = sqlc.arg('workspace_id')::uuid
), del_links AS (
    DELETE FROM cockpit_node_issue WHERE workspace_id = sqlc.arg('workspace_id')::uuid
), del_meeting_issues AS (
    DELETE FROM cockpit_meeting_issue WHERE workspace_id = sqlc.arg('workspace_id')::uuid
), del_meeting_nodes AS (
    DELETE FROM cockpit_meeting_node WHERE workspace_id = sqlc.arg('workspace_id')::uuid
), del_payments AS (
    DELETE FROM cockpit_payment WHERE workspace_id = sqlc.arg('workspace_id')::uuid
), del_milestones AS (
    DELETE FROM cockpit_milestone WHERE workspace_id = sqlc.arg('workspace_id')::uuid
), del_meetings AS (
    DELETE FROM cockpit_meeting WHERE workspace_id = sqlc.arg('workspace_id')::uuid
), del_nodes AS (
    DELETE FROM cockpit_node WHERE workspace_id = sqlc.arg('workspace_id')::uuid
)
DELETE FROM cockpit WHERE workspace_id = sqlc.arg('workspace_id')::uuid;

-- name: CreateCockpitSnapshot :one
INSERT INTO cockpit_snapshot (
    workspace_id, cockpit_id, trigger_kind, label, payload, node_count,
    created_by_type, created_by_label
) VALUES (
    sqlc.arg('workspace_id')::uuid,
    sqlc.arg('cockpit_id')::uuid,
    sqlc.arg('trigger_kind')::text,
    sqlc.arg('label')::text,
    sqlc.arg('payload')::jsonb,
    sqlc.arg('node_count')::int,
    sqlc.arg('created_by_type')::text,
    sqlc.arg('created_by_label')::text
)
RETURNING *;

-- name: ListCockpitSnapshots :many
-- Metadata only: the payload is the whole board as JSON, and a version list
-- that dragged a few hundred kilobytes per row would be the heaviest read on
-- the board.
SELECT
    id, workspace_id, cockpit_id, trigger_kind, label, node_count,
    created_by_type, created_by_label, created_at
FROM cockpit_snapshot
WHERE cockpit_id = sqlc.arg('cockpit_id')::uuid
ORDER BY created_at DESC, id DESC
LIMIT 200;

-- name: GetCockpitSnapshot :one
SELECT * FROM cockpit_snapshot
WHERE id = sqlc.arg('id')::uuid AND workspace_id = sqlc.arg('workspace_id')::uuid;

-- name: DeleteCockpitSnapshot :exec
DELETE FROM cockpit_snapshot
WHERE id = sqlc.arg('id')::uuid AND workspace_id = sqlc.arg('workspace_id')::uuid;

-- name: PruneCockpitSnapshots :execrows
-- Keeps the newest `keep` rows. Snapshots are taken automatically on every
-- import and restore, so a scripted loop must not be able to grow the table
-- without bound.
DELETE FROM cockpit_snapshot
WHERE cockpit_id = sqlc.arg('cockpit_id')::uuid
  AND id NOT IN (
    SELECT id FROM cockpit_snapshot
    WHERE cockpit_id = sqlc.arg('cockpit_id')::uuid
    ORDER BY created_at DESC, id DESC
    LIMIT sqlc.arg('keep')::int
  );

-- name: GetLatestCockpitSnapshot :one
SELECT * FROM cockpit_snapshot
WHERE cockpit_id = $1
ORDER BY created_at DESC, id DESC
LIMIT 1;

-- name: CreateCockpitPendingChange :one
INSERT INTO cockpit_pending_change (
    workspace_id, cockpit_id, node_id, field, old_value, new_value,
    source, reason, created_by_type, created_by_label
) VALUES (
    sqlc.arg('workspace_id')::uuid,
    sqlc.arg('cockpit_id')::uuid,
    sqlc.arg('node_id')::uuid,
    sqlc.arg('field')::text,
    sqlc.arg('old_value')::text,
    sqlc.arg('new_value')::text,
    sqlc.arg('source')::text,
    sqlc.arg('reason')::text,
    sqlc.arg('created_by_type')::text,
    sqlc.arg('created_by_label')::text
)
RETURNING *;

-- name: ListCockpitPendingChanges :many
-- The queue's whole history, open first. LEFT JOIN because a change can
-- outlive its node between the moment cleanup runs and the moment a reader
-- looks — a row naming no node renders as "node gone" instead of vanishing.
SELECT c.*, n.code AS node_code, n.name AS node_name
FROM cockpit_pending_change c
LEFT JOIN cockpit_node n ON n.id = c.node_id
WHERE c.cockpit_id = sqlc.arg('cockpit_id')::uuid
ORDER BY (c.status = 'pending') DESC, c.created_at DESC, c.id DESC
LIMIT 500;

-- name: GetCockpitPendingChange :one
SELECT * FROM cockpit_pending_change
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid;

-- name: GetOpenCockpitPendingChangeByNodeField :one
-- The dedupe probe: the one open proposal for this (node, field), if any.
SELECT * FROM cockpit_pending_change
WHERE node_id = sqlc.arg('node_id')::uuid
  AND field = sqlc.arg('field')::text
  AND status = 'pending';

-- name: UpdateCockpitPendingChangeProposal :one
-- A re-ingest for a field that already has an open proposal replaces the
-- proposal: latest intent wins, the queue never shows two competing values
-- for the same field.
UPDATE cockpit_pending_change SET
    old_value = sqlc.arg('old_value')::text,
    new_value = sqlc.arg('new_value')::text,
    reason     = sqlc.arg('reason')::text,
    updated_at = now()
WHERE id = sqlc.arg('id')::uuid
RETURNING *;

-- name: DecideCockpitPendingChange :one
-- The only status transition out of 'pending'. The status guard makes a
-- double-apply or an apply-after-reject return no rows (a 409 upstream)
-- without a separate lock: the row moves exactly once, atomically.
UPDATE cockpit_pending_change SET
    status           = sqlc.arg('status')::text,
    old_value        = sqlc.arg('old_value')::text,
    decided_by_type  = sqlc.arg('decided_by_type')::text,
    decided_by_label = sqlc.arg('decided_by_label')::text,
    decided_at       = now(),
    updated_at       = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
  AND status = 'pending'
RETURNING *;

-- name: DeleteCockpitChangesByNode :exec
-- Node deletion. The node's proposals and decided history go with it: there
-- is no foreign key to cascade them (repository rule), and a queue row about
-- a row that no longer exists is not history, it is litter.
DELETE FROM cockpit_pending_change
WHERE node_id = sqlc.arg('node_id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid;

-- name: DeleteCockpitChangesByCockpit :exec
-- Import/restore only: the board is being replaced wholesale, so its change
-- history refers to nodes that are about to stop existing.
DELETE FROM cockpit_pending_change
WHERE cockpit_id = sqlc.arg('cockpit_id')::uuid;
