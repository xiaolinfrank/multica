-- A shared producer can own hundreds of thousands of versions. An OR across
-- producer/review columns lets a generic plan expect every row and choose a
-- repeated sequential scan, including during atomic workspace teardown.
-- Ordered scalar lookups retain the existing (workspace, role, id) index order;
-- unlike EXISTS, their ORDER BY cannot be discarded by the EXISTS simplifier.
-- The guard's protected relationships and authorization semantics are unchanged.
CREATE OR REPLACE FUNCTION cockpit_artifact_references_issue(ws UUID,issue_uuid UUID) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
 SELECT (SELECT r.id FROM cockpit_artifact r WHERE r.workspace_id=ws AND r.source_issue_id=issue_uuid ORDER BY r.id LIMIT 1) IS NOT NULL
 OR (SELECT r.id FROM cockpit_artifact r WHERE r.workspace_id=ws AND r.authorized_producer_issue_id=issue_uuid ORDER BY r.id LIMIT 1) IS NOT NULL
 OR (SELECT r.id FROM cockpit_artifact_version r WHERE r.workspace_id=ws AND r.producer_issue_id=issue_uuid ORDER BY r.id LIMIT 1) IS NOT NULL
 OR (SELECT r.id FROM cockpit_artifact_version r WHERE r.workspace_id=ws AND r.review_issue_id=issue_uuid ORDER BY r.id LIMIT 1) IS NOT NULL
 OR (SELECT r.id FROM cockpit_artifact_producer_assignment r WHERE r.workspace_id=ws AND r.from_issue_id=issue_uuid ORDER BY r.id LIMIT 1) IS NOT NULL
 OR (SELECT r.id FROM cockpit_artifact_producer_assignment r WHERE r.workspace_id=ws AND r.to_issue_id=issue_uuid ORDER BY r.id LIMIT 1) IS NOT NULL
 OR (SELECT r.id FROM cockpit_artifact_reviewer_handoff r WHERE r.workspace_id=ws AND r.from_review_issue_id=issue_uuid ORDER BY r.id LIMIT 1) IS NOT NULL
 OR (SELECT r.id FROM cockpit_acceptance_request r WHERE r.workspace_id=ws AND r.review_issue_id=issue_uuid ORDER BY r.id LIMIT 1) IS NOT NULL
 OR (SELECT r.id FROM cockpit_acceptance_reviewer_handoff r WHERE r.workspace_id=ws AND r.from_review_issue_id=issue_uuid ORDER BY r.id LIMIT 1) IS NOT NULL
$$;
