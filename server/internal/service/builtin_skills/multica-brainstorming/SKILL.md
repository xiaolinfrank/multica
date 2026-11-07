---
name: multica-brainstorming
description: "Use when the member wants options rather than an answer: 头脑风暴、想点子、方案对比、起名. Divergence and convergence are separate phases, criteria are named before scoring, rejects are kept. Not for reviewing one chosen proposal."
user-invocable: false
allowed-tools: Bash(multica *)
---

# Brainstorming

Asking a model to brainstorm usually returns ten reasonable ideas any competent
person would list — that is recall, not ideation.

Real brainstorming is two phases that must not touch:

1. **Diverge** — volume, no judgment, deliberately weird.
2. **Converge** — explicit criteria, honest scoring, shortlist.

Most of the value is in the second phase being honest and the first phase being
genuinely wide. Both are easy to fake, so this skill pins the mechanics.

## Phase 0 — frame it before generating

Answer these in one line each, asking the member only what you cannot infer:

- Whose problem, and what does "solved" look like a month from now?
- Why now — what changed that makes this worth doing this quarter?
- What has already been tried or rejected?

Then test the framing. A stated problem is often a chosen solution wearing a
disguise: "we need a dashboard" usually means "someone cannot answer a question
in time". Ask "what does that get you?" until the answer stops being a noun.
If the member arrives with a solution picked, brainstorm **the problem behind
it** first; otherwise you are decorating a decision already made.

## Phase 1 — separate real constraints from inherited ones

List the constraints, then mark each one:

| Real | Inherited |
| --- | --- |
| physics, law, budget already committed, a hard deadline, a licence we do not hold | habit, an old architecture, "we've always done it this way", a rule nobody can attribute |

Breakthroughs live behind the inherited ones. Say explicitly which constraints
you are treating as negotiable; let the member veto.

## Phase 2 — diverge, no judgment

- **Quota past the obvious.** The first 8–10 ideas are what anyone would say.
  Produce them fast to exhaust them, then keep going; ideas 15–30 are where the
  non-obvious lives.
- **Rotate axes, don't rephrase.** One idea per axis at a time: who else could
  this serve, what adjacent problem does it solve, how else could it be
  delivered, when/where else does it apply, what if we did the opposite.
- **No evaluative language.** Not even "(probably impractical)". Judgment leaks
  kill volume — write the idea, move on.
- **Keep the weird tail.** Roughly one in five should make the member slightly
  uncomfortable. A set with no bad ideas did not explore the edges.

Alternate generating with asking: hand over a batch, then one question that
mines the member's context for the next batch.

## Phase 3 — widen once more

Before converging, add the four options nobody proposes on their own:

- **Do nothing / change the process** — what breaks if we solve this without
  building anything?
- **1/10 scope** — the smallest thing that dents the problem this week.
- **10x scope** — if this were the company's main bet, what would it be?
- **Buy / borrow instead** — who already solved this, and what would using their
  answer cost?

## Phase 4 — converge, with criteria named first

1. Cluster the related ideas and name the clusters.
2. Write 3–4 selection criteria **before** looking at the list again, chosen
   from the member's actual situation (impact, cost, reversibility, time to
   evidence, confidence). Criteria invented after the list exists just bless a
   favourite.
3. Score coarsely: ✅ / ➖ / ❌ per criterion. False precision on creative options
   is theatre.
4. Shortlist 3–5, one line each on why it won, and label one wildcard.
5. **Keep the reject ledger**: each rejected idea with a one-line reason
   ("needs a partnership we don't have — yet"). Parked, not deleted; today's
   reject is next quarter's answer.

## Output shape

A short brief the member can act on without rereading the whole session:

```markdown
## 问题（重述 + 真正的需求）
## 已排除的约束（哪些是假设）
## 入选（3 个，各一句为什么）
## 待验证（每个方向的第一个可证伪动作）
## 备选池（一句话一条，含否决理由）
```

If the work continues past this point, offer to turn the top candidate into an
issue — the brief becomes its description, so nothing is retyped.

`references/frameworks.md` holds the specific techniques (SCAMPER, six hats,
how-might-we, inversion, 100→10) for when a phase stalls.
