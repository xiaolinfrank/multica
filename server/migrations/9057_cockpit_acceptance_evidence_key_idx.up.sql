CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS cockpit_acceptance_evidence_key_idx ON cockpit_acceptance_evidence (workspace_id, request_id, criterion_id, version_id);
