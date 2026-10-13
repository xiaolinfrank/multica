ALTER TABLE IF EXISTS cockpit_meeting_lifecycle_command
 ALTER COLUMN agenda_revision DROP DEFAULT;
ALTER TABLE IF EXISTS cockpit_meeting_preparation_operation
 ALTER COLUMN authorized_agenda_revision DROP DEFAULT;
