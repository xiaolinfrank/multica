-- Fork-only (900-999 range): the sub-item a meeting is archived under.
--
-- A module is not the last level the programme files by. "06.06 多方协同与会议"
-- holds three sub-items on the gantt and three folders on the share, and
-- meeting material belongs in exactly one of them ("06.06.03 会议纪要与素材").
-- Filing at the module level put every meeting one folder too high and left
-- its task without the number the rest of the programme's work carries.
--
-- The sub-item is a cockpit_node rather than a second module because that is
-- what it is: the third level lives on the board's tree, not in Multica's
-- project→module hierarchy. Storing its id lets the server read both things
-- it needs from one row — the code the task title opens with, and the folder
-- name the material goes under. Which node it is stays a property of the
-- programme, chosen in the product and remembered here.
ALTER TABLE cockpit
    ADD COLUMN meeting_node_id UUID;
