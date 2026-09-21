-- Fork-only (900-999 range): the meeting log grows into the board's meeting
-- register. 916 recorded what a meeting WAS — a date, a span written the way
-- people wrote it, a title, attendees, a conference number. Running meetings
-- from the board needs what a meeting is FOR and what it left behind: which
-- organisations sat down, who called it, where it happened, what was decided,
-- and where the material lives.
--
-- All text, all defaulted: the board records the vocabulary a programme
-- already uses (like cockpit_node.status), so kind and status are free text
-- rather than enums a migration would have to keep chasing.
--
-- start_time/end_time are the structured span the calendar views place a
-- meeting by. time_range keeps the free text 916 recorded — it is what an
-- import or the CLI still writes and what a row nobody has re-timed still
-- reads as — and the backfill at the foot of this file rescues the common
-- "10:00-11:00" / "10:00–11:00" shapes so the meetings already on the board
-- land on the calendar without anyone retyping them.
ALTER TABLE cockpit_meeting
    -- Platform-assigned number, "20260921-01": the date plus that day's
    -- sequence. Distinct from meet_no, which is the conferencing system's
    -- dial-in number and belongs to the provider, not the programme.
    ADD COLUMN code       TEXT NOT NULL DEFAULT '',
    -- 例会 / 评审 / 研讨 / 对外交流 — the programme's own vocabulary.
    ADD COLUMN kind       TEXT NOT NULL DEFAULT '',
    -- 计划中 / 已确认 / 已召开 / 已取消, again in the board's own words.
    ADD COLUMN status     TEXT NOT NULL DEFAULT '',
    -- Recurring meetings name their series ("项目组周例会") so a run of them
    -- reads as one thread instead of thirty unrelated rows.
    ADD COLUMN series     TEXT NOT NULL DEFAULT '',
    -- The organisations at the table. attendees lists people; a joint
    -- programme is steered by which PARTIES showed up, and the generated
    -- meeting name is built from these.
    ADD COLUMN parties    TEXT NOT NULL DEFAULT '',
    ADD COLUMN organizer  TEXT NOT NULL DEFAULT '',
    ADD COLUMN location   TEXT NOT NULL DEFAULT '',
    ADD COLUMN start_time TIME,
    ADD COLUMN end_time   TIME,
    -- What the meeting produced. Kept apart from note (the agenda and running
    -- remarks) because a minute, a decision and an action item are read by
    -- different people at different times.
    ADD COLUMN minutes    TEXT NOT NULL DEFAULT '',
    ADD COLUMN decisions  TEXT NOT NULL DEFAULT '',
    ADD COLUMN actions    TEXT NOT NULL DEFAULT '',
    -- Absolute path of the meeting's folder on the shared NAS, as the daemon
    -- hosts mount it. Same contract as project.collab_path (928): the server
    -- stores what it created and never resolves it on read.
    ADD COLUMN nas_dir    TEXT NOT NULL DEFAULT '';

-- Backfill the structured span from the free text. The pattern only matches a
-- legal wall-clock pair, so the cast can never fail the migration; anything
-- else (a single time, "全天", an empty string) is left for a human.
UPDATE cockpit_meeting AS m
SET start_time = (s.span[1])::time,
    end_time   = (s.span[2])::time
FROM (
    SELECT id,
           regexp_match(
               time_range,
               '((?:[01]?[0-9]|2[0-3]):[0-5][0-9])[^0-9]{1,5}((?:[01]?[0-9]|2[0-3]):[0-5][0-9])'
           ) AS span
    FROM cockpit_meeting
) AS s
WHERE m.id = s.id AND s.span IS NOT NULL;
