# Meeting directory preparation

Use `multica cockpit meeting directory` to inspect or prepare a meeting directory in the workspace's deployment-approved NAS root. This is separate from directory contacts, minutes exports, materials readiness and Agent dispatch.

Meeting creation uses the fixed shared directory and subdirectory layout. These commands are for inspection, explicit recovery and diagnostics, not alternative material-collection methods. Never delete or relocate existing meeting files as part of simplifying the workspace.

## Read first

```bash
multica cockpit meeting directory roots
multica cockpit meeting directory root ROOT_UUID
multica cockpit meeting directory summary MEETING_UUID
multica cockpit meeting directory list MEETING_UUID --page-size 25
multica cockpit meeting directory show MEETING_UUID OPERATION_UUID
multica cockpit meeting directory steps MEETING_UUID OPERATION_UUID
multica cockpit meeting directory attempts MEETING_UUID OPERATION_UUID STEP_UUID --page-size 25
multica cockpit meeting directory attempt MEETING_UUID OPERATION_UUID STEP_UUID ATTEMPT_UUID
multica cockpit meeting directory command MEETING_UUID COMMAND_UUID
```

Lists return one bounded page. Retain `next_cursor` with the same scope and page size; do not fetch all history to locate a known UUID. Steps are one complete set of at most 32. Read one attempt only when its diagnostic details are needed.

The root list describes configured preparation scopes, not NAS file browsing or a promise that storage is currently writable. `prepare_subpaths` defaults to empty; existing export permission does not grant directory preparation. Root and mount identity must already be provisioned by the deployment operator. Requests never create a root, identity marker or replacement mount.

The summary contains the current binding and revision, a resolved `binding_candidate` when available, capabilities and exact history/unfinished counts. A reference path may exist without being accessible to this server. Do not derive readiness from a nonempty path, an empty history page or a completed directory plan.

## Preview and register a fixed plan

Write one UTF-8 JSON request file, at most 64 KiB. Never place credentials or forged actor fields in it.

```json
{
  "mode": "prepare",
  "root_id": "ROOT_UUID",
  "relative_directory": "meetings/2026-10-11-review",
  "partitions": ["会议材料", "会议纪要与录音转写", "照片"],
  "observed_nas_dir": "",
  "observed_binding_revision": 1,
  "bind_after_base": true
}
```

Use actual UUIDs and the binding returned by the summary. Every ancestor, base directory and partition is shown in the preview; no recursive work is hidden. There are at most 16 partitions, 32 total steps and 16 path components. `mode: "repair"` is a new explicit plan for the same fixed target after directories were externally removed; it does not rewrite an old successful receipt.

```bash
multica cockpit meeting directory preview MEETING_UUID --request-file preview.json
multica cockpit meeting directory prepare MEETING_UUID --request-file command.json
```

`preview` performs read-only checks. Continue only with `can_confirm: true`, the intended paths and a known principal. For `command.json`, retain the preview fields and add one stable UUID `command_key`, `expected_revision` equal to the observed binding revision, and the returned `context_token`.

`prepare` records a durable bounded plan. A receipt confirms that authorization; it does not mean all directories exist. The server progresses the accepted plan even after the CLI or browser closes. No Issue or Agent Run is created. Existing directories are reported as `observed_existing`; only an acknowledged mkdir may report `created`. Directory preparation never overwrites, renames or deletes NAS files.

## Unknown results and retry

After a dropped or malformed response, retain the exact command file and key. Read `command MEETING_UUID COMMAND_UUID` and verify the fixed `receipt.directory`, not the operation's later state. An absent or temporarily unreadable command is not permission to generate a new key. Explicit resubmission uses the exact original request.

For `directory_operation_exists`, open the named operation. The conflict response does not acknowledge the new command; another person's plan may only be resumed or claimed when the server says that action is allowed.

```bash
multica cockpit meeting directory retry-preview MEETING_UUID OPERATION_UUID --request-file retry-preview.json
multica cockpit meeting directory retry MEETING_UUID OPERATION_UUID --request-file retry.json
multica cockpit meeting directory control MEETING_UUID OPERATION_UUID --request-file control.json
```

A retry preview contains `step_ids` for 1–32 distinct original steps. A retry adds a new stable `command_key`, the observed operation `expected_revision`, returned `context_token` and `reason`. Only these steps receive the new grant. Satisfied steps are not reset; a completed directory later deleted outside Multica requires a new repair plan.

Control input is `command_key`, observed operation `expected_revision`, `transition` and `reason`. Transitions are `pause`, `resume`, `claim`, `abandon`; claim and abandon require a reason. Pause/resume retain each step's original grant. A human claim explicitly grants all remaining original steps to the new responsible person and retains their exact IDs in the receipt. Abandon prevents remaining work but does not undo existing directories or a mkdir already in progress.

The operation's `last_grant` is a display summary. Each step's own grant is authoritative; partial retry must not enlarge the authorization of unselected steps. A base directory's own binding update is distinct from a later manual path change. Reconfirm changed facts instead of redirecting the original plan.

## Human and Agent authority

Human commands retain their actual confirming member. A task token may propose and authorize deterministic directory preparation only for an active, correctly bound Run with an existing direct preparation relationship to this meeting. The original `originator_user_id` must still be a member with directory permission and permission to invoke that Agent. The runtime credential owner is recorded separately and is not a substitute authorizer. Missing originator or a same-project relationship is insufficient.

Cloud PATs without a specific trusted Run are read-only here. Never pretend to be a human or create a replacement Issue/Run to bypass a denied command. An accepted bounded plan is independent of its source Run later finishing, failing or being cancelled; stopping that Run does not stop the directory plan. Use the plan's explicit pause/abandon control. Membership, root scope and delegated Agent permission are checked again before subsequent work. An eligible human may explicitly take over the remaining plan.

Cancelling the meeting pauses future directory steps; it does not remove existing files or undo an in-flight write. Reinstating the meeting does not silently restart the plan. Pre-archive authorized work may continue within its original scope, while new preparation requires the currently permitted meeting state.

## Recovery and limits

Use stable error codes and the exact failed attempt to distinguish a missing mount, identity mismatch, permission denial, an unexpected file/symlink, a changed binding and a transient I/O failure. A timeout cannot guarantee that an already-entered filesystem call was cancelled. Late observations are retained on their original attempt without overwriting a newer result or advancing a different grant.

N1 does not upload files, browse arbitrary NAS content, register fixed input versions, transcribe recordings, confirm materials readiness or publish minutes. Those actions require their own implemented workflow and permissions.
