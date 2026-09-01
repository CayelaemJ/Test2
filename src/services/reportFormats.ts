// ════════════════════════════════════════════════════════════════════
//  EMPOWER-FIN SOURCE REPORT FORMATS — canonical integration contract
//
//  The source sends raw records; the empower-fin Dashboard Portal owns aggregation.  The date model is
//  intentionally split into:
//    • event dates — activity that happened inside a selected period;
//    • effective/observation dates — state that was true as at period end;
//    • source_updated_at — incremental-sync cursor and idempotent upsert order.
//
//  All timestamps are UTC ISO-8601.  Date-only fields are YYYY-MM-DD.
// ════════════════════════════════════════════════════════════════════

export type FieldType = "string" | "int" | "decimal" | "bool" | "date" | "datetime" | "enum";

export interface FieldSpec {
  name: string;
  type: FieldType;
  required: boolean;
  enumValues?: string[];
  cents?: boolean;
  description: string;
  example?: string;
}

export interface ReportFormat {
  key: string;
  title: string;
  entity: string;
  description: string;
  naturalKey: string[];
  fields: FieldSpec[];
}

const SOURCE_FIELDS: FieldSpec[] = [
  {
    name: "source_updated_at",
    type: "datetime",
    required: true,
    description: "UTC timestamp of the last source-system change. Used for incremental pulls and last-write ordering.",
    example: "2026-04-01T08:00:00Z",
  },
  {
    name: "is_deleted",
    type: "bool",
    required: false,
    description: "Technical tombstone that retracts this natural-key record while retaining its audit trail. Use business end dates/statuses for lifecycle changes.",
    example: "false",
  },
];

const JOURNEY_TYPES = ["CREDIT_LIFE", "FUNERAL", "SHORT_TERM", "ARREARS", "PRESCRIBED", "EMERGENCY"];
const INCOME_BANDS = ["UNDER_5K", "BAND_5_10K", "BAND_10_20K", "BAND_20_40K", "OVER_40K"];

const employers: ReportFormat = {
  key: "employers",
  title: "Employers (master)",
  entity: "Employer",
  description: "One row per employer. Identity is master data; historical headcount is supplied separately in workforce_snapshots.",
  naturalKey: ["employer_ref"],
  fields: [
    { name: "employer_ref", type: "string", required: true, description: "Stable employer code used by every dependent report.", example: "VIG" },
    { name: "name", type: "string", required: true, description: "Employer display name.", example: "Vaalwater Industrial Group" },
    { name: "eligible_count", type: "int", required: false, description: "Optional current headcount cache. workforce_snapshots is authoritative for historical reporting.", example: "1575" },
    { name: "eligible_count_as_at", type: "date", required: false, description: "As-of date for eligible_count when that convenience field is supplied.", example: "2026-03-31" },
    ...SOURCE_FIELDS,
  ],
};

const workforceSnapshots: ReportFormat = {
  key: "workforce_snapshots",
  title: "Workforce Headcount Snapshots",
  entity: "EmployerHeadcountSnapshot",
  description: "One immutable headcount observation per employer and as-of date. This is the denominator for historical take-up and wellness scores.",
  naturalKey: ["employer_ref", "as_of_date"],
  fields: [
    { name: "employer_ref", type: "string", required: true, description: "Employer code.", example: "VIG" },
    { name: "as_of_date", type: "date", required: true, description: "Date the eligible headcount was true as at, normally payroll month-end.", example: "2026-03-31" },
    { name: "eligible_count", type: "int", required: true, description: "Eligible/switched-on employee denominator as at this date.", example: "1575" },
    ...SOURCE_FIELDS,
  ],
};

const employees: ReportFormat = {
  key: "employees",
  title: "Workforce / Eligibility",
  entity: "Employee",
  description: "One dated workforce observation per employee. The latest observation is the current projection; prior observations preserve historical site/income cohorts.",
  naturalKey: ["employer_ref", "payroll_ref", "observed_at"],
  fields: [
    { name: "employer_ref", type: "string", required: true, description: "Employer code.", example: "VIG" },
    { name: "payroll_ref", type: "string", required: true, description: "Tokenised unique payroll identifier; never a name or national ID.", example: "EMP-004821" },
    { name: "observed_at", type: "date", required: true, description: "Date this site, income-band and eligibility state was observed, normally payroll month-end or a change date.", example: "2026-03-31" },
    { name: "site_name", type: "string", required: false, description: "Site/branch true at observed_at and used by the dashboard site filter.", example: "Secunda Site" },
    { name: "income_band", type: "enum", required: false, enumValues: INCOME_BANDS, description: "Payroll income band used by the dashboard cohort filter.", example: "BAND_10_20K" },
    { name: "eligible_from", type: "date", required: true, description: "First date the employee was in the eligible workforce.", example: "2025-11-01" },
    { name: "eligible_to", type: "date", required: false, description: "Last eligible date, inclusive. Blank means still eligible.", example: "2026-07-31" },
    { name: "active", type: "bool", required: false, description: "Current-state convenience flag. Effective dates remain authoritative for as-at reporting.", example: "true" },
    ...SOURCE_FIELDS,
  ],
};

const platformUsers: ReportFormat = {
  key: "platform_users",
  title: "Platform Enrolment",
  entity: "PlatformUser",
  description: "One row per employee who created an account. Enrolment and activation are event dates.",
  naturalKey: ["employer_ref", "payroll_ref"],
  fields: [
    { name: "employer_ref", type: "string", required: true, description: "Employer code.", example: "VIG" },
    { name: "payroll_ref", type: "string", required: true, description: "Must match an employee already loaded.", example: "EMP-004821" },
    { name: "enrolled_at", type: "date", required: true, description: "Account creation date.", example: "2026-02-14" },
    { name: "activated_at", type: "date", required: false, description: "Date first journey started. Blank means enrolled but not activated.", example: "2026-03-02" },
    { name: "has_credit_profile", type: "bool", required: false, description: "Whether debt-account visibility is available.", example: "true" },
    ...SOURCE_FIELDS,
  ],
};

const journeys: ReportFormat = {
  key: "journeys",
  title: "Journeys & Outcomes",
  entity: "Journey",
  description: "One row per journey. started_at and completed_at drive selected-period activity; source_updated_at drives status upserts.",
  naturalKey: ["journey_ref"],
  fields: [
    { name: "journey_ref", type: "string", required: true, description: "Unique journey instance identifier.", example: "JNY-991201" },
    { name: "employer_ref", type: "string", required: true, description: "Employer code.", example: "VIG" },
    { name: "payroll_ref", type: "string", required: true, description: "Employee owning the journey.", example: "EMP-004821" },
    { name: "type", type: "enum", required: true, enumValues: JOURNEY_TYPES, description: "Journey type.", example: "CREDIT_LIFE" },
    { name: "status", type: "enum", required: true, enumValues: ["STARTED", "IN_PROGRESS", "COMPLETED", "GUIDANCE_ONLY", "ABANDONED"], description: "Current journey status. COMPLETED is a concrete fix.", example: "COMPLETED" },
    { name: "started_at", type: "date", required: true, description: "Journey start date.", example: "2026-03-02" },
    { name: "completed_at", type: "date", required: false, description: "Outcome date when completed/guidance reached.", example: "2026-03-20" },
    { name: "monthly_saving_rand", type: "decimal", required: false, cents: true, description: "Recurring monthly rand saved.", example: "298.00" },
    { name: "balance_impact_rand", type: "decimal", required: false, cents: true, description: "Balance arranged, challenged or written off.", example: "18830.00" },
    ...SOURCE_FIELDS,
  ],
};

const debtAccounts: ReportFormat = {
  key: "debt_accounts",
  title: "Debt Account Observations",
  entity: "DebtAccount / DebtAccountVersion",
  description: "One observation per account and observed_at. The latest observation is the current projection; prior observations support exact as-at debt reporting.",
  naturalKey: ["account_ref", "observed_at"],
  fields: [
    { name: "account_ref", type: "string", required: true, description: "Stable source account identifier.", example: "ACC-55120" },
    { name: "employer_ref", type: "string", required: true, description: "Employer code.", example: "VIG" },
    { name: "payroll_ref", type: "string", required: true, description: "Account holder.", example: "EMP-004821" },
    { name: "observed_at", type: "date", required: true, description: "Date this balance/state was observed; typically bureau extract date.", example: "2026-03-31" },
    { name: "closed_at", type: "date", required: false, description: "Account close date when known.", example: "2026-04-15" },
    { name: "creditor_name", type: "string", required: true, description: "Named creditor.", example: "African Bank" },
    { name: "credit_type", type: "enum", required: true, enumValues: ["BANK_LOAN", "RETAIL_STORE", "MICROLOAN", "OTHER_UNSECURED"], description: "Credit category.", example: "BANK_LOAN" },
    { name: "balance_rand", type: "decimal", required: true, cents: true, description: "Outstanding balance at observed_at.", example: "18830.00" },
    { name: "in_arrears", type: "bool", required: true, description: "Whether the account was in arrears at observed_at.", example: "true" },
    { name: "state", type: "enum", required: false, enumValues: ["NONE", "ACTIVE_INTERVENTION", "CHALLENGED", "GUIDED"], description: "Intervention state at observed_at.", example: "ACTIVE_INTERVENTION" },
    { name: "challenge_status", type: "enum", required: false, enumValues: ["IDENTIFIED", "LETTER_SENT", "CREDITOR_CONCEDED", "WRITTEN_OFF"], description: "Prescription challenge stage at observed_at.", example: "LETTER_SENT" },
    { name: "journey_ref", type: "string", required: false, description: "Related arrears/prescription journey.", example: "JNY-991333" },
    ...SOURCE_FIELDS,
  ],
};

const policies: ReportFormat = {
  key: "policies",
  title: "Insurance Policy Observations",
  entity: "InsurancePolicy / InsurancePolicyVersion",
  description: "One observation per policy and observed_at. Effective and resolution dates prevent current policy state being projected backwards.",
  naturalKey: ["policy_ref", "observed_at"],
  fields: [
    { name: "policy_ref", type: "string", required: true, description: "Stable policy identifier.", example: "POL-7781" },
    { name: "employer_ref", type: "string", required: true, description: "Employer code.", example: "VIG" },
    { name: "payroll_ref", type: "string", required: true, description: "Policy holder.", example: "EMP-004821" },
    { name: "observed_at", type: "date", required: true, description: "Date the premium/diagnostic state was observed.", example: "2026-03-31" },
    { name: "effective_from", type: "date", required: false, description: "Policy cover start date when known.", example: "2024-09-01" },
    { name: "effective_to", type: "date", required: false, description: "Policy cover end date when known.", example: "2026-04-30" },
    { name: "resolved_at", type: "date", required: false, description: "Date wasteful cover was replaced/consolidated.", example: "2026-03-20" },
    { name: "type", type: "enum", required: true, enumValues: ["CREDIT_LIFE", "FUNERAL", "SHORT_TERM"], description: "Cover type.", example: "FUNERAL" },
    { name: "premium_rand", type: "decimal", required: true, cents: true, description: "Monthly premium at observed_at.", example: "189.00" },
    { name: "is_wasteful", type: "bool", required: true, description: "Duplicate/over-priced cover diagnostic at observed_at.", example: "true" },
    { name: "is_resolved", type: "bool", required: false, description: "Whether the identified waste was resolved by observed_at.", example: "true" },
    ...SOURCE_FIELDS,
  ],
};

const ratings: ReportFormat = {
  key: "ratings",
  title: "Experience Ratings",
  entity: "Rating",
  description: "One row per post-journey star rating. created_at is the selected-period event date.",
  naturalKey: ["rating_ref"],
  fields: [
    { name: "rating_ref", type: "string", required: true, description: "Unique rating identifier.", example: "RTG-3310" },
    { name: "employer_ref", type: "string", required: true, description: "Employer code.", example: "VIG" },
    { name: "payroll_ref", type: "string", required: true, description: "Employee who rated.", example: "EMP-004821" },
    { name: "journey_type", type: "enum", required: false, enumValues: JOURNEY_TYPES, description: "Journey rated.", example: "CREDIT_LIFE" },
    { name: "stars", type: "int", required: true, description: "Rating from 1 to 5.", example: "5" },
    { name: "created_at", type: "date", required: true, description: "Rating event date.", example: "2026-03-21" },
    ...SOURCE_FIELDS,
  ],
};

const referrals: ReportFormat = {
  key: "referrals",
  title: "Referrals & Sharing",
  entity: "Referral",
  description: "One row per share. shared_at is the activity date; converted_at records the later conversion event.",
  naturalKey: ["referral_ref"],
  fields: [
    { name: "referral_ref", type: "string", required: true, description: "Unique share/referral identifier.", example: "REF-8801" },
    { name: "employer_ref", type: "string", required: true, description: "Employer code.", example: "VIG" },
    { name: "payroll_ref", type: "string", required: true, description: "Employee who shared.", example: "EMP-004821" },
    { name: "channel", type: "string", required: false, description: "Share channel, such as WhatsApp, SMS or Email.", example: "WhatsApp" },
    { name: "shared_at", type: "date", required: true, description: "Share event date.", example: "2026-03-19" },
    { name: "converted", type: "bool", required: false, description: "Whether the share led to enrolment.", example: "true" },
    { name: "converted_at", type: "date", required: false, description: "Conversion event date when converted is true.", example: "2026-03-22" },
    ...SOURCE_FIELDS,
  ],
};

const salaryAdvances: ReportFormat = {
  key: "salary_advances",
  title: "Early Wage Access",
  entity: "SalaryAdvance",
  description: "One row per salary advance. advanced_at is mandatory; import time must never be substituted for business time.",
  naturalKey: ["salary_advance_id"],
  fields: [
    { name: "salary_advance_id", type: "string", required: true, description: "Unique advance identifier.", example: "287646" },
    { name: "employer_ref", type: "string", required: true, description: "Employer code.", example: "VIG" },
    { name: "client_id", type: "string", required: true, description: "EWA client identifier used for unique-client counts.", example: "132368" },
    { name: "payroll_ref", type: "string", required: true, description: "Tokenised payroll key required for site and income-band filtering.", example: "EMP-004821" },
    { name: "amount", type: "decimal", required: true, cents: true, description: "Advance amount in rands.", example: "1500.00" },
    { name: "salary_advance_status", type: "enum", required: true, enumValues: ["FINALISED", "PENDING", "DECLINED", "CANCELLED"], description: "Only FINALISED contributes to headline totals.", example: "FINALISED" },
    { name: "bank_account_verification_status", type: "enum", required: false, enumValues: ["PASSED", "FAILED", "PENDING", "NOT_RUN"], description: "Bank-verification result.", example: "PASSED" },
    { name: "blacklisted", type: "bool", required: false, description: "Whether the client was blacklisted at source update time.", example: "false" },
    { name: "advanced_at", type: "date", required: true, description: "Advance business date used for period filtering.", example: "2026-03-12" },
    ...SOURCE_FIELDS,
  ],
};

export const REPORT_FORMATS: ReportFormat[] = [
  employers,
  workforceSnapshots,
  employees,
  platformUsers,
  journeys,
  debtAccounts,
  policies,
  ratings,
  referrals,
  salaryAdvances,
];

export const LOAD_ORDER = [
  "employers",
  "workforce_snapshots",
  "employees",
  "platform_users",
  "journeys",
  "debt_accounts",
  "policies",
  "ratings",
  "referrals",
  "salary_advances",
];

export function getFormat(key: string): ReportFormat | undefined {
  return REPORT_FORMATS.find((f) => f.key === key);
}
