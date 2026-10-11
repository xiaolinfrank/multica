CREATE INDEX CONCURRENTLY cockpit_directory_step_lease_idx ON cockpit_meeting_directory_step(lease_expires_at,id) WHERE state='running';
