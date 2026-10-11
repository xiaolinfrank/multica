# Meeting directory operations

Meeting directory preparation has its own persistent plan, per-step grants,
and attempt receipts. Fixed minutes NAS export is a separate operation; see
[nas-export.md](nas-export.md). For the bounded directory commands and exact-key
recovery, read [meeting-directory.md](meeting-directory.md).

`GET /api/cockpit/meetings/destination` previews a configured destination.
`GET /api/cockpit/meetings/scan` reads existing archive folders.
`POST /api/cockpit/meetings/import` registers selected folders and returns
independent directory results. `POST /api/cockpit/meetings/{meetingId}/provision`
retains its interface and optional legacy task behavior, but directory writes
use the same persistent plan/executor. Work-package meetings use `create_task:false`.
A directory failure never requires creating a second meeting or Issue.

Project or board destinations propose paths; they do not grant filesystem
write permission. The deployment's existing single workspace NAS root must
explicitly list `prepare_subpaths` (at most 32; empty by default). Export
permission does not enable preparation. Roots and permitted boundaries must
already exist. A preview fixes the root, target and at most 32 ordered steps;
confirmation never runs an Agent or creates the optional legacy task itself.

Darwin/Linux pin directory descriptors and root identity, reject symlink
components and file conflicts, and confirm each step independently. Other
platforms refuse unsafe path-based writes. Existing files and partial folders
are never renamed, overwritten, rolled back or automatically deleted.
`created` means that attempt performed mkdir; `observed_existing` means only
that the exact directory was verified. Neither proves permanent NAS availability.

Provision returns independent `task_error` and `dir_error` outcomes.
`dir_created:true` confirms only the base directory; nonempty `dir_error` means
remaining preparation is incomplete. Retry the retained operation and inspect
its exact attempts. A new root configuration or external binding revision
requires explicit reauthorization of the selected unfinished steps. A successful
base's own binding update does not invalidate its sibling steps.

A human confirmation records that member. A task token can authorize deterministic
steps only through its current Run, Agent, preparation Issue and originating
member's permissions. It never becomes a human confirmation. An accepted plan
survives normal source-Run completion; current responsibility, permissions,
meeting cancellation and exact per-step grants still govern continuation.
A subsequent valid Run may explicitly recover the same Agent/Issue/member tuple.
Legacy natural reuse also requires that exact Agent/source Issue/originator; an
unfinished plan must still have the same responsible member. A terminal source
Run does not block this existing grant, while a new repair needs full new authorization.
Cloud credentials without a concrete task can only read existing plans.
Pause or abandon prevents future attempts; in-flight I/O may finish and is
recorded without reviving the plan. Human claim creates an explicit new grant.

These boundaries do not replace NAS account permissions or isolate two workspaces
whose administrators deliberately configure the same physical directory.

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
