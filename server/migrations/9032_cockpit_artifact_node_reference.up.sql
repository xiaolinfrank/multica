-- Dedicated domain facts; application code validates relationships and cleanup.
CREATE TABLE IF NOT EXISTS cockpit_artifact_node_reference (
id UUID NOT NULL, workspace_id UUID NOT NULL, artifact_id UUID NOT NULL, version_id UUID NOT NULL,
node_id UUID NOT NULL, target_label TEXT NOT NULL, purpose TEXT NOT NULL CHECK (purpose IN ('input','output','evidence','reference')),
reference_key UUID NOT NULL, request_hash TEXT NOT NULL, created_by UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
removed_by UUID, removed_at TIMESTAMPTZ, CHECK ((removed_by IS NULL)=(removed_at IS NULL))
);
