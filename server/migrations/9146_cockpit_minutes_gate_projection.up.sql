-- Execution gate becomes a continuous projection: a minutes task is not
-- available for agent execution while the meeting has not ended or its
-- materials are unconfirmed. There is no one-shot permanent release.
CREATE OR REPLACE FUNCTION enforce_cockpit_workflow_execution_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.issue_id IS NOT NULL AND NEW.status IN ('queued','deferred','dispatched','running','waiting_local_directory') THEN
  PERFORM 1 FROM issue WHERE id=NEW.issue_id FOR KEY SHARE;
  IF EXISTS(
      SELECT 1 FROM cockpit_meeting_issue l
      JOIN cockpit_meeting m ON m.workspace_id=l.workspace_id AND m.id=l.meeting_id
      WHERE l.issue_id=NEW.issue_id AND 'minutes'=ANY(l.roles)
        AND (m.ended_at IS NULL OR NOT m.minutes_materials_ready))
    OR EXISTS(SELECT 1 FROM cockpit_minutes_version WHERE review_issue_id=NEW.issue_id)
    OR EXISTS(SELECT 1 FROM cockpit_reviewer_handoff WHERE from_review_issue_id=NEW.issue_id OR to_review_issue_id=NEW.issue_id)
    OR cockpit_artifact_is_review_issue(NEW.issue_id) THEN
   RAISE EXCEPTION 'cockpit workflow issue is not available for agent execution' USING ERRCODE='23514', CONSTRAINT='cockpit_workflow_execution_gate';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
