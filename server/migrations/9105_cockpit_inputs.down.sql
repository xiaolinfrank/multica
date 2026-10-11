-- The batch runner rejects rollback before indexes when any input or retained pin exists.
ALTER TABLE IF EXISTS cockpit_artifact_version DROP COLUMN IF EXISTS input_manifest_version_id;
ALTER TABLE IF EXISTS agent_task_queue DROP COLUMN IF EXISTS input_manifest_version_id,
DROP COLUMN IF EXISTS input_preparation_state, DROP COLUMN IF EXISTS input_preparation_hash,
DROP COLUMN IF EXISTS input_prepared_at, DROP COLUMN IF EXISTS input_prepared_dispatched_at,
DROP COLUMN IF EXISTS input_preparation_error_code;
DROP TABLE IF EXISTS cockpit_issue_input_manifest_item;
DROP TABLE IF EXISTS cockpit_issue_input_manifest_version;
DROP TABLE IF EXISTS cockpit_issue_input_manifest;
DROP TABLE IF EXISTS cockpit_input_reference;
DROP TABLE IF EXISTS cockpit_input_transfer;
DROP TABLE IF EXISTS cockpit_input_version;
DROP TABLE IF EXISTS cockpit_input;
