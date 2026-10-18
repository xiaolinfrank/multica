CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cockpit_input_artifact_manifest ON cockpit_artifact_version (workspace_id,input_manifest_version_id,id) WHERE input_manifest_version_id IS NOT NULL;
