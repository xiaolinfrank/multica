DROP TABLE IF EXISTS cockpit_meeting_directory_attempt;
DROP TABLE IF EXISTS cockpit_meeting_directory_step;
DROP TABLE IF EXISTS cockpit_meeting_directory_operation;
ALTER TABLE IF EXISTS cockpit_meeting_lifecycle_command DROP COLUMN IF EXISTS directory_step_id, DROP COLUMN IF EXISTS directory_operation_id, DROP COLUMN IF EXISTS actor_type;
ALTER TABLE IF EXISTS cockpit_meeting DROP COLUMN IF EXISTS nas_dir_revision;
