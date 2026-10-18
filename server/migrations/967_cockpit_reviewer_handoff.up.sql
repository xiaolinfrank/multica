-- Responsibility changes are append-only business records; content versions stay fixed.
CREATE TABLE cockpit_reviewer_handoff (
 id UUID NOT NULL,
 workspace_id UUID NOT NULL,
 meeting_id UUID NOT NULL,
 handoff_key UUID NOT NULL,
 from_reviewer_id UUID NOT NULL,
 to_reviewer_id UUID NOT NULL,
 version_id UUID,
 from_review_issue_id UUID,
 to_review_issue_id UUID,
 reason TEXT NOT NULL,
 created_by UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 revision BIGINT NOT NULL,
 CHECK (from_reviewer_id <> to_reviewer_id),
 CHECK ((version_id IS NULL AND from_review_issue_id IS NULL AND to_review_issue_id IS NULL)
     OR (version_id IS NOT NULL AND from_review_issue_id IS NOT NULL AND to_review_issue_id IS NOT NULL))
);
