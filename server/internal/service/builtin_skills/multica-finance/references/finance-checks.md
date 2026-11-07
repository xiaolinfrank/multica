# Finance formula sheet and pre-send checklist

## Core formulas

| Metric | Formula | Watch for |
| --- | --- | --- |
| Gross margin % | (Revenue − COGS) / Revenue | COGS that quietly includes fixed overhead inflates the swing |
| Contribution margin | Revenue − variable cost | Boundary of "variable" must be stated |
| Operating margin | Operating income / Revenue | One-off items left in |
| EBITDA | Operating income + D&A | Never a cash proxy — say so if used as one |
| Budget variance | Actual − Budget | Direction: cost over = unfavorable |
| Variance % | Variance / Budget | Budget near zero makes the percentage meaningless — report absolute |
| DSO | (AR / Revenue) × days | Use the same period for both terms |
| DPO | (AP / COGS) × days | Mixing COGS with total spend skews it |
| Cash conversion cycle | DSO + DIO − DPO | Only meaningful within one business model |
| CAC | Acquisition spend / new customers | Period-matched numerator and denominator |
| LTV | ARPA × gross margin / churn | State churn window (monthly vs annual) |
| Payback (months) | CAC / monthly contribution margin | Report alongside retention assumption |
| Runway (months) | Cash / net monthly burn | Net burn = outflow − inflow, not gross |
| NPV | Σ CFt / (1+r)^t − initial | State r and why |
| IRR | r where NPV = 0 | Misleading with non-conventional cash flows |

## 13-week cash flow — structure

```
Week           W1   W2  ... W13
Opening cash
  Receipts (by expected collection date)
  Disbursements (by payment date)
  ── Payroll, rent, suppliers, tax, debt service, capex
Net movement
Closing cash
Cumulative minimum      ← the number that matters
```

Rules that keep it usable: weekly buckets (not monthly), collections dated by
expected cash date, committed ≠ accrued, and the minimum balance called out with
its week.

## Pre-send checklist

- [ ] Entity, period, basis, currency, and source are stated at the top.
- [ ] Every quoted number exists in the model and recomputes after edits.
- [ ] Percentages name their base; units are in the header, not per cell.
- [ ] Variance is decomposed (volume / price / mix / timing) with a residual
      where attribution is unavailable.
- [ ] Favorable vs unfavorable uses the right direction per line.
- [ ] Scenarios move the same named drivers and each has a trigger condition.
- [ ] Estimates are labelled as estimates; excluded items are listed.
- [ ] Out-of-scope asks (tax filing, audit opinion, transaction valuation) are
      flagged rather than answered.
- [ ] The one assumption that would flip the conclusion is named explicitly.

## Common errors seen in review

1. A "total" that double-counts an allocated cost already inside a line item.
2. Annual plan compared to monthly actuals because they share a column.
3. Budget variance on a zero-budget line, reported as a percentage.
4. FX movement counted both in the price variance and in a separate FX line.
5. Cash flow built from profit plus depreciation, ignoring working capital.
6. Runway computed from gross burn while revenue sits in another tab.
7. A single-scenario forecast presented as the plan.
