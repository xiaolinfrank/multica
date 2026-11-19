# Review queue and realtime frames

The path between an observation and an edit, and what the server broadcasts when the board moves.

## Pending changes

The review queue between an observation and an edit. A proposal is one field of one node carrying a new value; nothing on the board moves until a human applies it. This is how an agent reports board drift it observed: never PATCH the node directly on the programme's behalf — file the change and let the programme decide.

A proposal body is `{node, field, new_value, reason}`, where `node` accepts a UUID or a `code` like every other route, and `new_value` is text (numbers and dates canonicalised server-side; an empty string is a real edit meaning "clear the field", except for `progress` which must be a number 0-100). `reason` is required from a task credential — what is inconsistent and why the update is necessary — and optional for humans; either way it is capped at 2000 characters, and the same cap family guards the 500-character note a rejection may carry.
Proposable fields: `name`, `owner`, `collaborators`, `status`, `progress`, `start_date`, `end_date`, `current_progress`, `deliverable`, `dependencies`, `note`, `vendor`, `budget_category`, `budget_amount`, `exec_status`, `contract`, `color`, `source`. Tree shape (`code`, `parent_id`, `position`) is not proposable.

`name` is only proposable on a work item. L1/L2 rows project their project/module title, so a rename belongs on the project or module, not on the queue.

The server judges each proposal before it queues anything:

- value identical to the board's current one → skipped (`no_change`);
- an open proposal for the same (node, field) already exists → its value is replaced when different (`updated`, latest intent wins) or returned as-is when identical (`duplicate`);
- bad field, unparseable value, or unknown node → rejected; on the batch endpoint this is one item's outcome, never the whole request's.

Batch ingest answers one result per proposal, machine-readable: `{node, field, status, reason, id}` with `status` one of `queued`, `updated`, `skipped`, `rejected`. The `source` a queued change carries (`manual` or `agent`) is derived from the authenticated caller, never from the body.

Apply/reject require a human actor, and direct node PATCHes refuse machine credentials outright (403, pointing here): the queue is the only write path for what an agent observes. An agent may withdraw only proposals its own task filed. Decisions are one-way: all decisions answer 409 on a change that is no longer open. Apply re-reads the live column it overwrites and records that as `old_value`, so the history stays true even when the board moved between filing and deciding. Applied and rejected decisions leave a system comment on the source task's issue, rejection note included, so the requesting run learns its outcome without polling. Every request is kept: deleting a node or replacing the board by import/restore closes still-open proposals as system withdrawals (the note records why) and leaves decided history queryable; nothing about the queue is hard-deleted except with the workspace itself.

## Realtime

Every write broadcasts a `cockpit:changed` event carrying `{scope, action, entity}`.
A client patches the changed row into its cached board; a `board` scope (`imported`, `restored`) means the board changed wholesale and has to be re-read; a `snapshots` scope means only the version history moved — an edit past the auto-checkpoint interval also lands here with action `created`; a `changes` scope (`queued`, `ingested`, `applied`, `rejected`, `withdrawn`) means only the review queue moved — an apply also carries its own `node` scope frame with the row it wrote; a `directory` scope (`upserted`, `deleted`) means the contact book moved, and it lives outside the board read, so the frame just has clients re-fetch it.
Single reference changes use one `board/reference_changed` frame with `{relation_kind,reference}`. New clients merge its scoped single-link receipt; older clients safely refresh the board. It never sends a one-element `links` array as a complete relation set.

Filing an issue on a work item publishes the ordinary issue update event, not a board frame: `work_item_changed` is true, and `project_changed`/`module_changed` are true only when the request named those fields explicitly. A client that caches by scope must compare the event's `project_id`/`module_id`/`work_item_id`, never the two flags alone.
