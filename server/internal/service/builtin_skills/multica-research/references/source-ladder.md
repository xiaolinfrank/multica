# Source ladder — worked examples

The tier table in `SKILL.md` is the rule. These examples are how it lands on the
three domains where getting it wrong is expensive: regulation, market size, and
technical claims.

## Regulation and policy

| Question | Tier 1 | Trap to avoid |
| --- | --- | --- |
| Is X allowed / required? | The statute or regulator's own text | A law-firm blog summarising an older version |
| Which version applies? | Effective date and transitional clauses in the text | Citing a draft as if in force |
| Local vs national | Both texts, and which prevails | Applying a national rule where a local pilot overrides |

Rules of thumb: regulations are dated artefacts — always report the version and
its effective date. A superseded clause quoted accurately is still wrong. If the
text is behind a login, say "原文需登录，未核验" rather than paraphrasing from a
summary.

## Market size and industry numbers

| Claim shape | What to ask |
| --- | --- |
| "市场 X 亿元" | Whose definition of the market? Which year? Nominal or real? |
| "增长率 Y%" | CAGR over which window, and does the base year include the anomaly? |
| "渗透率 Z%" | Denominator: population, households, or addressable users? |
| Vendor-published share | Self-reported; check whether the sample excludes their weak segment |

Two independent estimates that differ by less than ~20% are usually the same
methodology re-published. Differ by 3x and the definitions differ — find the
definition before choosing a number.

## Technical and product claims

| Claim | Tier 1 evidence |
| --- | --- |
| Benchmark score | The paper or the leaderboard's own methodology page |
| "Supports X" | The product's own documentation for the exact version |
| Performance / latency | A reproducible measurement, with hardware and workload stated |
| Security posture | Audit report or CVE record, not a marketing page |

Vendor documentation is tier 1 **for what the vendor ships**, tier 3 for whether
it works. A claim about behaviour under load needs a measurement, not a feature
list.

## Citation hygiene

- Link the page you actually read, not a search result and not a redirect.
- Record the access date for anything that changes (prices, rankings, live docs).
- One number, one source. If a figure is repeated across three outlets, find the
  origin; that is still one source.
- Prefer the DOI or the canonical publisher URL over a mirror.
- Quote marks mean the words are verbatim. Paraphrase otherwise.

## Confidence, calibrated

| Level | Evidence behind it |
| --- | --- |
| High | ≥2 independent tier-1 sources agree; as-of date is current; the decision does not flip under a plausible alternative reading |
| Medium | One tier-1 plus corroborating tier-2; or tier-1 that is somewhat stale |
| Low | Only tier-3/4 sources; definitions disagree; or the question has no public evidence at all |

Reporting "low" with the reason is a professional answer. Padding a weak finding
into "high" is how a decision gets made on sand.
