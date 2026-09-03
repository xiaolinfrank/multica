-- Fork-only (900-999 range): the programme's meeting log, shown as the
-- "recent meetings" card on the overview. Kept on the cockpit rather than in a
-- calendar integration because what the board needs is the decision record —
-- who attended, the conference number, the note — not an invite.
CREATE TABLE cockpit_meeting (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    cockpit_id   UUID NOT NULL,
    meet_date    DATE,
    -- Free text ("10:00–11:00"): the board records a span as people wrote it,
    -- across timezones it was never normalised to.
    time_range   TEXT NOT NULL DEFAULT '',
    title        TEXT NOT NULL DEFAULT '',
    attendees    TEXT NOT NULL DEFAULT '',
    meet_no      TEXT NOT NULL DEFAULT '',
    link         TEXT NOT NULL DEFAULT '',
    note         TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
