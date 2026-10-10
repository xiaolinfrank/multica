CREATE INDEX CONCURRENTLY IF NOT EXISTS cockpit_acceptance_evidence_version_idx ON cockpit_acceptance_evidence (workspace_id, version_id, request_id);
