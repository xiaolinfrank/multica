ALTER TABLE cockpit_meeting
 ADD COLUMN lifecycle_revision BIGINT NOT NULL DEFAULT 1,
 ADD COLUMN agenda_revision BIGINT NOT NULL DEFAULT 1,
 ADD COLUMN occurrence_state TEXT NOT NULL DEFAULT 'unconfirmed',
 ADD COLUMN started_confirmed_at TIMESTAMPTZ,
 ADD COLUMN started_confirmed_by UUID,
 ADD COLUMN ended_at TIMESTAMPTZ,
 ADD COLUMN ended_by UUID,
 ADD COLUMN ended_source TEXT,
 ADD COLUMN actual_started_at TIMESTAMPTZ,
 ADD COLUMN actual_ended_at TIMESTAMPTZ,
 ADD COLUMN lifecycle_updated_at TIMESTAMPTZ,
 ADD COLUMN lifecycle_updated_by UUID;
ALTER TABLE cockpit_meeting_work_package
 ADD COLUMN materials_confirmed_at TIMESTAMPTZ,
 ADD COLUMN materials_confirmed_by UUID;
CREATE TABLE cockpit_meeting_agenda (
 id UUID NOT NULL, workspace_id UUID NOT NULL, meeting_id UUID NOT NULL,
 revision BIGINT NOT NULL DEFAULT 1 CHECK(revision > 0),
 title TEXT NOT NULL, purposes TEXT[] NOT NULL DEFAULT '{}',
 desired_outcome TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
 facilitator_user_id UUID, node_id UUID, sort_order BIGINT NOT NULL,
 created_by UUID NOT NULL, updated_by UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 removed_at TIMESTAMPTZ, removed_by UUID,
 CHECK(octet_length(title) BETWEEN 1 AND 500),
 CHECK(octet_length(desired_outcome)<=16000 AND octet_length(notes)<=65536)
);
CREATE TABLE cockpit_meeting_agenda_reference (
 id UUID NOT NULL, workspace_id UUID NOT NULL, meeting_id UUID NOT NULL, agenda_id UUID NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('issue','artifact_reference')),
 target_id UUID NOT NULL, purpose TEXT NOT NULL CHECK(purpose IN ('preparation','material')),
 created_by UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 removed_at TIMESTAMPTZ, removed_by UUID,
 CHECK(kind='issue' OR purpose='material')
);
CREATE TABLE cockpit_meeting_lifecycle_command (
 workspace_id UUID NOT NULL, meeting_id UUID NOT NULL, command_key UUID NOT NULL,
 kind TEXT NOT NULL, actor_id UUID NOT NULL, request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 revision BIGINT NOT NULL, agenda_revision BIGINT NOT NULL,
 agenda_id UUID, reference_id UUID, issue_id UUID,
 receipt JSONB NOT NULL CHECK(octet_length(receipt::text)<=262144),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
