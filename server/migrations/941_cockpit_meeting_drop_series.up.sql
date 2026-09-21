-- Fork-only (900-999 range): the meeting register has no use for "series".
--
-- 929 gave every meeting a series alongside its type, on the theory that a
-- recurring meeting would want naming its run ("周例会", "月度评审"). In
-- practice that is what the TYPE says, and the two fields were filled with
-- the same words or left empty — a second box that only ever asked the same
-- question twice. Dropped rather than hidden: a column nothing writes and
-- nothing reads is a field someone will find in an export and act on.
ALTER TABLE cockpit_meeting
    DROP COLUMN IF EXISTS series;
