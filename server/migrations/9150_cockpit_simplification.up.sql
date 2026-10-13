-- Retired meeting features remain historical data. Do not drop their tables,
-- columns, guards, indexes, directory plans, or recorded command receipts.
-- Current lifecycle and cancellation writes no longer carry an agenda revision;
-- preserve the installed schema's required columns with their initial value.
ALTER TABLE IF EXISTS cockpit_meeting_lifecycle_command
 ALTER COLUMN agenda_revision SET DEFAULT 1;
ALTER TABLE IF EXISTS cockpit_meeting_preparation_operation
 ALTER COLUMN authorized_agenda_revision SET DEFAULT 1;
