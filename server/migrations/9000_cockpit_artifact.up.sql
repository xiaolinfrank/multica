-- Dedicated domain facts; application code validates relationships and cleanup.
CREATE TABLE IF NOT EXISTS cockpit_artifact (
id UUID NOT NULL, workspace_id UUID NOT NULL, owner_node_id UUID NOT NULL,
project_id UUID NOT NULL, module_id UUID NOT NULL, source_issue_id UUID NOT NULL,
authorized_producer_issue_id UUID NOT NULL, creation_key UUID NOT NULL, request_hash TEXT NOT NULL,
created_by UUID NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', reviewer_id UUID NOT NULL,
revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0), current_version_id UUID, approved_version_id UUID,
archived_at TIMESTAMPTZ, archived_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
