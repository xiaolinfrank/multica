CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cockpit_input_task_manifest ON agent_task_queue (input_manifest_version_id,id) WHERE input_manifest_version_id IS NOT NULL;
