-- Dropping the constraint drops the index it took over, leaving 949's down
-- direction a no-op via IF EXISTS.
ALTER TABLE cockpit_used_codes DROP CONSTRAINT IF EXISTS cockpit_used_codes_pkey;
