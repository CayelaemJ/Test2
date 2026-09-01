# Migration Guide: Integration Contract v1 → v2

The v2 contract is intentionally strict. Existing v1 files and endpoints will fail validation until the required business dates and technical timestamps are supplied.

## Breaking contract changes

| Feed | Required v2 change |
|---|---|
| All feeds | Add UTC `source_updated_at`; optionally add `is_deleted`. |
| Employers | `eligible_count` is optional current cache; when supplied, `eligible_count_as_at` is required. |
| New `workforce_snapshots` | Supply `employer_ref`, `as_of_date`, `eligible_count` for historical denominators. |
| Employees | Add required `observed_at` and `eligible_from`; use inclusive `eligible_to`; natural key becomes `employer_ref + payroll_ref + observed_at`. |
| Debt accounts | Add required `observed_at`; optional `closed_at`; natural key becomes `account_ref + observed_at`. |
| Policies | Add required `observed_at`; add effective/resolution dates; natural key becomes `policy_ref + observed_at`. |
| Chat sessions | Add tokenised `payroll_ref`. |
| Referrals | Add `converted_at` when `converted=true`. |
| Salary advances | Add tokenised `payroll_ref`; make `advanced_at` and status required; use uppercase enum values. |
| API query | Support ISO timestamp `since` and `through` boundaries, not a date-only cursor. |

## Database rollout

1. Back up the PostgreSQL database and export all v1 source files.
2. Apply the schema in a non-production environment first. The startup command no longer accepts destructive changes automatically.
3. Load employers.
4. Load historical workforce headcount snapshots.
5. Load dated employee observations, oldest to newest.
6. Load enrolment and journey feeds.
7. Load debt and policy observations, oldest to newest.
8. Load ratings, chat, referrals and wage advances.
9. Rebuild monthly snapshots for all months with source activity.
10. Reconcile dashboard and portfolio totals before production cutover.

## Minimum backfill standard

For every month visible in the month picker, provide:

- one employer headcount snapshot at month-end (or the latest valid prior date);
- a valid workforce observation for each employee who should be in a site/income cohort;
- debt and policy observations sufficient to represent month-end state;
- event dates for all flow feeds.

Without this backfill, the portal will still run but will surface data-quality warnings and cannot claim exact historical cohort/state reporting.

## Source endpoint rule

For request `?since=<timestamp>&through=<timestamp>`, return every record whose `source_updated_at` is:

```text
source_updated_at > since AND source_updated_at <= through
```

Optimise intentionally overlaps the previous cursor by five minutes and relies on natural-key/source timestamp upserts to remove boundary risk. A failed report's cursor is not advanced.

## Reconciliation acceptance tests

For at least three closed months and one current range, verify:

1. headcount denominator;
2. enrolled and activated counts;
3. completed outcomes and monthly savings;
4. arrears users, balances and top creditors;
5. wasteful/resolved policy counts;
6. rating/NPS population;
7. chat/referral/EWA period totals;
8. site and income cohort totals;
9. employer dashboard versus portfolio row;
10. repeated identical sync produces zero material changes.
