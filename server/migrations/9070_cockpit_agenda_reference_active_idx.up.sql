CREATE UNIQUE INDEX CONCURRENTLY cockpit_agenda_reference_active_idx ON cockpit_meeting_agenda_reference (workspace_id,agenda_id,kind,target_id) WHERE removed_at IS NULL;
