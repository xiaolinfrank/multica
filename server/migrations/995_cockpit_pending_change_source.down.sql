ALTER TABLE cockpit_pending_change
    DROP COLUMN IF EXISTS decision_note,
    DROP COLUMN IF EXISTS source_task_id;
