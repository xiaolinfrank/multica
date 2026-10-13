# Meeting preparation and disposition

Normal preparation is ordinary material-preparation Issues linked to a meeting.
Minutes work lives in the linked minutes Issue, and files use the meeting's one
NAS directory. There are no reusable preparation templates or agenda effects.
See [meeting lifecycle](meeting-lifecycle.md) for the three-section workspace.
Direct Issue and execution-item associations, including their purpose labels,
remain editable after a meeting ends, is cancelled or is archived. These edits
never create or execute work; protected minutes/review work-package links remain
required. Creating new preparation work still requires an open meeting.

The existing `multica cockpit meeting preparation` commands below manage
cancellation/disposition plans, not a second material-preparation workflow.
Inspect `/api/cockpit/context` capability `meeting_disposition`; absent or false
means unavailable. Reads require the existing workspace scope. Writes require a
human member and an explicit request file; machine credentials cannot confirm.

## Read exact cancellation plans

`preparation list <meeting-id>` reads one page of cancellation plans. `show
<meeting-id> <operation-id>` reads progress; `effects <meeting-id> <operation-id>`
reads one effect page; `effect <meeting-id> <operation-id> <effect-id>` reads an
exact effect and its fixed receipt. Pages default to 25, allow 1–100, and return
`total` and `next_cursor`. Preserve scope, filters and page size with the cursor.
The CLI never automatically fetches later pages. Retired template applications
are preserved in storage but are not returned or executable through these endpoints.

`preparation basis <meeting-id>` reads availability, pending counts and recovery
targets. `impact <meeting-id> --query <text>` pages affected Issues; `runs
<meeting-id> <issue-id>` reads that Issue's run page. A loaded page is not a total.

## Cancellation and explicit effects

`cancellation-preview <meeting-id>` accepts a reason, explicit Issue choices and
exact Run IDs. Choices are retain, cancel Issue, change due date, or link another
meeting. The response distinguishes `cancel` from `append_disposition` for an
already cancelled meeting. `cancel` and `dispose` submit the reviewed plan with
a retained command key, observed lifecycle revision and preview context token.
Later plans do not replace the original cancellation time, actor or reason.
Each plan has at most 50 effects; additional plans can address remaining work.

A `link_meeting` Issue choice supplies only `target_meeting_id`; there is no
agenda target. Applying it adds a direct association with the `preparation`
purpose, preserving any existing purposes and the source meeting association.
The retained Issue keeps its ownership and execution state.

`execute <meeting-id> <operation-id> <effect-id>` applies one effect with its
original command key and observed authorization key/revision. Execute serially;
stop on unknown results, context changes, pauses or lost permission. This does
not create material-preparation Issues, create directories or start an Agent.

Cancelling an Issue disables ordinary wakeups and cancels only unstarted wakeup
queue entries. Active Runs and unrelated queued work continue unless selected.
System rules remain recorded and dormant while closed; configured parent rules
may be evaluated. Stop targets one exact Run under existing task permissions.
`changed: false` with a terminal status means it was already terminal, not that
an external process has exited. Read exact task metadata before its transcript.
Bounded receipt identity samples are not full histories; totals/hashes cover the
complete recorded effect.

## Recovery, restoration and archive

After an uncertain write, retain the exact request and keys. Read the exact
operation/effect or `meeting lifecycle command <meeting-id> <command-key>`.
GET does not execute work; a current header cannot acknowledge an earlier write.
A missing read is not proof that the write cannot commit. Never resolve uncertainty
by creating a replacement key or a duplicate Issue.

`control <meeting-id> <operation-id>` accepts pause, resume, skip or claim with
observed revision, retained key and reason; only skip carries an effect ID.
Claim transfers responsibility but does not inherit another actor's permissions.

For a failed effect, `authorization <meeting-id> <operation-id> <effect-id>`
compares the original grant to current Issue/Run facts. `reauthorize` requires a
new human key, observed effect revision, preview token and reason. It changes
only the grant, not intent or target. Execute with the confirmed new grant.
Applied effects cannot be reauthorized; removed targets are not recreated.

`disposition <meeting-id>` accepts reinstate, archive or unarchive with lifecycle
revision, key and reason. Reinstate returns a cancelled meeting to scheduled;
it does not restart agents or paused directory plans. Archive hides the meeting
from the default register but retains files, minutes, reviews, receipts and
existing authorized work. `meeting page --archive active|archived|all` chooses the
register view. Protected deletion points to the retained source or archive path.

Meeting HTTP paths are under `/api/cockpit/meetings/{meetingId}`: cancellation
impact, preview, cancellation and cancellation dispositions; operation basis;
lifecycle disposition; and preparation-operation reads, effects, apply,
authorization-preview, reauthorize and control. Template and template-application
paths are retired. Existing records remain protected during board replacement
and are cleaned up only as part of an explicitly deleted workspace.
