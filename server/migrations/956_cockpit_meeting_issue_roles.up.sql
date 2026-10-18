-- Explicit workflow purposes are independent of the historical provisioning
-- marker. Existing links stay unclassified until a member assigns purposes.
ALTER TABLE cockpit_meeting_issue
    ADD COLUMN roles TEXT[] NOT NULL DEFAULT '{}';
