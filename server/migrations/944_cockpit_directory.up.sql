-- Fork-only (900-999 range): the programme's contact book for its meetings.
--
-- Parties and attendees on a meeting are free text (929); nothing links the
-- people at the table to the organisations they represent. The directory is
-- that link, one row per (cockpit, party, name) with the person's 职位, so
-- the meeting form can offer a unit's people once the unit is chosen. Rows
-- are accumulated by the form itself — a typed-in unit, person or position is
-- upserted on save — and seeded for existing boards in 947.
--
-- Identity is the (cockpit_id, party, name) triple, so no surrogate id and
-- no inline PRIMARY KEY (repo convention, see 923-925): the backing unique
-- index is built CONCURRENTLY in 945 and attached as the primary key in 946.
-- No foreign key: the sweep lives in DeleteWorkspaceCockpitData.
CREATE TABLE cockpit_directory (
    workspace_id UUID NOT NULL,
    cockpit_id   UUID NOT NULL,
    -- '' is a real answer: some contacts are known without their unit.
    party        TEXT NOT NULL DEFAULT '',
    name         TEXT NOT NULL DEFAULT '',
    -- Free text, never an enum — a title is how the person introduces
    -- themselves, and it changes without a deploy.
    position     TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
