-- A final gate also covers direct wakeup inserts and claim/start transitions.
CREATE OR REPLACE FUNCTION enforce_cockpit_workflow_execution_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.issue_id IS NOT NULL AND NEW.status IN ('queued','deferred','dispatched','running','waiting_local_directory') THEN
  PERFORM 1 FROM issue WHERE id=NEW.issue_id FOR KEY SHARE;
  IF EXISTS(SELECT 1 FROM cockpit_meeting_work_package WHERE minutes_issue_id=NEW.issue_id AND released_at IS NULL)
    OR EXISTS(SELECT 1 FROM cockpit_minutes_version WHERE review_issue_id=NEW.issue_id) THEN
   RAISE EXCEPTION 'cockpit workflow issue is not available for agent execution' USING ERRCODE='23514', CONSTRAINT='cockpit_workflow_execution_gate';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
