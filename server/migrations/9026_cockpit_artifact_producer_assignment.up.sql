-- Dedicated domain facts; application code validates relationships and cleanup.
CREATE TABLE IF NOT EXISTS cockpit_artifact_producer_assignment (
id UUID NOT NULL, workspace_id UUID NOT NULL, artifact_id UUID NOT NULL,
command_key UUID NOT NULL, request_hash TEXT NOT NULL, from_issue_id UUID NOT NULL, to_issue_id UUID NOT NULL,
reason TEXT NOT NULL, created_by UUID NOT NULL, expected_revision BIGINT NOT NULL, resulting_revision BIGINT NOT NULL,
created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
