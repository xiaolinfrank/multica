# Meeting directory operations

Meeting directory preparation is separate from fixed minutes NAS export. The
former prepares folders; the latter has a durable operation/attempt ledger and
explicit atomic/create-only modes documented in [nas-export.md](nas-export.md).

`GET /api/cockpit/meetings/destination` previews a configured destination.
`GET /api/cockpit/meetings/scan` lists existing archive folders.
`POST /api/cockpit/meetings/import` registers selected existing folders.
`POST /api/cockpit/meetings/{meetingId}/provision` prepares folders and optionally
the legacy meeting task; meetings with a work package use `create_task:false`.

The root is the selected project's configured collaboration directory, or the
board's confirmed directory for that exact project/module/archive-node choice.
All supplied references must belong to the workspace; a selected module must
belong to the selected project. Changing the selection cannot inherit an old
confirmed directory from a different selection. A failed attempt cannot remember
that old directory as the new selection's destination.

A one-shot `base_dir` may narrow this root; it cannot promote an unrelated path
into a new root. Configure the project/board destination explicitly first. The
root must already exist and is never created by provisioning.

On Darwin/Linux, directory operations pin the existing root identity and use
relative descriptors with no-follow opens below it. A platform alias in the
root's ancestors may resolve to the same real root; the final root itself must
not be a symlink. Symlink children and regular files cannot be accepted as
directories. Replacement/movement of the opened root or a child is detected
before confirming filesystem success. Other server platforms refuse these
directory operations rather than use an unsafe path-based fallback; storing a
cross-platform path as metadata remains supported.

Provisioning returns independent `task_error` and `dir_error` outcomes. Existing
files are not overwritten; partial directories are not automatically deleted.
`dir_created:true` confirms the meeting directory, while a nonempty `dir_error`
can still report missing subfolders. Do not treat a partial response as an
all-or-nothing rollback, or create another meeting/issue to retry a directory.

These checks constrain an operation beneath the configured root. They do not
provide physical isolation when administrators explicitly configure two
workspaces to share the same directory, nor replace NAS account permissions.

## Workspace contact book

Contacts are shared by the workspace, independently of the project/module in
view. `GET /api/cockpit/directory/page` is a read-only, bounded contact search:
`q`, `party` or repeated `parties` (OR, at most 20), `cursor`, `page_size` (25,
maximum 100). `party=` selects contacts without a unit. Omitting both unit
filters searches all contacts. Project/module query fields are rejected.
The response echoes workspace/scope/search/normalized unit filters and returns
`items`, the full filtered `total`, and `next_cursor`; reads never create a board.
Continue with the same filters and page size; a cursor from another scope fails.

`PUT /api/cockpit/directory?response=compact` accepts `entries` identified by
`party` + `name`. It returns only final deduplicated saved rows, never the book.
An empty/missing `position` preserves existing text; `clear_position:true`
explicitly clears it and cannot be combined with a nonempty position.
Automatic filing may set `only_unknown_names:true`: an existing name under any
unit in this workspace is skipped, without guessing a second affiliation.
The receipt distinguishes actual `entries` from `skipped` natural keys.
Manual contact editing leaves this option false.

`DELETE /api/cockpit/directory?response=compact` accepts one natural key and
acknowledges it in `deleted`. Seeded roster/unknown-source contacts cannot be
deleted. All compact receipts include `workspace_id`, `scope:'workspace'`, and
`action`; do not treat a legacy full-book response as a confirmed compact write.
Existing requests without `response=compact` retain their full-book response.
Compact writes emit one `scope:'directory', action:'changed'` notification:
old clients refresh, newer clients invalidate the paged directory cache. A saved
subset is never presented as the entire contact book.
