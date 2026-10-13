# Meeting preparation, records and confirmation

A meeting has one shared NAS directory with fixed subdirectories. Creating a
meeting provisions that directory; prepare materials and keep minutes there.
Use the meeting's directory link instead of separate materials and work-package
folders. Inaccessible storage is an error to report, not evidence of readiness.

The meeting workspace has three sections:

- **Preparation** creates or links material-preparation Issues and related work.
- **Meeting records** creates or links the minutes Issue. The minutes Agent works
  in that Issue using the shared meeting directory and linked Issues as evidence.
- **Minutes confirmation** presents the confirmed action items. A human may
  explicitly create an Issue for each item. It is not an automatic dispatcher.

There is no agenda editor, preparation-template application, meeting input
collection, fixed-artifact meeting-reference picker, or separate follow-up panel.
Retired records remain historical data; simplification does not remove folders,
files, stored templates, agenda records, or original command receipts.

## Bounded reads

```bash
multica cockpit meeting show <meeting-id> --json
multica cockpit meeting lifecycle show <meeting-id>
multica cockpit meeting lifecycle commands <meeting-id> --page-size 25
multica cockpit meeting lifecycle command <meeting-id> <command-key>
```

Use UUIDs. Pages default to 25 and allow 1–100. Continue with `--cursor` and the
same scope and page size; the CLI never downloads all history automatically.
Command history is newest first; return to page one to see subsequent commands.
`meeting show` returns the exact meeting description, directory and bounded
Issue/node relationships. Totals and cursors identify incomplete relationship
sets; a first page is not the full set.

## Explicit human confirmation

A human-created meeting starts scheduled. A scanned record remains unconfirmed
until checked. Time-window labels are projections, not a separate start-confirm
workflow. Scheduled dates and old free-text statuses do not prove occurrence.

Writes take `--request-file <file.json>` containing a retained `command_key`, the
observed `expected_revision` and endpoint fields. Do not replace the key or file
after an unknown response. Machine credentials may read but cannot confirm
occurrence or materials; existing manager and reviewer permissions still apply.

| CLI command after `multica cockpit meeting` | Revision and body |
| --- | --- |
| `lifecycle occurrence <meeting-id>` | Lifecycle revision; transition `schedule`, `unschedule`, `end`, `reopen` or `correct_times`; optional actual timestamps or explicit null; reversals and corrections require a reason |
| `lifecycle materials <meeting-id>` | Enabled minutes work-package revision; `materials_ready` boolean |

`ended_at` is when someone confirmed the meeting ended, not the actual ending.
Optional actual times are explicit human records in RFC3339 with a timezone.
Missing fields preserve values; null means unknown. Start cannot follow end;
actual times cannot be future. Migrated confirmations never invent actual times.

Reopen reverses a mistaken end confirmation, returns the meeting to scheduled,
and retains the original receipts. It does not undo files or automatically stop
an Agent. Unschedule withdraws a schedule confirmation. Correcting actual times
retains the previous occurrence and a reason; it does not publish minutes.

Results carry scope, command key, action, replay status, the fixed `receipt` and
a current lightweight header. A later current header is not the original write
receipt. Read the exact command after a timeout or malformed acknowledgement;
a 404 is not proof that an in-flight request cannot still commit.

## Minutes and directory boundaries

Material readiness is a human declaration, not proof that every file is readable.
Preparation Issue completion does not automatically confirm materials, release
minutes, approve a record, or create action Issues. Existing explicit submission,
review and publication commands are documented in [history](history.md).

Meeting-record editing through a dedicated Agent CLI will be developed later.
Do not invent an unsupported command. Use the currently implemented minutes
Issue workflow and report missing capabilities.

Lifecycle HTTP paths remain `/api/cockpit/meetings/{meetingId}/lifecycle` with an
explicit workspace header. Agenda endpoints and commands are retired. Legacy
response fields remain disabled/defaulted where required by installed clients.
