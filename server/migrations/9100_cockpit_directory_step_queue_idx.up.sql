CREATE INDEX CONCURRENTLY cockpit_directory_step_queue_idx ON cockpit_meeting_directory_step(next_attempt_at,id) WHERE state IN ('pending','retry_wait') AND next_attempt_at IS NOT NULL;
