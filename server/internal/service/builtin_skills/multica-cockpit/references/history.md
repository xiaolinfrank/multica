# Bounded minutes working state and history

Use these reads for long-running meetings. They never advance a workflow or
create a board, and do not download all historical minutes.

```bash
multica cockpit meeting workflow summary <meeting-id>
multica cockpit meeting workflow versions <meeting-id> --page-size 25
multica cockpit meeting workflow version <meeting-id> <version-id>
multica cockpit meeting workflow handoffs <meeting-id> --page-size 25
multica cockpit meeting workflow exports <meeting-id> --status active
```

The summary keeps current working and published official version metadata
separate, plus exact history counts and current published NAS target. Starting a
new review round does not invalidate the previous official publication.

Version metadata excludes document body and review feedback. Read a single
version explicitly for evidence; never infer its contents from a title or hash.
History pages carry workspace/meeting scope, workflow revision, total and cursor.
Default page size is25, maximum100; preserve scope, filters and size on a cursor.
Exports optionally filter `--version-id` and `--status` (`queued`, `running`,
`retry_wait`, `succeeded`, `needs_attention`, or `active`). Changing a filter starts
at the first page. Total means the full matching scope, not just visible rows.

## Compact command results

Add `--compact` to any existing workflow write command:

```bash
multica cockpit meeting workflow submit <meeting-id> --revision <n> --submission-key <uuid> --content-file ./minutes.md --compact
multica cockpit meeting workflow reassign-reviewer <meeting-id> --revision <n> --handoff-key <uuid> --reviewer-id <uuid> --reason "Review responsibility changed" --compact
```

Results contain `representation: compact`, workspace/meeting IDs, current
`workflow` summary and an exact `receipt`. Receipt actions are `enabled`,
`readiness`, `released`, `submitted`, `reviewed`, `published`,
`reviewer_reassigned`, `nas_export_queued`, `nas_export_retried`.

The receipt has nullable `version`, `handoff`, `nas_export` objects. A replay of
an old submission/handoff returns that operation even if many newer records exist.
Do not confuse the newest summary with the command's receipt. Keep the original
key and inputs when retrying; a newer current version or reviewer is not itself
proof that the original request failed. An unconfirmed receipt may follow a
successful business write: inspect state before attempting a new command.
Submission keeps the existing server rule of trimming surrounding whitespace
before freezing text; content/hash acknowledgments use that stored form.

Compact does not grant permission or skip human review. Existing human/agent
credential gates, revision checks and NAS destination rules remain. Neither an
issue's done status nor a successful Agent Run approves the document.

## HTTP

All routes start `/api/cockpit/meetings/{meetingId}/workflow` and require workspace
membership with `X-Workspace-ID`.

| GET suffix | Meaning |
| --- | --- |
| `/summary` | Bounded header and current/published pins; no history arrays |
| `/versions?page_size&cursor` | Descending version metadata page |
| `/versions/{versionId}` | One exact full version and current permissions |
| `/reviewer-handoffs?page_size&cursor` | Handoff ledger page with version numbers |
| `/exports?version_id&status&page_size&cursor` | NAS operation page with source metadata |

Existing writes opt in through `?response=compact`. Existing `/workflow` GET,
CLI `show`, and writes without the option retain their previous full output
contract for installed clients/scripts. New flows should use focused reads.

The relationship response's additive `required_roles` derives from formal
workflow facts, including retired review tasks. It protects those relationships
even when their versions are outside the loaded page. It is not an editable tag.

Counts still read scoped facts; bounded output is not a constant-cost performance
promise. This change does not add NAS filesystem monitoring or automatic approval.
