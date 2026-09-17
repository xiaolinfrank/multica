-- Dropping the constraint drops the index it took over, leaving 924's down
-- direction a no-op via IF EXISTS.
ALTER TABLE module DROP CONSTRAINT IF EXISTS module_pkey;
