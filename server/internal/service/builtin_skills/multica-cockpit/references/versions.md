# Versions and board fields

### Versions

Imports and restores save the displaced board first; once history exists, ordinary edits can leave an `auto` checkpoint after five minutes. Bound nodes or meeting work packages block whole-board replacement to preserve stable history.

```bash
multica cockpit version list                 # newest first, with ids
multica cockpit version save --label "评审前"
multica cockpit version restore <snapshot-id>   # owner/admin; saves the current board first
multica cockpit version delete <snapshot-id>    # owner/admin; removes one version from history
```

### Board-level fields

```bash
multica cockpit update --goal-title "端到端技术贯通 Demo" --goal-date 2026-12-31
multica cockpit update --summary-overall "本周完成 …"
```

The three summary cards (`--summary-overall`, `--summary-next`,
`--summary-support`) override the board's automatic roll-up. Leave them empty
unless asked: an empty card derives from the tasks and stays correct on its
own. When verified facts contradict a filled card, say so and offer one dated
replacement — the card is a board-level field the agent may write after the
user confirms; the empty-card default itself is unchanged.
