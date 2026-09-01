# Sanlam Optimise — Real-Time Integration Specification v2

**Contract version:** 2.0  
**Prepared:** 12 August 2026  
**Status:** Authoritative implementation contract for the aligned portal package

## 1. Purpose and architecture

Optimise pulls read-only source records on a schedule. The source exposes one endpoint per report and returns the source-level records; Optimise validates, upserts and derives all dashboard aggregates. Manual CSV/XLSX imports use the same report definitions and validator as API JSON.

- **Direction:** Optimise pulls; the source does not push.
- **Authentication:** bearer token on every report endpoint.
- **Response envelope:** `{ "records": [ ... ] }`.
- **Money:** external values are plain rand decimals; Optimise converts them to integer cents internally.
- **Linking:** use stable `employer_ref` and tokenised `payroll_ref`; never employee names, national IDs or employer names as keys.
- **Nulls:** omit optional values or send JSON `null`; never send empty strings in API JSON.
- **Enums:** exact, uppercase and case-sensitive unless the field is explicitly a free string.

## 2. Date model

The contract distinguishes business event dates, business effective/observation dates, and technical source timestamps. `source_updated_at` is not a dashboard period date.

- **Flow metrics** use event dates inside the requested window.
- **Stock metrics** use the latest valid observation/effective state at the window end. Closed months end at 23:59:59.999 UTC; the current month ends at the current timestamp rather than a future month-end.
- **Incremental sync** uses `source_updated_at`.
- **Technical retraction:** `is_deleted=true` retracts the natural-key record. Business exits/closures use the relevant business date.

See `DATE_FILTER_SEMANTICS.md` for the complete portal calculation rules.

## 3. Incremental pull protocol

Every endpoint must accept optional ISO-8601 UTC query parameters:

- `since`: exclusive lower bound;
- `through`: inclusive upper bound fixed by Optimise at sync start.

Return every record satisfying `source_updated_at > since AND source_updated_at <= through`. Optimise overlaps its previous cursor by five minutes and performs idempotent last-write ordering, so repeated boundary records are expected and safe. A report cursor advances only after that report validates and commits successfully.

Example:

`GET /api/optimise/journeys?since=2026-03-21T14:27:10.000Z&through=2026-03-21T15:00:00.000Z`

## 4. Common fields

All reports contain:

| Field | Type | Required | Meaning |
|---|---|---:|---|
| `source_updated_at` | datetime | yes | Last source-system change in ISO-8601 with `Z` or an explicit offset. Drives incremental extraction and last-write ordering. |
| `is_deleted` | bool | no | Technical tombstone/retraction of this natural-key record. Defaults false. |

## 5. Load order

1. `employers`
2. `workforce_snapshots`
3. `employees`
4. `platform_users`
5. `journeys`
6. `debt_accounts`
7. `policies`
8. `ratings`
9. `chat_sessions`
10. `referrals`
11. `salary_advances`

Optimise pulls in this dependency order. The source should expose all endpoints even when an endpoint currently returns no records.

## 6. Employers (master)

**Report key:** `employers`  
**Endpoint:** `GET /api/optimise/employers`  
**Natural key:** `employer_ref`  
**Entity:** Employer

One row per employer. Identity is master data; historical headcount is supplied separately in workforce_snapshots.

| Field | Type | Required | Allowed values / unit | Description |
|---|---|---:|---|---|
| `employer_ref` | string | **yes** |  | Stable employer code used by every dependent report. |
| `name` | string | **yes** |  | Employer display name. |
| `eligible_count` | int | no |  | Optional current headcount cache. workforce_snapshots is authoritative for historical reporting. |
| `eligible_count_as_at` | date | no | YYYY-MM-DD | As-of date for eligible_count when that convenience field is supplied. |
| `source_updated_at` | datetime | **yes** | ISO-8601 with timezone | UTC timestamp of the last source-system change. Used for incremental pulls and last-write ordering. |
| `is_deleted` | bool | no |  | Technical tombstone that retracts this natural-key record while retaining its audit trail. Use business end dates/statuses for lifecycle changes. |

Example response:

```json
{
  "records": [
    {
      "employer_ref": "VIG",
      "name": "Vaalwater Industrial Group",
      "eligible_count": 1575,
      "eligible_count_as_at": "2026-03-31",
      "source_updated_at": "2026-04-01T08:00:00Z",
      "is_deleted": false
    }
  ]
}
```

## 7. Workforce Headcount Snapshots

**Report key:** `workforce_snapshots`  
**Endpoint:** `GET /api/optimise/workforce_snapshots`  
**Natural key:** `employer_ref` + `as_of_date`  
**Entity:** EmployerHeadcountSnapshot

One immutable headcount observation per employer and as-of date. This is the denominator for historical take-up and wellness scores.

| Field | Type | Required | Allowed values / unit | Description |
|---|---|---:|---|---|
| `employer_ref` | string | **yes** |  | Employer code. |
| `as_of_date` | date | **yes** | YYYY-MM-DD | Date the eligible headcount was true as at, normally payroll month-end. |
| `eligible_count` | int | **yes** |  | Eligible/switched-on employee denominator as at this date. |
| `source_updated_at` | datetime | **yes** | ISO-8601 with timezone | UTC timestamp of the last source-system change. Used for incremental pulls and last-write ordering. |
| `is_deleted` | bool | no |  | Technical tombstone that retracts this natural-key record while retaining its audit trail. Use business end dates/statuses for lifecycle changes. |

Example response:

```json
{
  "records": [
    {
      "employer_ref": "VIG",
      "as_of_date": "2026-03-31",
      "eligible_count": 1575,
      "source_updated_at": "2026-04-01T08:00:00Z",
      "is_deleted": false
    }
  ]
}
```

## 8. Workforce / Eligibility

**Report key:** `employees`  
**Endpoint:** `GET /api/optimise/employees`  
**Natural key:** `employer_ref` + `payroll_ref` + `observed_at`  
**Entity:** Employee

One dated workforce observation per employee. The latest observation is the current projection; prior observations preserve historical site/income cohorts.

| Field | Type | Required | Allowed values / unit | Description |
|---|---|---:|---|---|
| `employer_ref` | string | **yes** |  | Employer code. |
| `payroll_ref` | string | **yes** |  | Tokenised unique payroll identifier; never a name or national ID. |
| `observed_at` | date | **yes** | YYYY-MM-DD | Date this site, income-band and eligibility state was observed, normally payroll month-end or a change date. |
| `site_name` | string | no |  | Site/branch true at observed_at and used by the dashboard site filter. |
| `income_band` | enum | no | UNDER_5K \| BAND_5_10K \| BAND_10_20K \| BAND_20_40K \| OVER_40K | Payroll income band used by the dashboard cohort filter. |
| `eligible_from` | date | **yes** | YYYY-MM-DD | First date the employee was in the eligible workforce. |
| `eligible_to` | date | no | YYYY-MM-DD | Last eligible date, inclusive. Blank means still eligible. |
| `active` | bool | no |  | Current-state convenience flag. Effective dates remain authoritative for as-at reporting. |
| `source_updated_at` | datetime | **yes** | ISO-8601 with timezone | UTC timestamp of the last source-system change. Used for incremental pulls and last-write ordering. |
| `is_deleted` | bool | no |  | Technical tombstone that retracts this natural-key record while retaining its audit trail. Use business end dates/statuses for lifecycle changes. |

Example response:

```json
{
  "records": [
    {
      "employer_ref": "VIG",
      "payroll_ref": "EMP-004821",
      "observed_at": "2026-03-31",
      "site_name": "Secunda Site",
      "income_band": "BAND_10_20K",
      "eligible_from": "2025-11-01",
      "eligible_to": "2026-07-31",
      "active": true,
      "source_updated_at": "2026-04-01T08:00:00Z",
      "is_deleted": false
    }
  ]
}
```

## 9. Platform Enrolment

**Report key:** `platform_users`  
**Endpoint:** `GET /api/optimise/platform_users`  
**Natural key:** `employer_ref` + `payroll_ref`  
**Entity:** PlatformUser

One row per employee who created an account. Enrolment and activation are event dates.

| Field | Type | Required | Allowed values / unit | Description |
|---|---|---:|---|---|
| `employer_ref` | string | **yes** |  | Employer code. |
| `payroll_ref` | string | **yes** |  | Must match an employee already loaded. |
| `enrolled_at` | date | **yes** | YYYY-MM-DD | Account creation date. |
| `activated_at` | date | no | YYYY-MM-DD | Date first journey started. Blank means enrolled but not activated. |
| `has_credit_profile` | bool | no |  | Whether debt-account visibility is available. |
| `source_updated_at` | datetime | **yes** | ISO-8601 with timezone | UTC timestamp of the last source-system change. Used for incremental pulls and last-write ordering. |
| `is_deleted` | bool | no |  | Technical tombstone that retracts this natural-key record while retaining its audit trail. Use business end dates/statuses for lifecycle changes. |

Example response:

```json
{
  "records": [
    {
      "employer_ref": "VIG",
      "payroll_ref": "EMP-004821",
      "enrolled_at": "2026-02-14",
      "activated_at": "2026-03-02",
      "has_credit_profile": true,
      "source_updated_at": "2026-04-01T08:00:00Z",
      "is_deleted": false
    }
  ]
}
```

## 10. Journeys & Outcomes

**Report key:** `journeys`  
**Endpoint:** `GET /api/optimise/journeys`  
**Natural key:** `journey_ref`  
**Entity:** Journey

One row per journey. started_at and completed_at drive selected-period activity; source_updated_at drives status upserts.

| Field | Type | Required | Allowed values / unit | Description |
|---|---|---:|---|---|
| `journey_ref` | string | **yes** |  | Unique journey instance identifier. |
| `employer_ref` | string | **yes** |  | Employer code. |
| `payroll_ref` | string | **yes** |  | Employee owning the journey. |
| `type` | enum | **yes** | CREDIT_LIFE \| FUNERAL \| SHORT_TERM \| ARREARS \| PRESCRIBED \| EMERGENCY | Journey type. |
| `status` | enum | **yes** | STARTED \| IN_PROGRESS \| COMPLETED \| GUIDANCE_ONLY \| ABANDONED | Current journey status. COMPLETED is a concrete fix. |
| `started_at` | date | **yes** | YYYY-MM-DD | Journey start date. |
| `completed_at` | date | no | YYYY-MM-DD | Outcome date when completed/guidance reached. |
| `monthly_saving_rand` | decimal | no | rand decimal | Recurring monthly rand saved. |
| `balance_impact_rand` | decimal | no | rand decimal | Balance arranged, challenged or written off. |
| `source_updated_at` | datetime | **yes** | ISO-8601 with timezone | UTC timestamp of the last source-system change. Used for incremental pulls and last-write ordering. |
| `is_deleted` | bool | no |  | Technical tombstone that retracts this natural-key record while retaining its audit trail. Use business end dates/statuses for lifecycle changes. |

Example response:

```json
{
  "records": [
    {
      "journey_ref": "JNY-991201",
      "employer_ref": "VIG",
      "payroll_ref": "EMP-004821",
      "type": "CREDIT_LIFE",
      "status": "COMPLETED",
      "started_at": "2026-03-02",
      "completed_at": "2026-03-20",
      "monthly_saving_rand": 298,
      "balance_impact_rand": 18830,
      "source_updated_at": "2026-04-01T08:00:00Z",
      "is_deleted": false
    }
  ]
}
```

## 11. Debt Account Observations

**Report key:** `debt_accounts`  
**Endpoint:** `GET /api/optimise/debt_accounts`  
**Natural key:** `account_ref` + `observed_at`  
**Entity:** DebtAccount / DebtAccountVersion

One observation per account and observed_at. The latest observation is the current projection; prior observations support exact as-at debt reporting.

| Field | Type | Required | Allowed values / unit | Description |
|---|---|---:|---|---|
| `account_ref` | string | **yes** |  | Stable source account identifier. |
| `employer_ref` | string | **yes** |  | Employer code. |
| `payroll_ref` | string | **yes** |  | Account holder. |
| `observed_at` | date | **yes** | YYYY-MM-DD | Date this balance/state was observed; typically bureau extract date. |
| `closed_at` | date | no | YYYY-MM-DD | Account close date when known. |
| `creditor_name` | string | **yes** |  | Named creditor. |
| `credit_type` | enum | **yes** | BANK_LOAN \| RETAIL_STORE \| MICROLOAN \| OTHER_UNSECURED | Credit category. |
| `balance_rand` | decimal | **yes** | rand decimal | Outstanding balance at observed_at. |
| `in_arrears` | bool | **yes** |  | Whether the account was in arrears at observed_at. |
| `state` | enum | no | NONE \| ACTIVE_INTERVENTION \| CHALLENGED \| GUIDED | Intervention state at observed_at. |
| `challenge_status` | enum | no | IDENTIFIED \| LETTER_SENT \| CREDITOR_CONCEDED \| WRITTEN_OFF | Prescription challenge stage at observed_at. |
| `journey_ref` | string | no |  | Related arrears/prescription journey. |
| `source_updated_at` | datetime | **yes** | ISO-8601 with timezone | UTC timestamp of the last source-system change. Used for incremental pulls and last-write ordering. |
| `is_deleted` | bool | no |  | Technical tombstone that retracts this natural-key record while retaining its audit trail. Use business end dates/statuses for lifecycle changes. |

Example response:

```json
{
  "records": [
    {
      "account_ref": "ACC-55120",
      "employer_ref": "VIG",
      "payroll_ref": "EMP-004821",
      "observed_at": "2026-03-31",
      "closed_at": "2026-04-15",
      "creditor_name": "African Bank",
      "credit_type": "BANK_LOAN",
      "balance_rand": 18830,
      "in_arrears": true,
      "state": "ACTIVE_INTERVENTION",
      "challenge_status": "LETTER_SENT",
      "journey_ref": "JNY-991333",
      "source_updated_at": "2026-04-01T08:00:00Z",
      "is_deleted": false
    }
  ]
}
```

## 12. Insurance Policy Observations

**Report key:** `policies`  
**Endpoint:** `GET /api/optimise/policies`  
**Natural key:** `policy_ref` + `observed_at`  
**Entity:** InsurancePolicy / InsurancePolicyVersion

One observation per policy and observed_at. Effective and resolution dates prevent current policy state being projected backwards.

| Field | Type | Required | Allowed values / unit | Description |
|---|---|---:|---|---|
| `policy_ref` | string | **yes** |  | Stable policy identifier. |
| `employer_ref` | string | **yes** |  | Employer code. |
| `payroll_ref` | string | **yes** |  | Policy holder. |
| `observed_at` | date | **yes** | YYYY-MM-DD | Date the premium/diagnostic state was observed. |
| `effective_from` | date | no | YYYY-MM-DD | Policy cover start date when known. |
| `effective_to` | date | no | YYYY-MM-DD | Policy cover end date when known. |
| `resolved_at` | date | no | YYYY-MM-DD | Date wasteful cover was replaced/consolidated. |
| `type` | enum | **yes** | CREDIT_LIFE \| FUNERAL \| SHORT_TERM | Cover type. |
| `premium_rand` | decimal | **yes** | rand decimal | Monthly premium at observed_at. |
| `is_wasteful` | bool | **yes** |  | Duplicate/over-priced cover diagnostic at observed_at. |
| `is_resolved` | bool | no |  | Whether the identified waste was resolved by observed_at. |
| `source_updated_at` | datetime | **yes** | ISO-8601 with timezone | UTC timestamp of the last source-system change. Used for incremental pulls and last-write ordering. |
| `is_deleted` | bool | no |  | Technical tombstone that retracts this natural-key record while retaining its audit trail. Use business end dates/statuses for lifecycle changes. |

Example response:

```json
{
  "records": [
    {
      "policy_ref": "POL-7781",
      "employer_ref": "VIG",
      "payroll_ref": "EMP-004821",
      "observed_at": "2026-03-31",
      "effective_from": "2024-09-01",
      "effective_to": "2026-04-30",
      "resolved_at": "2026-03-20",
      "type": "FUNERAL",
      "premium_rand": 189,
      "is_wasteful": true,
      "is_resolved": true,
      "source_updated_at": "2026-04-01T08:00:00Z",
      "is_deleted": false
    }
  ]
}
```

## 13. Experience Ratings

**Report key:** `ratings`  
**Endpoint:** `GET /api/optimise/ratings`  
**Natural key:** `rating_ref`  
**Entity:** Rating

One row per post-journey star rating. created_at is the selected-period event date.

| Field | Type | Required | Allowed values / unit | Description |
|---|---|---:|---|---|
| `rating_ref` | string | **yes** |  | Unique rating identifier. |
| `employer_ref` | string | **yes** |  | Employer code. |
| `payroll_ref` | string | **yes** |  | Employee who rated. |
| `journey_type` | enum | no | CREDIT_LIFE \| FUNERAL \| SHORT_TERM \| ARREARS \| PRESCRIBED \| EMERGENCY | Journey rated. |
| `stars` | int | **yes** |  | Rating from 1 to 5. |
| `created_at` | date | **yes** | YYYY-MM-DD | Rating event date. |
| `source_updated_at` | datetime | **yes** | ISO-8601 with timezone | UTC timestamp of the last source-system change. Used for incremental pulls and last-write ordering. |
| `is_deleted` | bool | no |  | Technical tombstone that retracts this natural-key record while retaining its audit trail. Use business end dates/statuses for lifecycle changes. |

Example response:

```json
{
  "records": [
    {
      "rating_ref": "RTG-3310",
      "employer_ref": "VIG",
      "payroll_ref": "EMP-004821",
      "journey_type": "CREDIT_LIFE",
      "stars": 5,
      "created_at": "2026-03-21",
      "source_updated_at": "2026-04-01T08:00:00Z",
      "is_deleted": false
    }
  ]
}
```

## 14. Voice of the Employee (Chat)

**Report key:** `chat_sessions`  
**Endpoint:** `GET /api/optimise/chat_sessions`  
**Natural key:** `session_ref`  
**Entity:** ChatSession

One row per chat session. started_at is the selected-period event date.

| Field | Type | Required | Allowed values / unit | Description |
|---|---|---:|---|---|
| `session_ref` | string | **yes** |  | Unique chat session identifier. |
| `employer_ref` | string | **yes** |  | Employer code. |
| `payroll_ref` | string | **yes** |  | Tokenised employee key required for site and income-band filtering. |
| `journey_type` | enum | no | CREDIT_LIFE \| FUNERAL \| SHORT_TERM \| ARREARS \| PRESCRIBED \| EMERGENCY | Journey discussed. |
| `resolved_in_chat` | bool | no |  | Resolved without human handoff. |
| `first_reply_seconds` | int | no |  | Seconds to first response. |
| `satisfaction` | int | no |  | Post-chat rating from 1 to 5. |
| `sentiment` | decimal | no |  | Classifier sentiment from -1.0 to 1.0. |
| `theme` | string | no |  | Short conversation theme/tag. |
| `primary_question` | string | no |  | Main employee question used for trending questions. |
| `started_at` | date | **yes** | YYYY-MM-DD | Chat event date. |
| `source_updated_at` | datetime | **yes** | ISO-8601 with timezone | UTC timestamp of the last source-system change. Used for incremental pulls and last-write ordering. |
| `is_deleted` | bool | no |  | Technical tombstone that retracts this natural-key record while retaining its audit trail. Use business end dates/statuses for lifecycle changes. |

Example response:

```json
{
  "records": [
    {
      "session_ref": "CHT-20025",
      "employer_ref": "VIG",
      "payroll_ref": "EMP-004821",
      "journey_type": "ARREARS",
      "resolved_in_chat": true,
      "first_reply_seconds": 45,
      "satisfaction": 4,
      "sentiment": 0.6,
      "theme": "Is this legit",
      "primary_question": "Will replacing my credit life affect my credit score?",
      "started_at": "2026-03-18",
      "source_updated_at": "2026-04-01T08:00:00Z",
      "is_deleted": false
    }
  ]
}
```

## 15. Referrals & Sharing

**Report key:** `referrals`  
**Endpoint:** `GET /api/optimise/referrals`  
**Natural key:** `referral_ref`  
**Entity:** Referral

One row per share. shared_at is the activity date; converted_at records the later conversion event.

| Field | Type | Required | Allowed values / unit | Description |
|---|---|---:|---|---|
| `referral_ref` | string | **yes** |  | Unique share/referral identifier. |
| `employer_ref` | string | **yes** |  | Employer code. |
| `payroll_ref` | string | **yes** |  | Employee who shared. |
| `channel` | string | no |  | Share channel, such as WhatsApp, SMS or Email. |
| `shared_at` | date | **yes** | YYYY-MM-DD | Share event date. |
| `converted` | bool | no |  | Whether the share led to enrolment. |
| `converted_at` | date | no | YYYY-MM-DD | Conversion event date when converted is true. |
| `source_updated_at` | datetime | **yes** | ISO-8601 with timezone | UTC timestamp of the last source-system change. Used for incremental pulls and last-write ordering. |
| `is_deleted` | bool | no |  | Technical tombstone that retracts this natural-key record while retaining its audit trail. Use business end dates/statuses for lifecycle changes. |

Example response:

```json
{
  "records": [
    {
      "referral_ref": "REF-8801",
      "employer_ref": "VIG",
      "payroll_ref": "EMP-004821",
      "channel": "WhatsApp",
      "shared_at": "2026-03-19",
      "converted": true,
      "converted_at": "2026-03-22",
      "source_updated_at": "2026-04-01T08:00:00Z",
      "is_deleted": false
    }
  ]
}
```

## 16. Early Wage Access

**Report key:** `salary_advances`  
**Endpoint:** `GET /api/optimise/salary_advances`  
**Natural key:** `salary_advance_id`  
**Entity:** SalaryAdvance

One row per salary advance. advanced_at is mandatory; import time must never be substituted for business time.

| Field | Type | Required | Allowed values / unit | Description |
|---|---|---:|---|---|
| `salary_advance_id` | string | **yes** |  | Unique advance identifier. |
| `employer_ref` | string | **yes** |  | Employer code. |
| `client_id` | string | **yes** |  | EWA client identifier used for unique-client counts. |
| `payroll_ref` | string | **yes** |  | Tokenised payroll key required for site and income-band filtering. |
| `amount` | decimal | **yes** | rand decimal | Advance amount in rands. |
| `salary_advance_status` | enum | **yes** | FINALISED \| PENDING \| DECLINED \| CANCELLED | Only FINALISED contributes to headline totals. |
| `bank_account_verification_status` | enum | no | PASSED \| FAILED \| PENDING \| NOT_RUN | Bank-verification result. |
| `blacklisted` | bool | no |  | Whether the client was blacklisted at source update time. |
| `advanced_at` | date | **yes** | YYYY-MM-DD | Advance business date used for period filtering. |
| `source_updated_at` | datetime | **yes** | ISO-8601 with timezone | UTC timestamp of the last source-system change. Used for incremental pulls and last-write ordering. |
| `is_deleted` | bool | no |  | Technical tombstone that retracts this natural-key record while retaining its audit trail. Use business end dates/statuses for lifecycle changes. |

Example response:

```json
{
  "records": [
    {
      "salary_advance_id": "287646",
      "employer_ref": "VIG",
      "client_id": "132368",
      "payroll_ref": "EMP-004821",
      "amount": 1500,
      "salary_advance_status": "FINALISED",
      "bank_account_verification_status": "PASSED",
      "blacklisted": false,
      "advanced_at": "2026-03-12",
      "source_updated_at": "2026-04-01T08:00:00Z",
      "is_deleted": false
    }
  ]
}
```

## Validation and source-side rules

1. Natural keys must be stable and unique within a response.
2. A repeated natural key with an older `source_updated_at` is stale and is ignored.
3. Date-only fields must be real calendar dates; timestamps must contain a timezone.
4. Required fields remain required on tombstone records in v2.
5. `COMPLETED` journeys require `completed_at`.
6. Inactive employees require `eligible_to`; `eligible_to` is inclusive.
7. Resolved policies require `resolved_at`.
8. Converted referrals require `converted_at`.
9. Rating/chat satisfaction values are 1–5; sentiment is -1.0–1.0; monetary values cannot be negative.
10. The source must map its own labels into the exact contract enums before responding.

## Dashboard mapping summary

| Source feed | Main dashboard use | Time behaviour |
|---|---|---|
| employers | identity/current cache | master/current |
| workforce_snapshots | eligible denominator | latest as-of observation |
| employees | site/income/eligibility cohort | latest valid observation as at end |
| platform_users | enrolment/activation funnel | cumulative by as-at |
| journeys | funnel, outcomes, savings | cumulative stock plus completed-in-window flow |
| debt_accounts | risk, creditors, debt state | latest account observation as at end |
| policies | insurance efficiency/opportunity | latest effective policy observation as at end |
| ratings | satisfaction/NPS | created inside window |
| chat_sessions | chat KPIs/themes | started inside window |
| referrals | sharing/reach | shared inside window |
| salary_advances | EWA uptake/value/trend | finalised and advanced inside window |

## Pre-production confirmation

Confirm the employer-code list, pull frequency, bearer-token exchange, source timezone, historical backfill start date, and reconciliation owners before go-live.
