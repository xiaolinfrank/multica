CREATE TABLE cockpit_meeting_action (
 id UUID NOT NULL,
 workspace_id UUID NOT NULL,
 meeting_id UUID NOT NULL,
 version_id UUID NOT NULL,
 version_number INTEGER NOT NULL,
 source_content_hash TEXT NOT NULL,
 proposal_key UUID NOT NULL,
 proposal_hash TEXT NOT NULL,
 title TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 source_quote TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','accepted','dismissed')),
 resolution TEXT NOT NULL DEFAULT '',
 revision BIGINT NOT NULL DEFAULT 1,
 node_id UUID,
 node_code TEXT NOT NULL DEFAULT '',
 node_name TEXT NOT NULL DEFAULT '',
 issue_id UUID,
 reason TEXT NOT NULL DEFAULT '',
 decision_key UUID,
 decision_hash TEXT NOT NULL DEFAULT '',
 decision_revision BIGINT,
 created_by UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 resolved_by UUID,
 resolved_at TIMESTAMPTZ
);

-- An empty or deleted ownership retains its creation receipt. Replaying an
-- old create key must never mint a second Issue after moving or deleting it.
CREATE TABLE cockpit_issue_primary (
 issue_id UUID NOT NULL,
 workspace_id UUID NOT NULL,
 node_id UUID,
 revision BIGINT NOT NULL DEFAULT 1,
 creation_key UUID,
 creation_node_id UUID,
 creation_hash TEXT NOT NULL DEFAULT '',
 created_by UUID NOT NULL,
 updated_by UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 issue_deleted_at TIMESTAMPTZ
);
