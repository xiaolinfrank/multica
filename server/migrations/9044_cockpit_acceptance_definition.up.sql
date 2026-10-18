-- Dedicated domain facts; application code validates relationships and cleanup.
CREATE TABLE IF NOT EXISTS cockpit_acceptance_definition (
workspace_id UUID NOT NULL, node_id UUID NOT NULL, revision BIGINT NOT NULL DEFAULT 1 CHECK (revision>0),
created_by UUID NOT NULL, last_updated_by UUID NOT NULL, last_request_hash TEXT NOT NULL,
current_request_id UUID, last_approved_request_id UUID,
created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
