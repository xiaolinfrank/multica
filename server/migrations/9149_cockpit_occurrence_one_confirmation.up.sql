-- R4 collapse (design-principles-2026-10-12, principle 3): a meeting has one
-- strong confirmation — the end, which gates the minutes conclusions. The
-- start confirmation goes away entirely ("in progress" is a projection of the
-- scheduled time window), and a human-created meeting starts life scheduled:
-- creating it IS the schedule confirmation. Only NAS-scanned rows stay
-- unconfirmed until a human checks them.
UPDATE cockpit_meeting SET occurrence_state='scheduled' WHERE occurrence_state='in_progress';
ALTER TABLE cockpit_meeting DROP CONSTRAINT cockpit_meeting_occurrence_check;
ALTER TABLE cockpit_meeting ADD CONSTRAINT cockpit_meeting_occurrence_check CHECK (
 lifecycle_revision>0 AND agenda_revision>0 AND occurrence_state IN ('unconfirmed','scheduled','ended','cancelled')
 AND (occurrence_state='ended')=(ended_at IS NOT NULL)
 AND (occurrence_state='cancelled')=(cancelled_at IS NOT NULL)
 AND (cancelled_at IS NULL)=(cancelled_by IS NULL)
 AND (cancelled_at IS NULL OR length(btrim(cancelled_reason))>0)
 AND (archived_at IS NULL)=(archived_by IS NULL)
 AND (archived_at IS NULL OR length(btrim(archived_reason))>0)
 AND (ended_at IS NULL)=(ended_source IS NULL)
 AND (ended_source IS NULL OR ended_source IN ('legacy_confirmation','human_confirmation'))
 AND (actual_ended_at IS NULL OR ended_at IS NOT NULL)
 AND (actual_started_at IS NULL OR actual_ended_at IS NULL OR actual_started_at<=actual_ended_at)
);
ALTER TABLE cockpit_meeting ALTER COLUMN occurrence_state SET DEFAULT 'scheduled';
