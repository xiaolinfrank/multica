-- Dedicated domain facts; application code validates relationships and cleanup.
CREATE TABLE IF NOT EXISTS cockpit_acceptance_request (
id UUID NOT NULL, workspace_id UUID NOT NULL, node_id UUID NOT NULL,
request_key UUID NOT NULL, request_hash TEXT NOT NULL, revision BIGINT NOT NULL DEFAULT 1, criteria_revision BIGINT NOT NULL,
evidence_hash TEXT NOT NULL, reviewer_id UUID NOT NULL, review_issue_id UUID NOT NULL,
decision TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending','approved','changes_requested','rejected')),
feedback TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', reviewed_by UUID, reviewed_at TIMESTAMPTZ,
supersedes_request_id UUID, superseded_by_request_id UUID, superseded_at TIMESTAMPTZ,
created_by UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
