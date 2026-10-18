ALTER TABLE cockpit_meeting_action DROP COLUMN previous_resolutions;
ALTER TABLE cockpit_acceptance_definition DROP COLUMN approval_revoked_at;
ALTER TABLE cockpit_acceptance_definition DROP COLUMN approval_revoked_by;
ALTER TABLE cockpit_acceptance_definition DROP COLUMN approval_revoked_reason;
ALTER TABLE cockpit_minutes_version DROP COLUMN unpublished_at;
ALTER TABLE cockpit_minutes_version DROP COLUMN unpublished_by;
ALTER TABLE cockpit_minutes_version DROP COLUMN unpublished_reason;

CREATE OR REPLACE FUNCTION guard_cockpit_meeting_end_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.ended_at IS NOT NULL AND (NEW.ended_at IS DISTINCT FROM OLD.ended_at OR NEW.ended_by IS DISTINCT FROM OLD.ended_by OR NEW.ended_source IS DISTINCT FROM OLD.ended_source) THEN
  RAISE EXCEPTION 'the recorded meeting end confirmation cannot be replaced' USING ERRCODE='23514',CONSTRAINT='cockpit_meeting_lifecycle_integrity';
 END IF;
 RETURN NEW;
END $$;
