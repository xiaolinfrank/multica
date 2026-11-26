# Batch changes

One change applied to many issues, with a result for each issue.

`multica issue batch update` applies one change to many issues. It takes the
same field flags as `issue update` (status, priority, assignee, project,
dates, parent, stage) plus label and property operations, and ids as
arguments or one per line with `--ids-stdin`:

```bash
multica issue batch update MUL-12 MUL-13 MUL-14 --status in_review --add-label QA
multica issue batch update MUL-12 MUL-13 --clear-labels --add-label Backend   # replace labels
multica issue batch update MUL-12 MUL-13 --property "Severity=High" --unset-property Reviewer
multica issue list --status todo --output json --fields identifier | jq -r '.issues[].identifier' \
  | multica issue batch update --ids-stdin --priority high --dry-run
```

- Each issue is written on its own and gets a row: updated, unchanged
  (already matched), or skipped with a reason (for example `parent_cycle`,
  `workflow_rejected`, `assignee_not_allowed`). The command exits non-zero when
  any issue was skipped, after printing every row; fix those issues and rerun
  only them.
- `--add-label` / `--remove-label` leave other labels alone; `--clear-labels`
  removes every label first. Multi-value properties are set or unset as a whole.
- `--dry-run` runs every check and prints the same rows without writing.
  `multica issue delete <id>... --dry-run` does the same for deletion.
- A batch status or assignee change has the same side effects as a single
  one, issue by issue; add `--no-start` to change ownership without starting
  agent runs.

## Operation basis and batch receipts

Before a protected edit, read `POST /api/issues/operation-basis` with 1–100 unique
`issue_ids` in the current workspace. It explains field restrictions and provides
at most three real destinations. `unavailable`/`unknown` never means unrestricted;
normal primary ownership differs from permanently retained production history.

Batch update remains per-item; batch delete remains one atomic transaction for
its loaded targets. Both retain their old HTTP status and `updated`/`deleted`
count, and add `requested_ids`, `results`, `unconfirmed_ids`, `transaction_mode`
and `transaction_outcome`, including in error bodies. `applied` confirms commit;
`rejected` did not commit; `not_attempted` was not tried; `not_applied` with
`batch_rolled_back` was tried but rolled back. Unknown commit IDs have no invented
result. Optional `expected_revisions` maps requested UUIDs to positive revisions
checked in the transaction. This is not durable command idempotency: never
blindly replay a partial or unknown batch, and never equate Issue done with a
formal artifact or acceptance decision.
