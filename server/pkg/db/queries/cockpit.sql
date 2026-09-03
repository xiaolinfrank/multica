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
SELECT * FROM cockpit_meeting
WHERE cockpit_id = sqlc.arg('cockpit_id')::uuid
ORDER BY meet_date DESC NULLS LAST, time_range DESC;

-- name: CreateCockpitMeeting :one
INSERT INTO cockpit_meeting (
    workspace_id, cockpit_id, meet_date, time_range, title,
    attendees, meet_no, link, note
) VALUES (
    sqlc.arg('workspace_id')::uuid,
    sqlc.arg('cockpit_id')::uuid,
    sqlc.narg('meet_date')::date,
    sqlc.arg('time_range')::text,
    sqlc.arg('title')::text,
    sqlc.arg('attendees')::text,
    sqlc.arg('meet_no')::text,
    sqlc.arg('link')::text,
    sqlc.arg('note')::text
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
WITH del_links AS (
    DELETE FROM cockpit_node_issue WHERE workspace_id = sqlc.arg('workspace_id')::uuid
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
