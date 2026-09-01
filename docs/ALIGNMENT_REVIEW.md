# Optimise Integration and Portal Alignment Review

**Review date:** 12 August 2026  
**Outcome:** The v1 specification and portal were not sufficiently aligned for auditable time filtering. The v2 package resolves the structural issues identified below.

## Executive conclusion

The original contract mixed three different concepts:

1. a **business event date** (when an enrolment, journey, rating, chat, referral or advance happened);
2. a **business effective/observation date** (the workforce, debt or policy state that was true at a selected date); and
3. a **technical change timestamp** (when a source record last changed and therefore belongs in an incremental API pull).

Only some event feeds had dates. Employer headcount, workforce attributes, debt balances and policy state were current-state records, so selecting an earlier month would have applied today's state to the past. The API also recommended a `since` filter without exposing a reliable source change timestamp.

The corrected implementation now separates these concepts and applies one calculation engine to employer dashboards, historical snapshots and the internal portfolio view.

## Findings and resolutions

| Severity | Finding in v1 | Dashboard / integration impact | v2 resolution |
|---|---|---|---|
| Critical | Employer headcount had no as-of history. | Historical take-up and score denominators used the current headcount. | Added `workforce_snapshots` keyed by `employer_ref + as_of_date`; employer count is only a current cache. |
| Critical | Employee site, income band and active state were overwritten in place. | Past site/income filters could assign a transferred employee to the wrong cohort. | Added required `observed_at`, `eligible_from`, optional inclusive `eligible_to`, and immutable `EmployeeVersion` observations. |
| Critical | Debt accounts had no observation date or state history. | Past arrears, balances, creditors and debt-risk scores used current balances/state. | Added `observed_at`, `closed_at`, immutable `DebtAccountVersion` rows and latest-valid-observation selection as at the filter end. |
| Critical | Policies had no observation/effective/resolution dates. | Current wasteful/resolved status was projected backwards. | Added `observed_at`, `effective_from`, inclusive `effective_to`, `resolved_at` and immutable policy versions. |
| Critical | Mutable imports used duplicate skipping rather than updates. | Journey completions, debt balance changes, policy resolutions and referral conversions could remain stale. | All feeds now use source-ordered upserts using required `source_updated_at`; technical retractions use `is_deleted`. |
| High | `?since=YYYY-MM-DD` was recommended, but most records had no technical update timestamp. | Incremental pulls could miss changes or repeatedly reload all data. | Every feed now requires UTC `source_updated_at`; sync uses per-report cursors, a fixed `through` boundary and a five-minute overlap. |
| High | Chat and wage-advance rows had no payroll reference. | Site and income filters could not be applied consistently to those widgets. | Added required tokenised `payroll_ref` and employee relations to both feeds. |
| High | Wage-advance date was optional and could default to import date. | Monthly EWA trends could shift merely because a file was uploaded later. | `advanced_at` is mandatory; status and verification fields are normalised enums. |
| High | Historical snapshots contained only a compact subset and the browser merged missing fields with demonstration data. | A historical month could show current/demo values in widgets not present in the snapshot. | Every monthly snapshot now stores a complete v2 payload. Live data replaces the demo object rather than merging into it. |
| High | “Last 30 days” and “Quarter” controls could change labels without changing the underlying query. | Users could believe unchanged figures were period-filtered. | Controls now send real `period`, `range`, `site` and `income` query parameters; the API returns the applied `filterContext`. |
| High | The portfolio view used a separate simulated employer dataset. | Portfolio rankings could disagree with the underlying employer dashboard. | Portfolio metrics are now derived from the same dated dashboard builder for every authorised employer. |
| Medium | A journey-to-debt relation was one-to-one. | One arrears/prescription journey could not act on multiple accounts. | Removed the unique journey constraint and changed the relation to one journey → many debt accounts. |
| Medium | Server listening started before all routes were registered. | Startup structure was fragile and could make route availability harder to reason about. | All routes are registered before `app.listen`. |
| Medium | Production startup accepted destructive Prisma changes automatically. | A deployment could silently lose data. | Automatic `--accept-data-loss` is removed; additive `db push` remains explicit and destructive changes fail. |
| Medium | Authenticated live-data failure fell back to simulated metrics. | Users could see fabricated values during an outage. | Production mode now shows a clear data-unavailable state. Demo data is only enabled explicitly with `?demo=1`. |

## Filter model now used by the portal

- **Stock/as-at metrics:** headcount, eligible cohort, enrolment/activation funnel, wellness score, debt balances/state, policy state and opportunity signals are calculated **as at the filter end**.
- **Flow/in-window metrics:** completed outcomes, new savings, ratings, chat sessions, referrals and finalised wage advances are calculated **inside the selected window**.
- **`period=YYYY-MM`:** stock at month-end; flow from the first through last calendar day of that month.
- **`range=30d`:** stock now; flow across the latest 30 inclusive UTC calendar dates.
- **`range=quarter`:** stock now; flow from the current quarter start through now.
- **`range=all`:** stock now; flow from programme inception through now.
- **Site/income filtering:** cohort membership is selected from the latest valid workforce observation at or before the as-at date, not from today's employee row.

## Portal structure after the update

1. **One canonical data path:** CSV, XLSX and API JSON all use the same report definitions, validator and idempotent commit service.
2. **One calculation path:** live employer views, saved monthly snapshots and portfolio rows use `getDashboardPayload`.
3. **Explicit data quality:** the API returns warnings when legacy projections are used or an observation is missing at the selected as-of date.
4. **No silent substitution:** incomplete live responses are not filled with demo values.
5. **Per-report sync safety:** a failed report does not advance its cursor; successful feeds can continue without hiding the failure.
6. **Technical versus business deletion:** `is_deleted` retracts a natural-key record. Workforce exits, debt closure and cover termination must use `eligible_to`, `closed_at` and `effective_to` respectively.
7. **No future current-month boundary:** a selected closed month ends at month-end, while the current month is calculated only through the current timestamp.
8. **Safe correction path:** only insert-only leaf batches can be reverted; mutable and dated feeds are corrected with newer source versions or tombstones.

## Required implementation/backfill before production acceptance

- Load at least one `workforce_snapshots` row per employer/month needed for reporting.
- Backfill employee observations for every historical site/income period that the portal must filter.
- Backfill monthly or change-driven debt and policy observations; one current observation cannot recreate history.
- Ensure every source endpoint honours `(since, through]` using `source_updated_at` and returns the complete requested window.
- Agree the authoritative `employer_ref` list and verify all tokenised `payroll_ref` values join to the workforce feed.
- Run a controlled reconciliation for at least three closed months: source totals, imported rows, dashboard figures and exported report.

## Files reviewed

- `Optimise_Integration_Spec.docx`
- `EFS Dashboard DB Spec.zip`
- `EFS Optimise.zip`
- `Ver1(1).zip`

## Files updated in this package

- `prisma/schema.prisma`
- `src/services/reportFormats.ts`
- `src/services/importParser.ts`
- `src/services/importService.ts`
- `src/services/syncService.ts`
- `src/services/snapshotBuilder.ts`
- `src/server.ts`
- `public/dashboard.html`
- `sample-imports/*`
- `docs/*`
