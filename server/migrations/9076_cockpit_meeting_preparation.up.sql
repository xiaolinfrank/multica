BEGIN;
ALTER TABLE cockpit_meeting ADD COLUMN cancelled_at timestamptz, ADD COLUMN cancelled_by uuid,
 ADD COLUMN cancelled_reason text NOT NULL DEFAULT '', ADD COLUMN archived_at timestamptz,
 ADD COLUMN archived_by uuid, ADD COLUMN archived_reason text NOT NULL DEFAULT '';
ALTER TABLE cockpit_meeting_lifecycle_command ADD COLUMN operation_id uuid, ADD COLUMN effect_id uuid;
CREATE TABLE cockpit_meeting_template (
 id uuid NOT NULL, workspace_id uuid NOT NULL, revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 current_version_id uuid NOT NULL, title text NOT NULL, description text NOT NULL DEFAULT '', is_active boolean NOT NULL,
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE cockpit_meeting_template_version (
 id uuid NOT NULL, workspace_id uuid NOT NULL, template_id uuid NOT NULL, number integer NOT NULL CHECK(number>0),
 title text NOT NULL, description text NOT NULL DEFAULT '', is_active boolean NOT NULL,
 config_schema integer NOT NULL CHECK(config_schema=1), config jsonb NOT NULL, config_hash text NOT NULL CHECK(config_hash~'^[0-9a-f]{64}$'),
 slot_count integer NOT NULL CHECK(slot_count BETWEEN 1 AND 50), command_key uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash~'^[0-9a-f]{64}$'), receipt jsonb NOT NULL,
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE cockpit_meeting_preparation_operation (
 id uuid NOT NULL, workspace_id uuid NOT NULL, meeting_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('apply_template','cancel_preparation')),
 command_key uuid NOT NULL, request_hash text NOT NULL CHECK(request_hash~'^[0-9a-f]{64}$'), context_token text NOT NULL,
 template_id uuid, template_version_id uuid, input jsonb NOT NULL,
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','paused','needs_attention','completed')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), authorized_lifecycle_revision bigint NOT NULL, authorized_agenda_revision bigint NOT NULL,
 created_by uuid NOT NULL, responsible_user_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((kind='apply_template')=(template_id IS NOT NULL AND template_version_id IS NOT NULL)),
 CHECK((template_id IS NULL)=(template_version_id IS NULL))
);
CREATE TABLE cockpit_meeting_preparation_effect (
 id uuid NOT NULL, workspace_id uuid NOT NULL, meeting_id uuid NOT NULL, operation_id uuid NOT NULL,
 slot_id uuid NOT NULL, position integer NOT NULL CHECK(position BETWEEN 0 AND 49),
 kind text NOT NULL CHECK(kind IN ('agenda','preparation_issue','issue_reference','material_reference','cancel_issue','change_due_date','link_meeting','stop_run')),
 label text NOT NULL, command_key uuid NOT NULL, dependency_id uuid,
 request_hash text NOT NULL CHECK(request_hash~'^[0-9a-f]{64}$'), input jsonb NOT NULL,
 authorization_key uuid NOT NULL, authorization_revision bigint NOT NULL DEFAULT 1 CHECK(authorization_revision>0),
 authorization_hash text NOT NULL CHECK(authorization_hash~'^[0-9a-f]{64}$'), authorization_snapshot jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','applied','needs_attention','skipped')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), error_code text NOT NULL DEFAULT '', reason text NOT NULL DEFAULT '',
 agenda_id uuid, reference_id uuid, issue_id uuid, run_id uuid, target_meeting_id uuid,
 receipt jsonb, applied_by uuid, applied_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((state='applied')=(receipt IS NOT NULL AND applied_at IS NOT NULL AND applied_by IS NOT NULL))
);
COMMIT;
