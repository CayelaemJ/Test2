# Dashboard Date and Cohort Semantics

This document is normative for portal filtering. A metric must not be labelled with a period unless its source records are filtered using the rule in this document.

## 1. The three date classes

### Business event dates

These answer **“When did the activity happen?”** and drive flow metrics.

- `enrolled_at`, `activated_at`
- `started_at`, `completed_at`
- rating `created_at`
- referral `shared_at`, `converted_at`
- salary advance `advanced_at`

### Business effective or observation dates

These answer **“What state was true as at the selected date?”** and drive stock metrics.

- headcount `as_of_date`
- workforce `observed_at`, `eligible_from`, inclusive `eligible_to`
- debt `observed_at`, `closed_at`
- policy `observed_at`, `effective_from`, inclusive `effective_to`, `resolved_at`
- score configuration `effectiveFrom`

### Technical change timestamps

`source_updated_at` answers **“When did the source record last change?”** It is required on every feed and is only for incremental extraction, idempotency and freshness. It must never be used as the dashboard's business period date.

`is_deleted=true` is a technical retraction of the natural-key record. It is not a substitute for a business end date.

## 2. Window rules

| Portal selection | Stock/as-at end | Flow start | Flow end |
|---|---:|---:|---:|
| Closed `period=2026-03` | 2026-03-31 23:59:59.999 UTC | 2026-03-01 00:00 UTC | 2026-03-31 23:59:59.999 UTC |
| Current-month `period=YYYY-MM` | current timestamp, never future month-end | first day of the current UTC month | current timestamp |
| `range=30d` | current timestamp | start of the UTC date 29 days before today | current timestamp |
| `range=quarter` | current timestamp | current UTC quarter start | current timestamp |
| `range=all` | current timestamp | no lower bound | current timestamp |

Future periods are rejected. `period` and `range` are mutually exclusive, and `range=month` is invalid without a `period`.

## 3. Metric classification

| Dashboard area | Classification | Date rule |
|---|---|---|
| Eligible workforce | Stock | latest non-retracted headcount/workforce observation at or before as-at; eligibility dates must include as-at |
| Take-up | Stock ratio | enrolled by as-at ÷ eligible as-at |
| Activated | Stock ratio | activated by as-at ÷ eligible as-at |
| Completed a fix | Stock funnel | unique users with a completed journey by as-at |
| Outcomes cards | Flow | journeys completed inside the selected window |
| Monthly cashflow restored | Stock | recurring savings from journeys completed by as-at |
| New savings in selected range | Flow | recurring savings from journeys completed inside the window |
| Debt profile / creditors / intervention states | Stock | latest valid debt observation per account at or before as-at; exclude accounts closed on/before as-at |
| Insurance efficiency / opportunity | Stock | latest valid policy observation at or before as-at and within effective dates; resolution applies from `resolved_at` |
| Ratings and NPS | Flow | ratings created inside the window |
| Chat | Flow | sessions started inside the window |
| Referrals | Flow | shares created inside the window; conversion date is separately retained |
| Early wage access | Flow | finalised advances with `advanced_at` inside the window |
| Portfolio view | Mixed | each employer row is built from the same stock/flow rules above |

## 4. Site and income cohorts

For each employee, select the latest non-retracted workforce observation whose `observed_at <= asAt`. Then apply:

- `eligible_from <= asAt`; and
- `eligible_to` is blank or its date is on/after the selected UTC calendar date.

Only after that state is reconstructed may the `site_name` and `income_band` filters be applied. Current employee attributes must never be projected backwards when dated observations exist.

## 5. Historical snapshots

A monthly snapshot is a complete dashboard payload, not a compact score-only record. It stores:

- `rangeStart`, `rangeEnd`, `asAt`;
- score and sub-scores;
- weights active at the as-at date;
- complete dashboard payload version;
- calculation timestamp.

Snapshots may be recomputed after a corrective import, but the payload must still use the source business dates and configuration effective at that historical as-at date.

## 6. Data-quality warnings

The dashboard response exposes warnings when:

- no headcount snapshot exists at/before as-at;
- the as-at headcount snapshot and dated employee detail do not reconcile;
- a legacy employee has no dated workforce observations;
- an employee has dated history but no valid observation at/before as-at;
- debt or policy history falls back to a current projection;
- the selected cohort has no eligible employees.

Warnings must remain visible; they are not merely log messages.
