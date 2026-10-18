-- Dedicated domain facts; application code validates relationships and cleanup.
CREATE TABLE IF NOT EXISTS cockpit_artifact_reviewer_handoff (
id UUID NOT NULL, workspace_id UUID NOT NULL, artifact_id UUID NOT NULL,
command_key UUID NOT NULL, request_hash TEXT NOT NULL, from_reviewer_id UUID NOT NULL, to_reviewer_id UUID NOT NULL,
version_id UUID, version_number INTEGER, from_review_issue_id UUID, to_review_issue_id UUID,
reason TEXT NOT NULL, created_by UUID NOT NULL, expected_revision BIGINT NOT NULL, resulting_revision BIGINT NOT NULL,
created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
CHECK ((from_review_issue_id IS NULL)=(to_review_issue_id IS NULL)),
CHECK (version_id IS NOT NULL OR (from_review_issue_id IS NULL AND to_review_issue_id IS NULL)),
CHECK ((version_id IS NULL AND version_number IS NULL) OR (version_id IS NOT NULL AND version_number > 0))
);
