-- Restore the frozen 9064 relationship guard, preserving its protection.
CREATE OR REPLACE FUNCTION cockpit_artifact_references_issue(ws UUID,issue_uuid UUID) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM cockpit_artifact WHERE workspace_id=ws AND (source_issue_id=issue_uuid OR authorized_producer_issue_id=issue_uuid))
 OR EXISTS(SELECT 1 FROM cockpit_artifact_version WHERE workspace_id=ws AND (producer_issue_id=issue_uuid OR review_issue_id=issue_uuid))
 OR EXISTS(SELECT 1 FROM cockpit_artifact_producer_assignment WHERE workspace_id=ws AND (from_issue_id=issue_uuid OR to_issue_id=issue_uuid))
 OR EXISTS(SELECT 1 FROM cockpit_artifact_reviewer_handoff WHERE workspace_id=ws AND from_review_issue_id=issue_uuid)
 OR EXISTS(SELECT 1 FROM cockpit_acceptance_request WHERE workspace_id=ws AND review_issue_id=issue_uuid)
 OR EXISTS(SELECT 1 FROM cockpit_acceptance_reviewer_handoff WHERE workspace_id=ws AND from_review_issue_id=issue_uuid)
$$;
