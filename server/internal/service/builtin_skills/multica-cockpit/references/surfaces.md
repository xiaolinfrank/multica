# Scoped cockpit reads

All endpoints require workspace membership and an explicit `X-Workspace-ID`.
These reads do not initialize a cockpit, dispatch Issues or touch NAS. The old
full-board endpoint remains an installed-client contract; new screens read only
their work surface and selected objects.

## Bounded CLI entrypoints

```bash
multica cockpit context --project-id <uuid> --module-id <uuid> --json
multica cockpit plan --project-id <uuid> --json
multica cockpit meeting page --project-id <uuid> --from 2026-10-01 --to 2026-10-31 --page-size 25 --json
multica cockpit meeting page --party 'Partner,A' --party 'Partner B' --track 'Delivery,Phase 1' --only consensus --json
multica cockpit version compare <snapshot-uuid> --page-size 25 --json
```

`--module-id` requires `--project-id`. Context and plan echo and validate that
scope; plan is a complete scoped tree within the documented server limits, not a
partial first page. Meeting `page` supports `--q`, `--from`, `--to`, `--node-id`,
`--cursor`, and `--page-size` (1–100). Repeat `--party`, `--track`, `--kind`,
`--status` or `--only`; a comma remains part of one value. `--only` accepts
`consensus`, `folder`, `links` and `detected`.

The meeting and comparison commands issue exactly one GET, preserving
`next_cursor`; they never fetch all history automatically. Reuse a cursor only
with the same scope and filters. Comparison covers the whole workspace, so it
does not accept project/module flags. A legacy or unsupported snapshot is printed
as not comparable with its reason, not as an unchanged plan. A changed-plan 409
requires restarting comparison from the first page.

New commands support `--json` or `--output json`; default tables show scope,
counts and continuation. JSON preserves the response's exact decimal values.
Existing `show`, `node list`, `meeting list` and version restore behavior remain
unchanged. None of these new reads approves, restores, publishes or starts work.

## Scope and identity

Use UUID `project_id` and optional `module_id`; a module requires its actual
parent project. Invalid or foreign scopes return an error rather than broadening
to the workspace. Responses echo workspace and scope. Copy opaque cursors only
with the original actor, scope, filters and page size.

| GET endpoint | Purpose |
| --- | --- |
| `/api/cockpit/context` | Nullable board, actor and scope titles; no collection payloads |
| `/api/cockpit/plan` | Complete scoped nodes, payments, milestones, task counts and a slim display-code index |
| `/api/cockpit/scopes/projects` | Project metadata search; `q`, `cursor`, 20 per page |
| `/api/cockpit/scopes/modules` | Module metadata search within `project_id`; 20 per page |
| `/api/cockpit/meetings` | Meeting metadata register, repeated filters and calendar counts |
| `/api/cockpit/nodes/{id}` | One node, ancestors, authoritative binding, counts and relation previews |
| `/api/cockpit/meetings/{meetingId}` | One full meeting and bounded Issue/node link previews |
| `/api/cockpit/nodes/{id}/payments` | Cursor page with total payment amount independent of the loaded page |
| `/api/cockpit/nodes/{id}/meetings` | Cursor page of meetings linked to the node or descendants, deduplicated |
| `/api/cockpit/meetings/{meetingId}/issues` | Cursor page of Issue links with roles and protected required roles |
| `/api/cockpit/meetings/{meetingId}/nodes` | Cursor page of execution links |
| `/api/cockpit/issues/{issueId}/nodes` | Issue reference nodes, separate from its primary execution owner |
| `/api/cockpit/issues/{issueId}/meetings` | Issue meeting references with protected workflow purposes |
| `/api/cockpit/meetings/next-code?date=YYYY-MM-DD` | Non-reserving meeting code preview |
| `/api/cockpit/plan/node-index` | Workspace display identity index, independent of a loaded plan |
| `/api/cockpit/plan/export-data` | Explicit complete scoped export, including deduplicated primary/reference Issue mappings |
| `/api/cockpit/changes/page` | Scoped proposal/history page with authoritative counts |
| `/api/cockpit/snapshots/page` | Workspace-wide saved-board metadata page; no snapshot body |
| `/api/cockpit/nodes/next-code?parent_id={uuid}` | Non-reserving child-code preview; omit parent_id for a root code |

Plan `context_node_ids` identifies ancestors included only to explain the tree.
Their own payments are outside a narrower scope. Use `node_index` to preserve
workspace display codes rather than renumbering a filtered tree. `complete` is
true only for a full supported plan; limits are 5,000 nodes, 25,000 payments and
2,000 milestones. HTTP 413 `scope_limit` requires a smaller project/module.
The separate 20,000-row global index limit returns `display_index_limit`; merely
changing project does not reduce that index. Do not display a truncated plan as
complete or calculate totals from a relation's first page.

Object deep links can return `scope_match: false`. Preserve the actual object's
identity and binding; offer an explicit scope switch before editing. Independent
relation pages accept no project/module filter, default to 25 and allow at most
100 rows. Their cursors belong to that object. A page is never the complete set
for a replacement write: add/remove individual links instead.

## Meeting register

`q` is a whitespace-separated AND search across title, code, track, kind, status,
parties, organizer, attendees, location, meeting number, note, minutes, decisions
and actions. Bodies participate in search but do not appear in list payloads;
`display_excerpt` contains at most 200 Unicode characters.

Repeat `tracks`, `kinds`, `statuses` and `parties` parameters for OR within each
dimension; dimensions combine with AND. An empty `tracks=` selects an unfiled
track. Party splitting preserves separators inside brackets. Repeat `only` for
AND conditions: `consensus` means nonblank decisions or actions, `folder` means
a directory is recorded, `links` means at least one live Issue/node link, and
`detected` means an imported unverified meeting. Minutes alone are not consensus.

Dates `date_from`/`date_to` are inclusive and either can be open. A date filter
excludes undated meetings. `day_counts` covers every matching meeting only when
both bounds define a window of at most 93 days; it is empty for an open or wider
window. `node_id` includes linked descendants without counting a meeting twice.
Alternatively repeat `node_ids` (up to 200 UUIDs) for a union; the two options are
exclusive, and overlapping descendants still count a meeting once.
`workflow_stage` filters the derived formal workflow stage. `items` is a cursor
page, never the source for complete calendar counts.

## Presentation and creation

Read-only `POST /api/cockpit/plan/meetings/query` accepts project/module query
parameters and JSON `{rows:[{row_key,node_ids}],date_from,date_to,cursor?}`.
A row can group several real nodes: at most 100 rows, 20 UUIDs per row and 200
unique UUIDs overall. Keys are unique nonempty strings up to 100 bytes; synthetic
view keys never masquerade as node UUIDs. Dates cover 1–93 days. Each page has at
most 500 row/date groups, with a true `total` and at most five meeting previews.
Descendant and overlapping member links count once per meeting per row. Follow
the marker to the register with its union `node_ids` and date filters for all
meetings. Responses echo canonical rows, scope and dates; a page cursor belongs
to that exact request. Do not infer totals from previews.

Explicit CSV export reads `/plan/export-data` only when requested; it uses the
same complete plan scope plus deduplicated `(node_id, issue_identifier)` mappings
and `generated_at`. Context ancestors have no exported Issue mappings. Exceeding
250,000 mappings returns 413 `export_limit`, not a silently truncated download.

A next-code preview reserves nothing. Omit `code` for automatic meeting creation;
the server allocates the final number under the cockpit lock and acknowledges
the actual meeting. Derive subsequent Issue/folder names from that acknowledgement,
not a stale preview. A deliberately supplied manual code retains its existing
meaning. Mutations and realtime updates invalidate scoped read caches; they must
not rely on an old full-board cache to update a new screen.

Creation can include `node_id` on POST `/meetings`. The meeting and its plan
reference commit atomically after workspace validation; `node_link` acknowledges
both actual IDs. A failed reference must not leave an unfiled meeting. This does
not enable a work package or provision a directory. Without an explicit node,
legacy unfiled creation remains supported. Node creation with omitted `position`
appends after existing siblings under the same board lock.

## Governance pages

`/changes/page` accepts the ordinary project/module scope, `q`, `status`, `cursor`
and `page_size` (25 by default, at most 100). Status is `all`, `pending`, `decided`,
`applied`, `rejected` or `withdrawn`. The default is `all`, with pending items
first, then newest creation time and ID. `counts.pending` and `counts.decided`
cover the scope and search before the status filter; `total` covers the current
status. Applying one proposal does not authorize applying unreviewed pages.

`/snapshots/page` accepts `q`, `cursor`, `page_size` and returns `scope:workspace`.
Project/module filters are rejected: existing snapshots freeze the whole board.
It returns metadata only. This page is not a new baseline restore mechanism and
does not relax restore guards for stable bindings or formal meeting workflows.

## Entry and navigation

Fresh workspace entry defaults to the cockpit. The personal device preference
in Settings can select Issues, My issues or Inbox instead. It affects new entry
and a new desktop tab, not an explicit object link or a restored desktop session.
Web root routing accepts only these named pages from the preference cookie.

Issue reverse references default to 25 rows and accept at most 100, with only
`cursor`/`page_size`. `/nodes` excludes the current primary execution node; read
that separately from `primary-node`. Action provenance keeps its own `/actions`
page. `available:false` preserves an orphan reference without inventing a link
destination. `required_roles` includes formal minutes and review duties,
including retired review tasks. Do not unlink a protected role or replace an
unloaded relationship collection to edit one reference.

## Reviewing a proposed field change

`GET /changes/{changeId}/preview` returns the pending `change`, `current_value`,
`conflict`, `workspace_id`, actual inherited project/module `context` and a
quoted `review_token` (also the ETag). The read
is one repeatable-read snapshot and sends `Cache-Control:no-store`. A conflict
means the actual field has changed since the proposal was filed. Show the
proposal's old value, the actual current value and the proposed replacement;
a person can then explicitly approve replacing that current value.

Send that exact token in `If-Match` to `POST /changes/{changeId}/apply`. The
server locks and rereads the proposal and target node inside the transaction.
An intervening proposal revision, ancestor/binding move or change to the reviewed field returns 409
`review_changed`; no field is written. A decision already made also returns
409. Do not automatically fetch a new token and retry: a new preview requires
another human decision. Unrelated fields do not invalidate the review, allowing
several reviewed fields of one node to be applied sequentially.

Apply and reject forbid task-token/cloud-agent credentials; these identities
can submit proposals. Ordinary human-client writes without If-Match retain the
existing response contract, but new interfaces always use a displayed preview.
The recorded `old_value` is the actual value overwritten. A batch means only its
explicitly previewed IDs, not every pending page; stop at the first conflict and
report completed and remaining items separately. Realtime or focus refetches
must never silently replace the preview while the confirmation is open.

The preview context is authoritative. Show its project and module names rather
than assuming the queue's current filter still owns the item. A scoped view
cannot approve an item that has moved elsewhere: provide an explicit switch to
the current scope, then fetch and review again. The token fixes the complete
ancestor chain and effective binding as well as the displayed field; the leaf's
direct IDs alone cannot detect moving one of its ancestors.

## Durable node and meeting creation

`POST /api/cockpit/nodes` and `POST /api/cockpit/meetings` accept an optional UUID `creation_key`. New integrations must retain the exact submitted body and key until the outcome is known. For server-allocated node codes, send `auto_code:true`, a key, and omit `code`; the preview is not a reservation. The board lock protects final node and meeting numbering. Manual node codes remain supported without `auto_code`.

A keyed success includes `workspace_id`, `creation_key`, resource `id`, and `replayed`. The same workspace/kind/key with the same actor and request returns its original creation receipt with `replayed=true`; load the resource's current detail before displaying or editing it. That receipt does not describe later edits or relations and must not overwrite a live cache. A different request or actor returns 409. If the original object has been deleted or replaced by import/restore, replay returns 410 and never recreates it. Do not switch keys automatically after an unknown response.

The resource, requested meeting anchor, and durable receipt commit together. Invalid input or a failed receipt write leaves none of them committed. Creation receipts remain through board replacement and are removed during workspace deletion. Requests without a key retain the existing API behavior and do not receive this retry guarantee.

Budget proposals respect the stored decimal precision: absolute value below
10,000,000,000 and no more than four decimal places; an empty value still clears
the budget. Inputs requiring silent rounding or overflowing the column are
rejected before entering the queue, so the reviewed amount is the applied amount.

A definite 409 `node_binding_exists` includes the same workspace/key and a verified `existing_node_id`. Open that plan item to inspect its binding instead of repeating the same binding creation. Unknown conflicts do not authorize discarding a pending command or switching its key.

## Read-only plan snapshot comparison

Saving a manual snapshot with `POST /api/cockpit/snapshots` now adds versioned
`plan_identity` metadata with stable node/payment/milestone UUIDs. Ordinary
automatic checkpoints also carry it. Import/restore protection snapshots keep
their older format. Existing restore restrictions and the 50-snapshot retention
limit remain; this does not approve a formal baseline or restore stable objects.

`GET /api/cockpit/snapshots/{snapshotId}/diff?cursor=&page_size=25` compares the
current whole-workspace plan with that snapshot. It never writes or initializes
a board. Project/module filters are rejected; pages default to 25, maximum 100.
The complete comparison supports 5000 nodes, 25000 payments and 2000 milestones;
larger plans return 413, not a partial diff.

`comparable:false` has an explicit reason: old/missing identity, unsupported
format, incomplete/damaged identity, missing cockpit or replaced cockpit. Do not
match old codes/names to current UUIDs or interpret this as “no changes.” For a
comparable result, added/removed/modified are relative to the saved plan, and
counts cover the entire plan. Long field values are marked truncated and retain
the full JSON value's SHA-256. The cursor pins both plans' content; a 409 while
paging means restart from page one. This endpoint cannot apply its differences,
approve a baseline, or remove history. Meetings, Issue/Run history and formal
acceptance facts are outside the comparison.

## Meeting directory scan and import

Destination and scan reads do not initialize a cockpit. Scan uses meeting
identity/date/directory metadata, without loading meeting descriptions or minutes.
Keep the returned `base_dir` with the scanned draft. New import clients send it
as `expected_base_dir`; the server compares it with the currently configured
destination before opening the archive or creating records. A 409
`directory_changed` requires an explicit new scan. This value is a consistency
check, never a new authorization root. Older callers may omit it.

Import can create a meeting while failing to create its requested task. Such a
folder appears in both `meetings` and `skipped`. Match created meetings by their
recorded `nas_dir`, preserve them as completed results, and retry only folders
that have not been registered. Do not add the two array lengths to infer a
receipt error or discard unfinished edits after a partial result. Keep a scan
fixed during editing; refocus and realtime invalidations must not replace its
editable guesses. Explicitly rescanning starts a new source snapshot.

Web and desktop requests keep the initiating workspace header for destination,
scan, import and provision. Missing or malformed read/write receipts are not
empty destinations or confirmed success. Preserve the draft and allow recovery
when a write result cannot be confirmed.

## Service availability

Context and object detail responses expose `capabilities.artifacts` and
`capabilities.acceptance`. These describe implemented services, not permission
to write. Missing, unknown or false values leave those entry points unavailable;
existing tasks, meeting materials and NAS operations keep their own contracts.
The current backend advertises both as false until their persistent services are
implemented and verified. A visible client component is not evidence that an
endpoint exists. Preserve an unavailable deep link as a clear explanation and
provide a real route back to the plan, without making unsupported API calls.
