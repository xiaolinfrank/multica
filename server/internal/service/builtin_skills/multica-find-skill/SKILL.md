---
name: multica-find-skill
description: "Use when a capability may already exist, or the member asks 有没有能做的 skill、装个技能: check workspace skills, search the registry, import and bind. Not a web search; not authoring a new skill."
user-invocable: false
allowed-tools: Bash(multica *)
---

# Finding and installing a skill

A skill only exists for this workspace when it is in this workspace's skill
database. Anything installed elsewhere (a local `.claude/skills`, a global npm
directory, `npx skills add`) is invisible to every agent here. That single
invariant decides the whole workflow.

Do not shop first. Most asks are answered by the agent's existing skills or by
the platform itself; installing is the last step, not the first.

## 1. Decide whether a skill is the right answer

Install only when **all three** hold:

- the task is recurring or method-heavy (a workflow, a checklist, a format), not
  a one-off lookup;
- an existing skill would have to be long to be useful, i.e. it is real
  knowledge rather than a clever prompt;
- the capability is missing today (step 2 proves it).

If the task is a single question, answer it. If it needs an external system,
that is an MCP integration, not a skill.

## 2. Look in the workspace first

```bash
multica skill list --output json                 # everything installed here
multica skill search "<query>" --output json     # server-side registry search
```

`skill list` is the inventory: name, description, and whether an agent already
binds it. Read a candidate fully before recommending it:

```bash
multica skill get <skill-id>                     # frontmatter + body
multica skill files list <skill-id>              # supporting files it ships
```

If a workspace skill already covers the need, say which one and stop. Do not
install a second one with the same job — duplicates cost every future task
context, and the agent picks between them at random.

## 3. Search the registry — with the field's vocabulary

```bash
multica skill search "budget variance" --output json
```

`skill search` returns installable candidates with `name`, `url`, `source`, and
`install_count`; the URL is what you hand to `skill import`. Query with the
terms a practitioner would use, not the member's phrasing — "unit economics",
not "怎么算赚钱".

Report the shortlist as: name, what it does, install count, source, and the one
reason you would pick it. Two or three candidates, never ten.

## 4. Evaluate before installing

Judge, in this order:

1. **Fit** — does its description cover the member's actual job, or a neighbour
   of it? A near-miss skill is worse than none: the agent will follow the wrong
   method confidently.
2. **Source** — `github.com/anthropics/*`, `github.com/vercel-labs/*`, a known
   vendor, or an identifiable author. An anonymous repo with no history is a
   pass.
3. **Adoption** — `install_count` is a weak but real signal. Zero installs plus
   an unknown author is a pass.
4. **Cost** — open its `SKILL.md` (the URL is readable): how long is it, does it
   pull dependencies, does it ask for network or credentials it should not need.
5. **Licence** — redistributable or not matters if it will be shipped; for use
   inside one workspace, read the terms and say what you saw.

State what you checked. "It has 3M installs" is not a review.

## 5. Import into this workspace

```bash
multica skill import --url <url> --output json                       # default: fail on conflict
multica skill import --url <url> --on-conflict rename --output json  # keep both
multica skill import --file <path/to.skill> --output json            # local archive
```

`--on-conflict`: `fail` (default), `overwrite`, `rename`, `skip`. Prefer `fail`
and then decide — silently overwriting a workspace skill that agents already
bind is how behaviour changes without anyone noticing. Use `rename` when the new
one is genuinely different from the same-named one.

For a single file or a folder blob, import the `SKILL.md` URL or the tree URL —
the endpoint accepts `github.com/owner/repo`, `/tree/<ref>/<path>`,
`/blob/<ref>/.../SKILL.md`, `clawhub.ai/...`, and `skills.sh/...`.

## 6. Bind it to the right agent, and only that agent

```bash
multica agent skills list <agent-id>                          # who has what
multica agent skills add  <agent-id> --skill-ids <id>         # additive
multica agent skills set  <agent-id> --skill-ids <id1>,<id2>  # replaces all
```

`set` is destructive: it drops every binding the agent had. Use `add` unless the
member asked for a clean binding. Asking before changing a shared or squad-leader
agent is not optional — every member's task routed to it is affected.

## 7. Close the loop

Report: what was installed (name + source URL), which agent now binds it, what
it cost to install (dependencies, size), and how to undo it (`multica skill
delete <id>`, or `multica agent skills set` back to the previous list). Then do
the original task with the new skill, so the member sees it work rather than
taking your word.

## Anti-patterns

- `npx skills add` for a workspace capability — installs outside the workspace
  DB, so no agent here ever sees it.
- Installing three candidates "so the agent can choose". It cannot choose well;
  it picks by description similarity.
- Importing into a workspace to inspect a skill. Read the URL first.
- Binding to the requester's agent when a specialist agent already owns that
  domain.
- Reporting "installed" without running the task once.
