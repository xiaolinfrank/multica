---
name: multica-research
description: "Use when the answer depends on facts you do not already hold: 调研、竞品、法规、选型、事实核查. Source grading, dated citations, conflict reporting, explicit confidence. Not for summarising an attached document."
user-invocable: false
allowed-tools: Bash(multica *)
---

# Research

The output of research is not a page of prose. It is **an answer the member can
act on, with the evidence standing behind it and the uncertainty visible**. Most
bad research is confident; very little of it is wrong on purpose.

## 1. Turn the question into a decision

Before searching, write one line: *what will the member do differently once they
know this?* If nothing changes, the question is trivia — answer briefly and say
so.

Then fix the scope: geography, time window, population/segment, and what would
count as an answer. "国内创新药 BD 市场" is not a scope; "2025–2026 年中国创新药
对外授权首付款区间" is.

## 2. Search additively, and keep the trail

1. **Broad sweep** — 2–4 queries on the topic to learn its vocabulary. The words
   the field uses are usually not the words the member used.
2. **Targeted** — with the real vocabulary, one query per sub-question.
3. **Primary check** — go to the documents the secondary sources cite.

Record the queries and the dates you ran them in your working notes. When two
sources disagree, you need to know whether you asked the same question twice.

## 3. Grade the source, then trust it

| Tier | What it is | How far it carries |
| --- | --- | --- |
| 1 | Primary: statute, regulation, standard, filing, dataset, first-party announcement, the paper itself | Enough to state a fact |
| 2 | Institutional: regulator summary, industry association, peer-reviewed review, named-analyst report | Enough with attribution |
| 3 | Secondary: news, vendor blog, encyclopedia, aggregator | Enough only to locate a tier-1 source |
| 4 | Unsourced claim, forum post, AI summary of a summary | Locate only; never cite as fact |

Recency is part of the grade: a 2019 price is not a 2026 price, a superseded
regulation is not the rule. State the **as-of date** for any changing number.

## 4. Handle conflict instead of averaging it

When sources disagree: prefer the higher tier, then the newer, then the one
whose methodology is visible. If the disagreement survives that, **report both
with their sources** and say which you would act on and why. Never split the
difference silently — a mid-point between two real numbers is a number nobody
measured.

## 5. Cite so the claim can be checked

Every non-obvious claim carries: **publisher, title, date, link**. Quote a
sentence only when its wording matters; otherwise paraphrase and cite. If you
cannot source a sentence, delete it or mark it as your own inference — labelled
as such.

Never invent a citation, a DOI, a statute number, or an access date. An empty
result reported honestly is worth more than a plausible-looking reference.

## 6. Say how confident you are

End with a three-line confidence block:

```markdown
**结论**：<one sentence>
**置信度**：高 / 中 / 低 —— <why: how many independent tier-1 sources, how current>
**会改变这个结论的**：<the specific fact that would flip it>
```

"Low" is a legitimate answer and should be used freely: it tells the member where
to spend their own verification.

## 7. Stop on saturation, not on exhaustion

Stop when 2–3 independent sources of tier ≤2 agree **and** the decision no longer
flips with another search. Keep searching and you will find outliers, not truth.
Say what you stopped at, so the member knows the search was bounded.

## Deliverable

- Lead with the answer, not the journey. The search log belongs at the end, or in
  a comment, not in the first paragraph.
- Group findings by sub-question, not by source.
- Separate **fact** (cited), **inference** (yours, labelled), and
  **recommendation** (judgement, with the trade-off named).
- A table beats paragraphs when the member will compare options.

`references/source-ladder.md` expands the tier table with worked examples for
regulation, market sizing, and technical claims.
