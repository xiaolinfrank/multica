-- Fork-only (900-999 range): which line of the programme a meeting advances.
--
-- The timeline view reads the register as four swimlanes ("高质量数据集",
-- "AI平台", "合规和质量体系", "项目管理" on the shipped board) and needs an
-- answer for every meeting, including the cross-cutting ones no work item
-- owns. Node links cannot provide it — half the register is linked to nothing
-- — so the line is the meeting's own word, free text like kind and status:
-- the picker offers the programme's vocabulary, and a fifth line does not
-- wait on a release.
ALTER TABLE cockpit_meeting
    ADD COLUMN track TEXT NOT NULL DEFAULT '';
