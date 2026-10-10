DROP TABLE IF EXISTS cockpit_minutes_export_attempt;
ALTER TABLE cockpit_minutes_export
 DROP COLUMN IF EXISTS receipt_hash,
 DROP COLUMN IF EXISTS verified_attempt_id,
 DROP COLUMN IF EXISTS receipt_path,
 DROP COLUMN IF EXISTS verified_path,
 DROP COLUMN IF EXISTS write_mode;
