DROP TRIGGER IF EXISTS cockpit_artifact_meeting_guard ON cockpit_meeting;
DROP TRIGGER IF EXISTS cockpit_artifact_review_primary_guard ON cockpit_issue_primary;
DROP TRIGGER IF EXISTS cockpit_artifact_node_guard ON cockpit_node;
DROP TRIGGER IF EXISTS cockpit_artifact_issue_guard ON issue;
DROP FUNCTION IF EXISTS guard_cockpit_artifact_meeting();
DROP FUNCTION IF EXISTS guard_cockpit_artifact_node();
DROP FUNCTION IF EXISTS guard_cockpit_artifact_issue();
DROP FUNCTION IF EXISTS guard_cockpit_artifact_review_primary();
-- A final gate also covers direct wakeup inserts and claim/start transitions.
CREATE OR REPLACE FUNCTION enforce_cockpit_workflow_execution_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.issue_id IS NOT NULL AND NEW.status IN ('queued','deferred','dispatched','running','waiting_local_directory') THEN
  PERFORM 1 FROM issue WHERE id=NEW.issue_id FOR KEY SHARE;
  IF EXISTS(SELECT 1 FROM cockpit_meeting_work_package WHERE minutes_issue_id=NEW.issue_id AND released_at IS NULL)
    OR EXISTS(SELECT 1 FROM cockpit_minutes_version WHERE review_issue_id=NEW.issue_id)
    OR EXISTS(SELECT 1 FROM cockpit_reviewer_handoff WHERE from_review_issue_id=NEW.issue_id OR to_review_issue_id=NEW.issue_id) THEN
   RAISE EXCEPTION 'cockpit workflow issue is not available for agent execution' USING ERRCODE='23514', CONSTRAINT='cockpit_workflow_execution_gate';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;

DROP FUNCTION IF EXISTS cockpit_artifact_references_node(UUID,UUID);
DROP FUNCTION IF EXISTS cockpit_artifact_references_issue(UUID,UUID);
DROP FUNCTION IF EXISTS cockpit_artifact_review_node(UUID,UUID);
DROP FUNCTION IF EXISTS cockpit_artifact_review_stage(UUID,UUID);
DROP FUNCTION IF EXISTS cockpit_artifact_is_review_issue(UUID);
