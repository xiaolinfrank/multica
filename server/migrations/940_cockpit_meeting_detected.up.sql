-- Fork-only (900-999 range): this row was read off the share, not typed.
--
-- Meetings happen whether or not anyone opens the register, and their
-- material lands in the archive folder either way. Scanning that folder for
-- meetings nobody recorded turns those folders into rows — but the date,
-- number, parties and subject are GUESSED from a folder name a human wrote
-- freehand, so the row must say so. detected marks a row as machine-read and
-- unconfirmed; the register shows it, and clearing the flag is how someone
-- says they have checked it.
ALTER TABLE cockpit_meeting
    ADD COLUMN detected BOOLEAN NOT NULL DEFAULT FALSE;
