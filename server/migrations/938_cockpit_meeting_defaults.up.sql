-- Fork-only (900-999 range): where a new meeting's task and folder go.
--
-- Creating a meeting opens an issue under one project+module and a folder
-- under that project's collaboration space. Which project, which module and
-- which folder is a property of the PROGRAMME, not of the code: a second
-- deployment files its meetings somewhere else, and the names ("06项目管理与
-- 规划", "06.06 多方协同与会议") must not be compiled in. The board remembers
-- what was chosen so the choice is made once and shown, pre-filled, on every
-- later meeting.
--
-- meeting_dir is stored rather than derived on every write for the same
-- reason collab_path is stored per project: the folder that answers to a
-- module is found by name, and a name match is a good suggestion but a bad
-- authority. The server proposes, a human confirms once, and the confirmed
-- path is what later meetings hang off.
ALTER TABLE cockpit
    ADD COLUMN meeting_project_id UUID,
    ADD COLUMN meeting_module_id  UUID,
    ADD COLUMN meeting_dir        TEXT NOT NULL DEFAULT '';
