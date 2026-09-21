-- Fork-only (900-999 range): the reverse direction — "which meetings touched
-- this issue", and the sweep that clears links when an issue is deleted.
-- See 930 for the table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cockpit_meeting_issue_issue
    ON cockpit_meeting_issue (issue_id);
