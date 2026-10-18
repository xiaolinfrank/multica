-- Governance queue attribution and decision trail (BayClaw fork).
--
-- A proposal now remembers which agent task filed it (source_task_id, stamped
-- from the server-trusted X-Task-ID header, never from the request body) so a
-- reviewer can open the originating task and check its context. Decisions
-- additionally record an optional human note (decision_note) — a rejection
-- reason fed back to the proposer, or the system reason recorded when node
-- deletion / import / restore withdraws still-pending rows instead of
-- deleting them (history is kept, per "every governance request is saved").
-- Both columns are nullable/defaulted so old rows and old clients keep
-- working; no new indexes — reads join on agent_task_queue's primary key.

ALTER TABLE cockpit_pending_change
    ADD COLUMN source_task_id UUID,
    ADD COLUMN decision_note TEXT NOT NULL DEFAULT '';
