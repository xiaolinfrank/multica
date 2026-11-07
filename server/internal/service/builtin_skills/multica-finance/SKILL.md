---
name: multica-finance
description: "Use for money work that needs a defensible number: 预算、差异分析、现金流、13 周预测、单位经济、定价. States assumptions, decomposes variance, labels estimates. Not tax filing, audit opinions, or investment advice."
user-invocable: false
allowed-tools: Bash(multica *)
---

# Financial analysis

The failure mode here is not a wrong formula. It is a number that is right and
unusable: a variance with no decomposition, a forecast with no stated driver, a
margin that silently mixes revenue and cost bases. Every rule below exists to
keep the output reviewable by someone who was not in the conversation.

## 1. Establish the base before calculating

Write these six lines at the top of the work, and keep them visible:

- **Entity and scope** — which company/cost centre, which products, which
  period. A "total" without a boundary is not a total.
- **Basis** — actual vs budget vs forecast; accrual vs cash; gross vs net;
  pre- or post-tax. Mixing basis across two columns is the most common silent
  error.
- **Currency and unit** — and whether any figure is converted (then: rate, and
  the date of the rate).
- **Source** — file, sheet, system export, and the date it was pulled.
- **As-of date** — books close late; say which cut you used.
- **What is excluded** — one-off items, intra-group eliminations, anything the
  member should know was left out.

If a figure arrives from chat without these, treat it as an estimate and label
it as one.

## 2. Arithmetic discipline

- Every number in the narrative traces to a cell, a table row, or a stated
  formula. No number appears twice in two derivations that disagree.
- Percentages always name their base: "毛利率 32%（占收入）" not "32%".
- Round once, at the end, and keep full precision in the model.
- Do not sum a mix of annual and monthly periods because they share a column.
- Recalculate after any edit. A workbook that no longer computes to the quoted
  figure is a defect, not a rounding difference.

## 3. Variance analysis — decompose, don't narrate

"Actual is 8% over budget" is not analysis. Split it:

| Source | Question it answers |
| --- | --- |
| Volume | did we do more or less of the thing? |
| Price / rate | did the unit price move? |
| Mix | did we sell a different blend? |
| FX | only if a foreign currency is actually involved |
| One-off / timing | did something land in this period that belongs to another? |

Report favorable/unfavorable against the correct direction per line: revenue
above plan is favorable, cost above plan is not. Then attribute the top three
drivers with a number each and mark the residual as unexplained — an honest
residual is more valuable than a fabricated attribution.

## 4. Cash is not profit

When the question is liquidity, work in cash and say so:

- **13-week rolling** is the standard short-horizon instrument: weekly buckets,
  opening balance, receipts by expected collection date (not invoice date, not
  contract date), disbursements by payment date, closing balance.
- Distinguish **committed** (PO issued, contract signed, payroll run) from
  **accrued** (booked, not yet payable). Only committed money may be spent.
- State the collection assumption explicitly — "DSO 60 天，按账期到期后 10 天
  回款" — and show what happens at 75 days.
- Report the **lowest** closing balance and the week it occurs. An average
  balance hides the crunch.

## 5. Unit economics — name the window

CAC, LTV, payback, contribution margin are only comparable when the window and
the cost boundary are stated:

- Contribution margin: revenue − variable cost. Say what you counted as
  variable (and that it usually excludes allocated overhead).
- CAC: all acquisition spend ÷ new customers acquired **in the same period**;
  including brand spend changes the number — say whether you did.
- LTV: state gross-margin basis, churn window, and discount rate, or the number
  is not comparable to anything.
- Payback: months of contribution margin to recover CAC. Report it next to the
  assumed retention, never alone.

## 6. Scenarios, not a point estimate

Deliver base / upside / downside with **the same three or four named drivers**
moved between them (e.g. volume, price, collection days, hiring plan). Each
scenario gets a one-line trigger condition: "下行：Q4 大客户续约率低于 80%".
A single number presented as a forecast will be treated as a promise.

## 7. Boundaries — say them out loud

This skill produces management analysis, not assurance. State plainly when the
ask crosses into:

- **Tax filing or tax positions** — needs a tax professional and current local
  rules; do not compute a liability and call it final.
- **Statutory audit opinion** — only an auditor can opine.
- **Investment advice or a valuation used to transact** — methodology yes,
  recommendation no.
- **Personal financial advice** — out of scope.

Deliver estimates as estimates: label `估算` / `未经审计` and give the assumption
that would move the number most.

`references/finance-checks.md` has the formula sheet and the pre-send checklist.
