-- Dedicated domain facts; application code validates relationships and cleanup.
CREATE TABLE IF NOT EXISTS cockpit_acceptance_evidence (
workspace_id UUID NOT NULL, request_id UUID NOT NULL, criterion_id UUID NOT NULL,
version_id UUID NOT NULL, artifact_id UUID NOT NULL, content_hash TEXT NOT NULL
);
