-- Fork-only (900-999 range): collab_path binds a project and a module to the
-- directory on the shared NAS where humans and agents exchange work. Agents
-- are told to write deliverables there instead of leaving them in a
-- runtime-local workdir, which is otherwise private to one task.
--
-- Plain TEXT, nullable, no default: adding a nullable column is a
-- metadata-only change with no table rewrite. The value is an absolute
-- filesystem path as mounted on the daemon hosts (e.g.
-- /Volumes/人机协作空间/<project>/<module>); the server does not resolve or
-- stat it, so an unmounted host simply fails at the agent, not at write time.
--
-- Two columns rather than one shared lookup table: module already carries its
-- own title/description/position, and the path is a property of the row, not a
-- separate entity. Project keeps its path even when a module overrides it —
-- the module path is the more specific location, not a replacement.
ALTER TABLE project ADD COLUMN collab_path TEXT;
ALTER TABLE module ADD COLUMN collab_path TEXT;
