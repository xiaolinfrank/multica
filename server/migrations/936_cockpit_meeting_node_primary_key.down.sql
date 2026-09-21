-- Dropping the constraint drops the index it took over, leaving 935's down
-- direction a no-op via IF EXISTS.
ALTER TABLE cockpit_meeting_node DROP CONSTRAINT IF EXISTS cockpit_meeting_node_pkey;
