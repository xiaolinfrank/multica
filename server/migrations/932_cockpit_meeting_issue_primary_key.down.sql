-- Dropping the constraint drops the index it took over, leaving 931's down
-- direction a no-op via IF EXISTS.
ALTER TABLE cockpit_meeting_issue DROP CONSTRAINT IF EXISTS cockpit_meeting_issue_pkey;
