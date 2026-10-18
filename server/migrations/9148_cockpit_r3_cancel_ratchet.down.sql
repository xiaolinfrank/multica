CREATE OR REPLACE FUNCTION guard_cockpit_meeting_preparation_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM cockpit_meeting_preparation_operation WHERE workspace_id=OLD.workspace_id AND meeting_id=OLD.id) THEN
   RAISE EXCEPTION 'Meeting preparation history must be retained; archive this meeting instead' USING ERRCODE='23514',CONSTRAINT='cockpit_meeting_preparation_integrity';
  END IF;
  RETURN OLD;
 END IF;
 IF NEW.occurrence_state='cancelled' AND OLD.occurrence_state NOT IN ('unconfirmed','scheduled','cancelled') THEN
  RAISE EXCEPTION 'A started or ended meeting cannot become a meeting that did not occur' USING ERRCODE='23514',CONSTRAINT='cockpit_meeting_preparation_integrity';
 END IF;
 IF OLD.occurrence_state='cancelled' AND NEW.occurrence_state NOT IN ('cancelled','scheduled') THEN
  RAISE EXCEPTION 'Cancelled meetings must be explicitly rescheduled first' USING ERRCODE='23514',CONSTRAINT='cockpit_meeting_preparation_integrity';
 END IF;
 RETURN NEW;
END $$;
