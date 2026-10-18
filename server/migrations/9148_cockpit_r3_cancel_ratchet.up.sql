-- R3 (design-principles-2026-10-12, principle 2): cancel stops being a one-way
-- ratchet. A meeting confirmed started may still be cancelled (life happens
-- mid-meeting); only a confirmed end still requires reopen first, because an
-- ended meeting already carries minutes conclusions. Bare DDL: CREATE OR
-- REPLACE FUNCTION is transactional-safe and sqlc reads no statements here.
CREATE OR REPLACE FUNCTION guard_cockpit_meeting_preparation_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM cockpit_meeting_preparation_operation WHERE workspace_id=OLD.workspace_id AND meeting_id=OLD.id) THEN
   RAISE EXCEPTION 'Meeting preparation history must be retained; archive this meeting instead' USING ERRCODE='23514',CONSTRAINT='cockpit_meeting_preparation_integrity';
  END IF;
  RETURN OLD;
 END IF;
 IF NEW.occurrence_state='cancelled' AND OLD.occurrence_state NOT IN ('unconfirmed','scheduled','in_progress','cancelled') THEN
  RAISE EXCEPTION 'An ended meeting must be reopened before it can become a meeting that did not occur' USING ERRCODE='23514',CONSTRAINT='cockpit_meeting_preparation_integrity';
 END IF;
 IF OLD.occurrence_state='cancelled' AND NEW.occurrence_state NOT IN ('cancelled','scheduled') THEN
  RAISE EXCEPTION 'Cancelled meetings must be explicitly rescheduled first' USING ERRCODE='23514',CONSTRAINT='cockpit_meeting_preparation_integrity';
 END IF;
 RETURN NEW;
END $$;
