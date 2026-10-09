# Fixed published minutes on NAS

An authorized human manager or that version's reviewer can request a NAS copy.
They must remain a workspace member. Agents and other machine credentials cannot
publish, export or retry; do not replace credentials to bypass a refusal. Export
is a deterministic background operation, not another Issue or Agent Run.

Read `nas_destination: {root_id, directory} | null` and
`nas_unavailable_reason` from workflow show. The directory is the meeting's
confirmed **absolute server path**, not a path on the CLI user's machine.
Preview validates configuration and scope, not network availability. A new
export must still match the current meeting directory when its transaction
locks the meeting; an outdated preview returns 409. Refresh and reconcile intent.

Publication accepts optional `nas_export: {root_id, directory}` alongside its
normal workflow `expected_revision`. Omitting it preserves platform-only
publication. With it, the publication and export intent commit together before
any filesystem work. Invalid/unconfigured targets are refused; an offline NAS
does not prevent publication. A failed copy never changes approval, fixed text,
or platform publication, and does not require another review.

POST `.../workflow/versions/{version-id}/nas-export` accepts `{root_id,directory}`
without a workflow revision. It can export any retained approved, previously
published version, including an older one. The natural key is workspace,
version, root identity and relative target path. Repeating it returns the same
operation; an existing confirmed intent retains its original path even if the
meeting directory later changes. A different newly confirmed target creates
another record, never silently retargets an old operation.

`nas_exports` contains `id`, `version_id`, `version_number`, `source_issue_id`,
`content_hash`, `root_id`, `directory`, `target_path`, `status`, `attempts`,
`revision`, `next_retry_at`, `created_at`, `updated_at`, `completed_at`,
`last_error_code`, `last_error`, nullable `size_bytes`, and `can_retry`.
`can_export_nas` is the current published version's capability hint; the server
rechecks each command. Older backends omit these fields; do not interpret that
as an export acknowledgement. A queued response is not proof that a file exists.

States are `queued`, `running`, `retry_wait`, `succeeded`, `needs_attention`.
Each manual cycle permits eight automatic attempts with exponential backoff
capped at five minutes. POST `.../workflow/exports/{export-id}/retry` uses the
**operation's** `{expected_revision}` from `nas_exports`, not the work-package
revision. It retains lifetime attempts and the fixed target, resets the cycle
budget, and never overwrites a conflicting file. A stale revision returns 409;
read the operation again before deciding whether to retry. Already queued,
running or successful records with the current revision are unchanged.

The configured server writes the database version's exact UTF-8 bytes to
`<directory>/已发布纪要/minutes-v0001-<full-version-UUID>.md`; the version number
uses at least four digits. There is no added header or newline normalization.
It verifies the root identity, walks existing directories without following
links, writes/syncs an operation-specific temporary file, and commits atomically
without replacement. Existing identical bytes reconcile an uncertain commit;
different content or unsafe files require attention. Existing-file recovery
also confirms directory synchronization. Moved/replaced directories are checked
before commit and before acknowledging the original path. This cannot prevent
later human moves or tampering; successful export records the verified receipt,
not continuous synchronization. Kernel NAS I/O may block despite cancellation.

Operators configure `COCKPIT_NAS_EXPORT_ROOTS` as a JSON array, for example:

```json
[{"workspace_id":"<uuid>","root_id":"<uuid>","path":"/mounted/share/workspace","allow_local":false}]
```

There is one root per workspace; root IDs are unique and workspace roots cannot
overlap. The preexisting `.multica-root-id` text must equal `root_id`. The server
does not create the root, marker or meeting directory; it only creates the
published-minutes subdirectory. macOS/Linux network mounts are required by
default. `allow_local:true` is an explicit operator/test choice, not an automatic
fallback for an offline mount. Unsupported atomic commit/sync capabilities are
reported; actual SMB/NFS capabilities need deployment verification. Removing
root configuration leaves its queued records waiting for an eligible executor.
Workspace deletion removes ledger rows but leaves NAS copies; an already-started
external write may finish, and its late result cannot recreate deleted records.

## CLI

```sh
multica cockpit meeting workflow publish <meeting-id> <version-id> --revision <n> --nas-root-id <root-uuid> --nas-directory '/mounted/share/workspace/meeting'
multica cockpit meeting workflow export-nas <meeting-id> <version-id> --root-id <root-uuid> --directory '/mounted/share/workspace/meeting'
multica cockpit meeting workflow retry-nas <meeting-id> <export-id> --revision <export-operation-revision>
```

Publication's optional NAS flags must be supplied together; no flags means no
new NAS request. `export-nas` requires both target flags and has no `--revision`.
`retry-nas` requires the export operation revision and accepts no new target.
All three return the complete workflow JSON, including the operation records;
inspect their status instead of assuming HTTP success means the copy completed.
For publish-with-NAS and export, the CLI requires a receipt with a valid operation
UUID, matching version/root/directory, and a hash matching the returned version.
Retry requires the same operation, a revision at least as new as requested, and
queued/running/succeeded state. Missing or inconsistent receipts are errors;
publication may already have succeeded, so reload the workflow before retrying.
The CLI never automatically repeats the command or substitutes credentials.
