ALTER TABLE cockpit_meeting ADD COLUMN minutes_reviewer_id UUID;
ALTER TABLE cockpit_meeting ADD COLUMN minutes_focus_issue_id UUID;
ALTER TABLE cockpit_meeting ADD COLUMN minutes_current_version_id UUID;
ALTER TABLE cockpit_meeting ADD COLUMN minutes_published_version_id UUID;
ALTER TABLE cockpit_meeting ADD COLUMN minutes_revision BIGINT NOT NULL DEFAULT 1;
ALTER TABLE cockpit_meeting ADD COLUMN minutes_materials_ready BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE cockpit_meeting ADD COLUMN minutes_materials_confirmed_at TIMESTAMPTZ;
ALTER TABLE cockpit_meeting ADD COLUMN minutes_materials_confirmed_by UUID;
ALTER TABLE cockpit_meeting ADD COLUMN minutes_configured_by UUID;
