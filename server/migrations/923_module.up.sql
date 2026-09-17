-- Fork-only (900-999 range): modules subdivide a project. A module is a
-- lighter grouping than a project — a slice of the project's issues the team
-- wants to see together (模块), not a unit of planning with its own metadata.
--
-- No foreign keys (repository rule). workspace_id and project_id are
-- application-layer relations; module and project deletion detach the issues
-- and remove the rows in the same request, because there is no cascade to do
-- it for them.
--
-- id is NOT declared inline as PRIMARY KEY: the repo convention (see
-- migrations 332-334) is to build the table without a primary key, create the
-- backing unique index CONCURRENTLY in its own single-statement migration
-- (924), then attach it with PRIMARY KEY USING INDEX (925). An inline
-- PRIMARY KEY would build its index non-concurrently, which the project's
-- migration rules forbid even on a new table.
CREATE TABLE module (
    id           UUID NOT NULL DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    project_id   UUID NOT NULL,
    title        TEXT NOT NULL,
    description  TEXT,
    -- Display order within the project. Appends take MAX+1; a reorder
    -- rewrites the whole set as 0..n-1.
    position     DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- NULL = the issue sits directly under its project rather than in a module.
-- Cleared by module and project deletion in application code (revision
-- bumped so clients refetch the row); there is no FK to cascade it.
ALTER TABLE issue ADD COLUMN module_id UUID;
