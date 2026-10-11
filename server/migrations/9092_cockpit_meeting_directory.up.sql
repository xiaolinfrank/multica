ALTER TABLE cockpit_meeting ADD COLUMN nas_dir_revision BIGINT NOT NULL DEFAULT 1 CHECK(nas_dir_revision>0);
ALTER TABLE cockpit_meeting_lifecycle_command
 ADD COLUMN actor_type TEXT NOT NULL DEFAULT 'member' CHECK(actor_type IN ('member','agent')),
 ADD COLUMN directory_operation_id UUID,
 ADD COLUMN directory_step_id UUID;
CREATE TABLE cockpit_meeting_directory_operation (
 id UUID NOT NULL, workspace_id UUID NOT NULL, meeting_id UUID NOT NULL,
 creation_command_key UUID NOT NULL, request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 plan_hash TEXT NOT NULL CHECK(length(plan_hash)=64), revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0),
 state TEXT NOT NULL CHECK(state IN ('active','paused','needs_attention','completed','abandoned')),
 root_id UUID NOT NULL, root_path TEXT NOT NULL, prepare_subpath TEXT NOT NULL,
 relative_directory TEXT NOT NULL, directory TEXT NOT NULL, target_hash TEXT NOT NULL CHECK(length(target_hash)=64),
 root_config_hash TEXT NOT NULL CHECK(length(root_config_hash)=64),
 observed_nas_dir TEXT NOT NULL, observed_binding_revision BIGINT NOT NULL CHECK(observed_binding_revision>0),
 accepted_binding_revision BIGINT CHECK(accepted_binding_revision>0), bind_after_base BOOLEAN NOT NULL,
 binding_result TEXT NOT NULL DEFAULT 'pending' CHECK(binding_result IN ('pending','unchanged','updated','conflict')),
 created_by_type TEXT NOT NULL CHECK(created_by_type IN ('member','agent')), created_by UUID NOT NULL,
 credential_owner_user_id UUID NOT NULL, authorizing_user_id UUID NOT NULL,
 source_run_id UUID, source_issue_id UUID, source_agent_id UUID, source_runtime_id UUID, source_task_token_id UUID,
 source_relation_kind TEXT NOT NULL, source_agenda_reference_id UUID,
 source_principal JSONB NOT NULL CHECK(jsonb_typeof(source_principal)='object' AND octet_length(source_principal::text)<=16384),
 last_grant_command_key UUID NOT NULL, responsible_user_id UUID NOT NULL,
 input JSONB NOT NULL CHECK(jsonb_typeof(input)='object' AND octet_length(input::text)<=65536),
 receipt JSONB NOT NULL CHECK(jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=65536),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ,
 CHECK((state IN ('completed','abandoned'))=(finished_at IS NOT NULL)),
 CHECK((created_by_type='member' AND credential_owner_user_id=created_by AND authorizing_user_id=created_by AND source_run_id IS NULL AND source_agent_id IS NULL AND source_issue_id IS NULL AND source_runtime_id IS NULL AND source_task_token_id IS NULL AND source_relation_kind='none') OR
       (created_by_type='agent' AND source_run_id IS NOT NULL AND source_agent_id IS NOT NULL AND source_agent_id=created_by AND source_issue_id IS NOT NULL AND source_runtime_id IS NOT NULL AND source_task_token_id IS NOT NULL AND source_relation_kind IN ('work_package','agenda_preparation','direct_preparation','legacy_task'))),
 CHECK((source_relation_kind='agenda_preparation')=(source_agenda_reference_id IS NOT NULL)),
 CHECK(octet_length(root_path) BETWEEN 1 AND 4096 AND octet_length(prepare_subpath) BETWEEN 1 AND 4096 AND octet_length(relative_directory) BETWEEN 1 AND 4096 AND octet_length(directory) BETWEEN 1 AND 8192)
);
CREATE TABLE cockpit_meeting_directory_step (
 id UUID NOT NULL, workspace_id UUID NOT NULL, meeting_id UUID NOT NULL, operation_id UUID NOT NULL,
 position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 31), parent_step_id UUID,
 kind TEXT NOT NULL CHECK(kind IN ('ancestor','base','partition')), label TEXT NOT NULL,
 relative_path TEXT NOT NULL, path_hash TEXT NOT NULL CHECK(length(path_hash)=64),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','retry_wait','satisfied','needs_attention','abandoned')),
 revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0),
 grant_command_key UUID NOT NULL, grant_revision BIGINT NOT NULL CHECK(grant_revision>0),
 attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0), last_attempt_id UUID,
 next_attempt_at TIMESTAMPTZ, lease_token UUID, lease_expires_at TIMESTAMPTZ,
 last_observed_at TIMESTAMPTZ, outcome TEXT CHECK(outcome IN ('created','observed_existing')),
 last_error_code TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK((state='running')=(lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
 CHECK((lease_token IS NULL)=(lease_expires_at IS NULL)),
 CHECK(state<>'satisfied' OR (last_attempt_id IS NOT NULL AND last_observed_at IS NOT NULL AND outcome IS NOT NULL)),
 CHECK(octet_length(label) BETWEEN 1 AND 500 AND octet_length(relative_path) BETWEEN 1 AND 4096)
);
CREATE TABLE cockpit_meeting_directory_attempt (
 id UUID NOT NULL, workspace_id UUID NOT NULL, meeting_id UUID NOT NULL, operation_id UUID NOT NULL, step_id UUID NOT NULL,
 attempt_number INTEGER NOT NULL CHECK(attempt_number>0), grant_command_key UUID NOT NULL, grant_revision BIGINT NOT NULL CHECK(grant_revision>0),
 lease_token UUID NOT NULL, state TEXT NOT NULL CHECK(state IN ('running','succeeded','failed','expired','abandoned')),
 started_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ,
 outcome TEXT CHECK(outcome IN ('created','observed_existing')), observed_at TIMESTAMPTZ,
 error_code TEXT NOT NULL DEFAULT '', error_message TEXT NOT NULL DEFAULT '',
 receipt JSONB CHECK(receipt IS NULL OR (jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=16384)),
 late_receipt JSONB CHECK(late_receipt IS NULL OR (jsonb_typeof(late_receipt)='object' AND octet_length(late_receipt::text)<=16384)),
 late_observed_at TIMESTAMPTZ,
 CHECK((state='running')=(finished_at IS NULL)),
 CHECK((late_receipt IS NULL)=(late_observed_at IS NULL)),
 CHECK(state<>'succeeded' OR (receipt IS NOT NULL AND outcome IS NOT NULL AND observed_at IS NOT NULL)),
 CHECK(octet_length(error_message)<=16000)
);
