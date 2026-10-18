-- R2 (design-principles-2026-10-12, principle 2): confirmations write values,
-- not terminal facts. Columns for the four two-way commands. Bare DDL so
-- sqlc sees the columns (BEGIN/COMMIT blocks are invisible to sqlc).

-- reopen: the end fact guard now allows clearing (reopen) while still
-- blocking silent replacement with a different timestamp.
CREATE OR REPLACE FUNCTION guard_cockpit_meeting_end_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.ended_at IS NOT NULL AND NEW.ended_at IS NOT NULL
    AND (NEW.ended_at IS DISTINCT FROM OLD.ended_at OR NEW.ended_by IS DISTINCT FROM OLD.ended_by OR NEW.ended_source IS DISTINCT FROM OLD.ended_source) THEN
  RAISE EXCEPTION 'the recorded meeting end confirmation cannot be replaced' USING ERRCODE='23514',CONSTRAINT='cockpit_meeting_lifecycle_integrity';
 END IF;
 RETURN NEW;
END $$;

-- revise_resolution: prior resolutions stay visible as an append-only trail
-- on the action row itself.
ALTER TABLE cockpit_meeting_action ADD COLUMN previous_resolutions JSONB NOT NULL DEFAULT '[]'::jsonb;

-- revoke_approval: a revoked approval is a re-decision on the definition,
-- leaving the historical request rows untouched.
ALTER TABLE cockpit_acceptance_definition ADD COLUMN approval_revoked_at TIMESTAMPTZ;
ALTER TABLE cockpit_acceptance_definition ADD COLUMN approval_revoked_by UUID;
ALTER TABLE cockpit_acceptance_definition ADD COLUMN approval_revoked_reason TEXT;

-- unpublish: re-publication of an unpublished version stays possible;
-- "currently published" means pointed to and not unpublished.
ALTER TABLE cockpit_minutes_version ADD COLUMN unpublished_at TIMESTAMPTZ;
ALTER TABLE cockpit_minutes_version ADD COLUMN unpublished_by UUID;
ALTER TABLE cockpit_minutes_version ADD COLUMN unpublished_reason TEXT;
