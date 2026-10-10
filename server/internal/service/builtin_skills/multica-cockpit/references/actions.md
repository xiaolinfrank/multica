# Meeting actions and L3 task ownership

Use the focused APIs below for large task collections. A board link is a reference;
it does not create primary ownership or change an issue's project, module or status.
One issue has at most one primary L3. Meeting action state describes its human
disposition, while execution state always comes from the linked issue.

## Bounded reads

```sh
multica cockpit node tasks <node-uuid> --page-size 25
multica cockpit node tasks <node-uuid> --category active
multica cockpit node tasks <node-uuid> --category started --query 'protocol'
multica cockpit node tasks <node-uuid> --relation reference
multica cockpit meeting action list <meeting-uuid> --status draft --page-size 25
multica cockpit meeting action list <meeting-uuid> --version-id <version-uuid>
multica cockpit meeting action show <meeting-uuid> <action-uuid>
multica cockpit issue primary <issue-uuid-or-identifier>
```

Commands return one JSON page, never silently fetch every page. Pass the returned
`next_cursor` as `--cursor` with the same scope, query and filters. Clear the cursor
when changing any filter. Page size is 1–100, default 25. UUID arguments in these
commands are explicit; `issue primary` also accepts human issue identifiers.

`total` and the L3 `summary` describe the full relation scope; `filtered_total`
applies the current search/status/category filters. Neither is a count of only
the returned page. `done`, `closed` and unknown categories remain separate.
Counts do not prove that an L3's deliverables have been accepted.
The `active` category filter excludes only done/closed, retaining unknown old
statuses for review; the summary still reports the five actual category buckets.

The task page reports `eligibility`; an eligible primary node is an execution
leaf with valid inherited project/module bindings, rather than a grouping row.
Use the existing issue search API to find reuse candidates; do not load an entire
workspace into a picker or derive primary counts from `board.issue_links`.

## Human decisions from fixed minutes

Action writes require an authorized human manager or the source version's human
reviewer. Agents may read actions and work on assigned issues, but must not switch
credentials to propose or accept an action. Automated extraction is not implemented.

```sh
multica cockpit meeting action add <meeting-uuid> <published-version-uuid> \
  --proposal-key <stable-uuid> --title 'Validate the agreed protocol' \
  --description 'Scope and acceptance requirements' --source-quote 'Exact source text'

multica cockpit meeting action edit <meeting-uuid> <action-uuid> --revision 1 \
  --title 'Revised proposal' --description 'Complete replacement text' --source-quote ''

multica cockpit meeting action resolve <meeting-uuid> <action-uuid> \
  --revision 2 --decision-key <stable-uuid> --outcome create --node-id <l3-uuid> \
  --assignee-type member --assignee-id <user-uuid> --priority high --due-date 2026-12-31

multica cockpit meeting action resolve <meeting-uuid> <action-uuid> \
  --revision 2 --decision-key <stable-uuid> --outcome reuse \
  --node-id <l3-uuid> --issue-id MUL-123

multica cockpit meeting action resolve <meeting-uuid> <action-uuid> \
  --revision 2 --decision-key <stable-uuid> --outcome dismiss --reason 'Already addressed'
```

`edit` replaces all proposal text, so title, description and source-quote flags
must be explicit; empty description/quote clears that field. A nonempty source
quote must appear verbatim in the fixed source version. Action revisions differ
from meeting workflow revisions.

Create and reuse require the current approved, published source version. Accepted
actions from older versions retain their source and issue. An obsolete pending
proposal can be dismissed with a reason; it cannot silently become a new directive.

Create produces a backlog issue, defaults to the current human when no executor
is specified, inherits the L3 project/module, and does not dispatch an agent.
Reuse preserves the existing issue's content, status, executor, priority and due
date. Those new-task flags are rejected for reuse. Scope mismatch or ownership
under another L3 is a conflict, not authorization to move the issue.

Keep the same proposal/decision key and the original request for a retry. A key
cannot identify a different actor or intent. After an uncertain response, read
the actions before retrying; never invent a new key to bypass a conflict. CLI
writes check their action/decision/source receipt and do not treat an unrelated
HTTP 200 response as success.

## Direct L3 task creation and explicit ownership

```sh
multica cockpit node create-task <l3-uuid> --creation-key <stable-uuid> \
  --title 'Deliver the validation report' --description 'Acceptance requirements'

multica cockpit issue primary MUL-123 --node-id <l3-uuid> --revision 0
multica cockpit issue primary MUL-123 --clear --revision 1
```

These writes require a human credential. Direct creation atomically creates a
backlog issue with primary ownership; it does not perform an ordinary create
followed by a best-effort link. Retain its creation key across uncertain responses.
Read the ownership revision before changes; revision 0 means no ownership record.
Changing primary L3 preserves issue project/module and requires matching scope.
The former primary remains a reference; new primary tasks are read through the
paginated endpoint, not injected into every board load.

## HTTP contract

All routes use the current `X-Workspace-ID` and `/api/cockpit` prefix.

| Method/path | Contract |
| --- | --- |
| GET `/nodes/{id}/tasks` | `q,status,category,relation,cursor,page_size`; scoped page, counts and eligibility |
| POST `/nodes/{id}/tasks` | `creation_key,title,description,priority,assignee_type,assignee_id,due_date`; lightweight issue receipt |
| GET `/issues/{id}/primary-node` | primary node, revision and scope |
| GET `/issues/{id}/actions` | `cursor,page_size`; read-only accepted sources with meeting/version identities, title, total and next cursor |
| PUT `/issues/{id}/primary-node` | `node_id` (UUID or null), `expected_revision` |
| GET `/meetings/{id}/workflow/actions` | `version_id,status,q,cursor,page_size`; scoped action page |
| GET `/meetings/{id}/workflow/actions/{actionId}` | current single action, including capabilities and issue facts |
| POST `/meetings/{id}/workflow/versions/{versionId}/actions` | `proposal_key,title,description,source_quote`; single action |
| PATCH `/meetings/{id}/workflow/actions/{actionId}` | `expected_revision,title,description,source_quote`; single action |
| POST `/meetings/{id}/workflow/actions/{actionId}/resolve` | `expected_revision,decision_key,outcome` plus explicit outcome fields; single action |

Actions expose `draft/accepted/dismissed`, their fixed source version/hash,
optional original quote, resolution, linked issue facts and per-action capabilities.
Check `source_superseded`, `can_edit`, `can_resolve` and list-level `can_add` before
offering actions. Unknown server values remain read-only until understood.

## Inspect operation constraints before editing

`POST /api/issues/operation-basis` is a read-only batch with `issue_ids` (1–100
unique UUIDs) and the selected workspace header. Read the current page's IDs
once; unavailable or unknown rows never mean unrestricted. The response separates
status categories, reassignment, scope, parent, primary ownership, deletion and
execution. Its bounded structured targets point to the real formal decision or
retained context; ordinary Issue completion never approves an artifact.

Node, project and module `GET .../{id}/operation-basis` reads explain deletion
constraints. A retained L3 also restricts structural changes and adding children;
ordinary labels and planning status remain editable. A normal primary Issue may
be deleted, while a retained production source cannot be moved by merely clearing
primary ownership. These reads do not replace the actual transaction guards.
