// ════════════════════════════════════════════════════════════════════
//  SNAPSHOT + DASHBOARD BUILDER (v2)
//
//  Stock measures are selected AS AT the filter end date.
//  Flow measures are selected INSIDE the filter window.
//  Historical payloads are complete — the frontend never fills missing live
//  values from demonstration data.
// ════════════════════════════════════════════════════════════════════

import { IncomeBand, PrismaClient } from "@prisma/client";
import { computeOptimiseScore, DEFAULT_WEIGHTS, DriverAvailability, ScoreInputs, Weights } from "./scoreEngine.js";

const prisma = new PrismaClient();
const DAY_MS = 86_400_000;
const rand = (cents: number) => cents / 100;

export type DashboardRange = "30d" | "quarter" | "all" | "month";
export interface DashboardQuery {
  period?: string;
  range?: DashboardRange | "30" | "q" | "latest";
  site?: string;
  income?: string;
}

interface ResolvedFilter {
  period: string | null;
  range: DashboardRange;
  rangeStart: Date | null;
  rangeEnd: Date;
  asAt: Date;
  site: string | null;
  income: IncomeBand | null;
  label: string;
}

const CREDIT_TYPE_LABEL: Record<string, string> = {
  BANK_LOAN: "Bank personal loans",
  RETAIL_STORE: "Retail / store credit",
  MICROLOAN: "Microloans",
  OTHER_UNSECURED: "Other unsecured",
};
const CREDIT_TYPE_COLOR: Record<string, string> = {
  BANK_LOAN: "#003a66",
  RETAIL_STORE: "#0078c7",
  MICROLOAN: "#e8910c",
  OTHER_UNSECURED: "#8497a7",
};
const JOURNEY_LABEL: Record<string, string> = {
  CREDIT_LIFE: "Credit Life Replacement",
  FUNERAL: "Funeral Consolidation",
  SHORT_TERM: "Short-Term Insurance Audit",
  ARREARS: "Arrears Resolution",
  PRESCRIBED: "Prescribed Debt Challenge",
  EMERGENCY: "Emergency Cash Assistance",
};
const JOURNEY_ICON: Record<string, string> = {
  CREDIT_LIFE: "shield",
  FUNERAL: "umbrella",
  SHORT_TERM: "car",
  ARREARS: "scale",
  PRESCRIBED: "scroll",
  EMERGENCY: "wallet",
};
const JOURNEY_KEY: Record<string, string> = {
  CREDIT_LIFE: "credit",
  FUNERAL: "funeral",
  SHORT_TERM: "sti",
  ARREARS: "arrears",
  PRESCRIBED: "prescribed",
  EMERGENCY: "emergency",
};
const INCOME_LABEL: Record<string, string> = {
  UNDER_5K: "Under R5k/mo",
  BAND_5_10K: "R5k–R10k/mo",
  BAND_10_20K: "R10k–R20k/mo",
  BAND_20_40K: "R20k–R40k/mo",
  OVER_40K: "Over R40k/mo",
};
const INCOME_VALUES = Object.keys(INCOME_LABEL) as IncomeBand[];
const CORE_FEEDS = [
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
] as const;
type CoreFeed = typeof CORE_FEEDS[number];

const CORE_FEED_LABELS: Record<CoreFeed, string> = {
  employers: "Employers",
  workforce_snapshots: "Workforce Headcount Snapshots",
  employees: "Employees / Workforce Eligibility",
  platform_users: "Platform Users / Enrolment",
  journeys: "Journeys & Outcomes",
  debt_accounts: "Debt Accounts",
  policies: "Insurance Policies",
  ratings: "Experience Ratings",
  referrals: "Referrals & Sharing",
  salary_advances: "Early Wage Access",
};

interface FeedCoverageEntry {
  available: boolean;
  source: "record" | "file_import" | "live_sync" | "not_loaded";
  lastSuccessAt: string | null;
}


function zar(cents: number): string {
  return "R " + Math.round(rand(cents)).toLocaleString("en-ZA");
}
function zarM(cents: number): string {
  const value = rand(cents);
  if (Math.abs(value) >= 1_000_000) return `R ${(value / 1_000_000).toFixed(2)}m`;
  if (Math.abs(value) >= 1_000) return `R ${Math.round(value / 1_000)}k`;
  return `R ${Math.round(value)}`;
}
function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
function startOfMonth(period: string): Date {
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1));
}
function endOfMonth(period: string): Date {
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
}
function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
function monthLabel(key: string): string {
  const [year, month] = key.split("-");
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(month) - 1]} ${year.slice(2)}`;
}
export function currentPeriod(): string {
  return monthKey(new Date());
}
function isValidPeriod(value: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(value)) return false;
  const month = Number(value.slice(5));
  return month >= 1 && month <= 12;
}
function normalizeRange(value?: string): DashboardRange {
  if (value === "30" || value === "30d") return "30d";
  if (value === "q" || value === "quarter") return "quarter";
  if (value === "month") return "month";
  return "all";
}
function resolveFilter(query: DashboardQuery = {}): ResolvedFilter {
  const now = new Date();
  if (query.period && (!isValidPeriod(query.period) || query.period > currentPeriod())) {
    throw new Error("period must be a valid YYYY-MM not later than the current month");
  }
  if (query.period && query.range) {
    throw new Error("use period or range, not both");
  }
  const period = query.period ?? null;
  const range = period ? "month" : normalizeRange(query.range);
  if (!period && range === "month") {
    throw new Error("range=month requires period=YYYY-MM");
  }
  // A closed month is measured at month-end. The current month is month-to-date
  // and must never use a future month-end as its as-at boundary.
  const asAt = period ? (period === currentPeriod() ? now : endOfMonth(period)) : now;
  let rangeStart: Date | null = null;
  let label = "Programme to date";

  if (range === "month") {
    rangeStart = startOfMonth(period!);
    label = new Intl.DateTimeFormat("en-ZA", { month: "long", year: "numeric", timeZone: "UTC" }).format(rangeStart);
    if (period === currentPeriod()) label += " (month to date)";
  } else if (range === "30d") {
    rangeStart = new Date(startOfUtcDay(asAt).getTime() - 29 * DAY_MS);
    label = "Last 30 days";
  } else if (range === "quarter") {
    const quarterMonth = Math.floor(asAt.getUTCMonth() / 3) * 3;
    rangeStart = new Date(Date.UTC(asAt.getUTCFullYear(), quarterMonth, 1));
    label = "Quarter to date";
  }

  const income = query.income && INCOME_VALUES.includes(query.income as IncomeBand)
    ? query.income as IncomeBand
    : null;
  return {
    period,
    range,
    rangeStart,
    rangeEnd: asAt,
    asAt,
    site: query.site && query.site !== "all" ? query.site : null,
    income,
    label,
  };
}
function existsAt(sourceDeletedAt: Date | null, _asAt: Date): boolean {
  // is_deleted is a technical retraction of the natural-key record, not a
  // business lifecycle date. Business ends use eligible_to/closed_at/effective_to.
  return !sourceDeletedAt;
}
function employeeEligibleAt(employee: any, asAt: Date): boolean {
  const selectedDay = startOfUtcDay(asAt);
  return !employee.isDeleted
    && existsAt(employee.sourceDeletedAt, asAt)
    && (!employee.eligibleFrom || employee.eligibleFrom <= asAt)
    // eligible_to is a date-only, inclusive business end date.
    && (!employee.eligibleTo || employee.eligibleTo >= selectedDay);
}

async function workforceAsAt(employerId: string, asAt: Date) {
  const employees: any[] = await prisma.employee.findMany({
    where: { employerId },
    include: { site: true, platformUser: true },
  });
  if (!employees.length) return { rows: [] as any[], usedFallback: false, missingAsAtCount: 0, versionCount: 0 };

  const employeeIds = employees.map((employee: any) => employee.id);
  const [versions, versionedRows] = await Promise.all([
    prisma.employeeVersion.findMany({
      where: { employeeId: { in: employeeIds }, observedAt: { lte: asAt }, isDeleted: false },
      orderBy: [{ employeeId: "asc" }, { observedAt: "desc" }, { sourceUpdatedAt: "desc" }],
    }),
    prisma.employeeVersion.findMany({
      where: { employeeId: { in: employeeIds } },
      select: { employeeId: true },
      distinct: ["employeeId"],
    }),
  ]);

  const latest = new Map<string, any>();
  for (const version of versions as any[]) if (!latest.has(version.employeeId)) latest.set(version.employeeId, version);
  const hasAnyVersion = new Set((versionedRows as any[]).map((row: any) => row.employeeId));
  let usedFallback = false;
  let missingAsAtCount = 0;
  const rows: any[] = [];

  for (const employee of employees) {
    const version = latest.get(employee.id);
    if (version) {
      rows.push({
        ...employee,
        site: version.siteName ? { name: version.siteName } : null,
        incomeBand: version.incomeBand,
        active: version.active,
        observedAt: version.observedAt,
        eligibleFrom: version.eligibleFrom,
        eligibleTo: version.eligibleTo,
        sourceUpdatedAt: version.sourceUpdatedAt,
        sourceDeletedAt: version.isDeleted ? version.sourceUpdatedAt : null,
        isDeleted: version.isDeleted,
        workforceSource: "version",
      });
      continue;
    }
    // Legacy rows that pre-date the v2 version table remain visible but are
    // explicitly flagged; once any versions exist, dates before the first
    // observation are not backfilled from today's projection.
    if (!hasAnyVersion.has(employee.id)) {
      usedFallback = true;
      rows.push({ ...employee, workforceSource: "projection" });
    } else {
      missingAsAtCount++;
    }
  }

  return { rows, usedFallback, missingAsAtCount, versionCount: (versions as any[]).length };
}
function inWindow(date: Date | null | undefined, filter: ResolvedFilter): boolean {
  return !!date && date <= filter.rangeEnd && (!filter.rangeStart || date >= filter.rangeStart);
}
function atOrBefore(date: Date | null | undefined, asAt: Date): boolean {
  return !!date && date <= asAt;
}
function wellnessBand(score: number | null): string {
  if (score == null) return "Unavailable";
  if (score >= 80) return "Strong";
  if (score >= 60) return "Improving";
  if (score >= 40) return "At risk";
  return "Critical";
}
function maxDate(values: Array<Date | null | undefined>): Date | null {
  const valid = values.filter((value): value is Date => value instanceof Date && !Number.isNaN(value.getTime()));
  return valid.length ? new Date(Math.max(...valid.map((date) => date.getTime()))) : null;
}

async function feedCoverageForEmployer(
  employerId: string,
  evidence: Partial<Record<CoreFeed, boolean>>,
): Promise<Record<CoreFeed, FeedCoverageEntry>> {
  const [cursors, batches] = await Promise.all([
    prisma.integrationCursor.findMany({
      where: { reportKey: { in: [...CORE_FEEDS] }, lastSuccessAt: { not: null } },
      select: { reportKey: true, lastSuccessAt: true },
    }),
    prisma.importBatch.findMany({
      where: { status: "COMMITTED", reportKey: { in: [...CORE_FEEDS] } },
      orderBy: { committedAt: "desc" },
      select: { reportKey: true, employerRef: true, stagedRows: true, committedAt: true },
    }),
  ]);

  const syncByFeed = new Map<string, Date>();
  for (const cursor of cursors as any[]) {
    if (cursor.lastSuccessAt) syncByFeed.set(cursor.reportKey, cursor.lastSuccessAt);
  }

  const importByFeed = new Map<string, Date>();
  for (const batch of batches as any[]) {
    if (!CORE_FEEDS.includes(batch.reportKey as CoreFeed)) continue;
    let applies = batch.employerRef === employerId;
    if (!applies && Array.isArray(batch.stagedRows)) {
      applies = batch.stagedRows.some((row: any) => String(row?.employer_ref ?? "") === employerId);
    }
    if (applies && !importByFeed.has(batch.reportKey)) {
      importByFeed.set(batch.reportKey, batch.committedAt ?? new Date(0));
    }
  }

  const coverage = {} as Record<CoreFeed, FeedCoverageEntry>;
  for (const feed of CORE_FEEDS) {
    const rowEvidence = Boolean(evidence[feed]);
    const importedAt = importByFeed.get(feed);
    const syncAt = syncByFeed.get(feed);
    if (rowEvidence) {
      coverage[feed] = { available: true, source: "record", lastSuccessAt: null };
    } else if (importedAt) {
      coverage[feed] = { available: true, source: "file_import", lastSuccessAt: importedAt.toISOString() };
    } else if (syncAt) {
      // A successful API/SQL report pull is authoritative even when the result
      // for this employer is empty. That is how we distinguish a confirmed
      // zero from a feed that has never been loaded.
      coverage[feed] = { available: true, source: "live_sync", lastSuccessAt: syncAt.toISOString() };
    } else {
      coverage[feed] = { available: false, source: "not_loaded", lastSuccessAt: null };
    }
  }
  return coverage;
}

async function activeWeights(employerId: string, asAt: Date): Promise<Weights> {
  const rows = await prisma.scoreWeight.findMany({
    where: { OR: [{ employerId }, { employerId: null }], effectiveFrom: { lte: asAt } },
    orderBy: { effectiveFrom: "desc" },
  });
  const pick = (driver: string) => rows.find((row: any) => row.driver === driver && row.employerId === employerId)
    ?? rows.find((row: any) => row.driver === driver && row.employerId == null);
  return {
    ENGAGEMENT: pick("ENGAGEMENT")?.weight ?? DEFAULT_WEIGHTS.ENGAGEMENT,
    CASHFLOW: pick("CASHFLOW")?.weight ?? DEFAULT_WEIGHTS.CASHFLOW,
    DEBT_RISK: pick("DEBT_RISK")?.weight ?? DEFAULT_WEIGHTS.DEBT_RISK,
    INSURANCE: pick("INSURANCE")?.weight ?? DEFAULT_WEIGHTS.INSURANCE,
  };
}

async function latestDebtState(platformUserIds: string[], asAt: Date) {
  if (!platformUserIds.length) return { rows: [] as any[], usedFallback: false, versionCount: 0 };
  const versions = await prisma.debtAccountVersion.findMany({
    where: { account: { platformUserId: { in: platformUserIds } }, observedAt: { lte: asAt }, isDeleted: false },
    include: { account: { select: { id: true, platformUserId: true } } },
    orderBy: [{ accountId: "asc" }, { observedAt: "desc" }, { sourceUpdatedAt: "desc" }],
  });
  const latest = new Map<string, any>();
  for (const version of versions as any[]) if (!latest.has(version.accountId)) latest.set(version.accountId, version);
  const seen = new Set(latest.keys());
  const result: any[] = [];
  for (const version of latest.values()) {
    if (version.isDeleted || (version.closedAt && version.closedAt <= asAt)) continue;
    result.push({
      id: version.accountId,
      platformUserId: version.account.platformUserId,
      creditorName: version.creditorName,
      creditType: version.creditType,
      balanceCents: version.balanceCents,
      inArrears: version.inArrears,
      state: version.state,
      challengeStatus: version.challengeStatus,
      observedAt: version.observedAt,
      sourceUpdatedAt: version.sourceUpdatedAt,
    });
  }

  const projections = await prisma.debtAccount.findMany({
    where: {
      platformUserId: { in: platformUserIds },
      observedAt: { lte: asAt },
      sourceDeletedAt: null,
    },
  });
  let usedFallback = false;
  for (const account of projections as any[]) {
    if (seen.has(account.id) || (account.closedAt && account.closedAt <= asAt)) continue;
    usedFallback = true;
    result.push(account);
  }
  return { rows: result, usedFallback, versionCount: versions.length };
}

async function latestPolicyState(platformUserIds: string[], asAt: Date) {
  if (!platformUserIds.length) return { rows: [] as any[], usedFallback: false, versionCount: 0 };
  const versions = await prisma.insurancePolicyVersion.findMany({
    where: { policy: { platformUserId: { in: platformUserIds } }, observedAt: { lte: asAt }, isDeleted: false },
    include: { policy: { select: { id: true, platformUserId: true } } },
    orderBy: [{ policyId: "asc" }, { observedAt: "desc" }, { sourceUpdatedAt: "desc" }],
  });
  const latest = new Map<string, any>();
  for (const version of versions as any[]) if (!latest.has(version.policyId)) latest.set(version.policyId, version);
  const seen = new Set(latest.keys());
  const result: any[] = [];
  for (const version of latest.values()) {
    if (version.isDeleted) continue;
    if (version.effectiveFrom && version.effectiveFrom > asAt) continue;
    if (version.effectiveTo && version.effectiveTo < startOfUtcDay(asAt)) continue;
    result.push({
      id: version.policyId,
      platformUserId: version.policy.platformUserId,
      type: version.type,
      premiumCents: version.premiumCents,
      isWasteful: version.isWasteful,
      isResolved: version.resolvedAt ? version.resolvedAt <= asAt : version.isResolved,
      observedAt: version.observedAt,
      sourceUpdatedAt: version.sourceUpdatedAt,
    });
  }

  const projections = await prisma.insurancePolicy.findMany({
    where: {
      platformUserId: { in: platformUserIds },
      observedAt: { lte: asAt },
      sourceDeletedAt: null,
    },
  });
  let usedFallback = false;
  for (const policy of projections as any[]) {
    if (seen.has(policy.id)) continue;
    if (policy.effectiveFrom && policy.effectiveFrom > asAt) continue;
    if (policy.effectiveTo && policy.effectiveTo < startOfUtcDay(asAt)) continue;
    usedFallback = true;
    result.push({ ...policy, isResolved: policy.resolvedAt ? policy.resolvedAt <= asAt : policy.isResolved });
  }
  return { rows: result, usedFallback, versionCount: versions.length };
}

async function buildDashboardPayload(employerId: string, query: DashboardQuery = {}) {
  // "Latest" must mean "the most recent single period with data" — it was
  // previously falling through to range=all (a programme-to-date aggregate),
  // which barely moves as new data lands and reads as "the number doesn't
  // update". Resolve it to a real period up front, before anything else.
  let effectiveQuery: DashboardQuery = query;
  if (query.range === "latest" && !query.period) {
    const latestSnap = await prisma.scoreSnapshot.findFirst({ where: { employerId }, orderBy: { period: "desc" }, select: { period: true } });
    effectiveQuery = { ...query, range: undefined, period: latestSnap?.period ?? currentPeriod() };
  }
  const filter = resolveFilter(effectiveQuery);
  const employer = await prisma.employer.findFirstOrThrow({ where: { id: employerId, sourceDeletedAt: null } });
  const workforceState = await workforceAsAt(employerId, filter.asAt);
  const eligibleEmployees = workforceState.rows.filter((employee: any) => employeeEligibleAt(employee, filter.asAt));
  const cohortEmployees = eligibleEmployees.filter((employee) =>
    (!filter.site || employee.site?.name === filter.site)
    && (!filter.income || employee.incomeBand === filter.income),
  );
  const employeeIds = cohortEmployees.map((employee) => employee.id);
  const platformUsers = cohortEmployees
    .map((employee) => employee.platformUser)
    .filter((user) => user && user.enrolledAt <= filter.asAt && existsAt(user.sourceDeletedAt, filter.asAt));
  const platformUserIds = platformUsers.map((user: any) => user.id);
  const employeeByPlatformUser = new Map<string, any>();
  for (const employee of cohortEmployees) if (employee.platformUser) employeeByPlatformUser.set(employee.platformUser.id, employee);

  const headcountSnapshot = !filter.site && !filter.income
    ? await prisma.employerHeadcountSnapshot.findFirst({
      where: {
        employerId,
        asOfDate: { lte: filter.asAt },
        sourceDeletedAt: null,
      },
      orderBy: { asOfDate: "desc" },
    })
    : null;
  const headcount = filter.site || filter.income
    ? cohortEmployees.length
    : (headcountSnapshot?.eligibleCount ?? (eligibleEmployees.length || employer.eligibleCount));

  const [journeys, ratingsAll, chatsAll, referralsAll, advancesAll, debtState, policyState] = await Promise.all([
    platformUserIds.length ? prisma.journey.findMany({ where: { platformUserId: { in: platformUserIds }, startedAt: { lte: filter.asAt } } }) : [],
    platformUserIds.length ? prisma.rating.findMany({ where: { platformUserId: { in: platformUserIds }, createdAt: { lte: filter.asAt } } }) : [],
    employeeIds.length ? prisma.chatSession.findMany({ where: { employerId, employeeId: { in: employeeIds }, startedAt: { lte: filter.asAt } } }) : [],
    platformUserIds.length ? prisma.referral.findMany({ where: { platformUserId: { in: platformUserIds }, sharedAt: { lte: filter.asAt } } }) : [],
    employeeIds.length ? prisma.salaryAdvance.findMany({ where: { employerId, employeeId: { in: employeeIds }, advancedAt: { lte: filter.asAt } } }) : [],
    latestDebtState(platformUserIds, filter.asAt),
    latestPolicyState(platformUserIds, filter.asAt),
  ]);

  const liveJourneys = (journeys as any[]).filter((journey) => existsAt(journey.sourceDeletedAt, filter.asAt));
  const cumulativeCompleted = liveJourneys.filter((journey) => journey.status === "COMPLETED" && atOrBefore(journey.completedAt, filter.asAt));
  const flowCompleted = cumulativeCompleted.filter((journey) => inWindow(journey.completedAt, filter));
  const ratings = (ratingsAll as any[]).filter((row) => existsAt(row.sourceDeletedAt, filter.asAt) && inWindow(row.createdAt, filter));
  const chats = (chatsAll as any[]).filter((row) => existsAt(row.sourceDeletedAt, filter.asAt) && inWindow(row.startedAt, filter));
  const referrals = (referralsAll as any[]).filter((row) => existsAt(row.sourceDeletedAt, filter.asAt) && inWindow(row.sharedAt, filter));
  const advances = (advancesAll as any[]).filter((row) => existsAt(row.sourceDeletedAt, filter.asAt) && row.status === "FINALISED" && inWindow(row.advancedAt, filter));
  const debts = debtState.rows;
  const policies = policyState.rows;

  const feedCoverage = await feedCoverageForEmployer(employerId, {
    employers: true,
    // Do not infer that the workforce_snapshots feed has been loaded merely
    // because an old convenience headcount row exists. Coverage for this feed
    // comes from an explicit import/successful source sync.
    workforce_snapshots: false,
    employees: workforceState.rows.length > 0 || workforceState.versionCount > 0,
    platform_users: platformUsers.length > 0,
    journeys: (journeys as any[]).length > 0,
    debt_accounts: debts.length > 0 || debtState.versionCount > 0,
    policies: policies.length > 0 || policyState.versionCount > 0,
    ratings: (ratingsAll as any[]).length > 0,
    referrals: (referralsAll as any[]).length > 0,
    salary_advances: (advancesAll as any[]).length > 0,
  });

  const headcountDataAvailable = filter.site || filter.income
    ? feedCoverage.employees.available
    : (feedCoverage.workforce_snapshots.available && Boolean(headcountSnapshot)) || feedCoverage.employees.available;

  const enrolled = platformUsers.length;
  const activatedUsers = platformUsers.filter((user: any) => atOrBefore(user.activatedAt, filter.asAt));
  const activated = activatedUsers.length;
  const completedUserIds = new Set(cumulativeCompleted.map((journey: any) => journey.platformUserId));
  const completedFix = completedUserIds.size;
  const completedCounts = new Map<string, number>();
  for (const journey of cumulativeCompleted as any[]) completedCounts.set(journey.platformUserId, (completedCounts.get(journey.platformUserId) ?? 0) + 1);
  const multipleFix = [...completedCounts.values()].filter((count) => count >= 2).length;
  const startedUserIds = new Set(liveJourneys.filter((journey: any) => journey.startedAt <= filter.asAt).map((journey: any) => journey.platformUserId));

  const cumulativeMonthlySaving = cumulativeCompleted.reduce((sum: number, journey: any) => sum + (journey.monthlySavingCents ?? 0), 0);
  const flowMonthlySaving = flowCompleted.reduce((sum: number, journey: any) => sum + (journey.monthlySavingCents ?? 0), 0);
  const targetRows = await prisma.achievableTarget.findMany({
    where: { OR: [{ employerId }, { employerId: null }], driver: "CASHFLOW", effectiveFrom: { lte: filter.asAt } },
    orderBy: { effectiveFrom: "desc" },
  });
  const target = (targetRows as any[]).find((row: any) => row.employerId === employerId)
    ?? (targetRows as any[]).find((row: any) => row.employerId == null);
  const savingsAchievable = Number((target?.config as any)?.monthlyAchievableRand ?? rand(cumulativeMonthlySaving));
  const arrearsUserIds = new Set(debts.filter((debt: any) => debt.inArrears).map((debt: any) => debt.platformUserId));
  const debtVisibleUserIds = new Set<string>();
  for (const user of platformUsers as any[]) if (user.hasCreditProfile) debtVisibleUserIds.add(user.id);
  for (const debt of debts as any[]) if (debt.platformUserId) debtVisibleUserIds.add(debt.platformUserId);
  const wastefulPolicies = policies.filter((policy: any) => policy.isWasteful);
  const fixedPolicies = wastefulPolicies.filter((policy: any) => policy.isResolved);

  const driverAvailability: DriverAvailability = {
    engagement: headcountDataAvailable && headcount > 0 && feedCoverage.platform_users.available && feedCoverage.journeys.available,
    cashflow: feedCoverage.platform_users.available && feedCoverage.journeys.available,
    debtRisk: feedCoverage.platform_users.available && feedCoverage.debt_accounts.available && debtVisibleUserIds.size > 0,
    insurance: feedCoverage.platform_users.available && feedCoverage.policies.available && policies.length > 0,
  };

  const inputs: ScoreInputs = {
    usersStartedJourney: startedUserIds.size,
    eligibleEmployees: headcount,
    savingsUnlocked: rand(cumulativeMonthlySaving),
    savingsAchievable,
    platformUsersInArrears: arrearsUserIds.size,
    platformUsers: debtVisibleUserIds.size,
    wastefulCoverFixed: fixedPolicies.length,
    wastefulCoverFound: wastefulPolicies.length,
    policiesObserved: policies.length,
  };
  const weights = await activeWeights(employerId, filter.asAt);
  const score = computeOptimiseScore(inputs, weights, driverAvailability);
  const pct = (value: number) => headcount ? Math.round((value / headcount) * 100) : 0;

  const byType = new Map<string, { count: number; saving: number; balance: number }>();
  for (const journey of flowCompleted as any[]) {
    const bucket = byType.get(journey.type) ?? { count: 0, saving: 0, balance: 0 };
    bucket.count++;
    bucket.saving += journey.monthlySavingCents ?? 0;
    bucket.balance += journey.balanceImpactCents ?? 0;
    byType.set(journey.type, bucket);
  }
  const outcomes = [...byType.entries()].map(([type, bucket]) => ({
    key: JOURNEY_KEY[type] ?? type.toLowerCase(),
    name: JOURNEY_LABEL[type] ?? type,
    meta: filter.range === "all" ? "programme-to-date completed fixes" : `${filter.label.toLowerCase()} completed fixes`,
    count: bucket.count,
    ico: JOURNEY_ICON[type] ?? "shield",
    stat: bucket.saving > 0 ? zarM(bucket.saving) : bucket.balance > 0 ? zarM(bucket.balance) : String(bucket.count),
    statL: bucket.saving > 0 ? "saved / mo" : bucket.balance > 0 ? "in resolution" : "completed",
  }));

  const arrearsDebts = debts.filter((debt: any) => debt.inArrears);
  const arrearsTotal = arrearsDebts.reduce((sum: number, debt: any) => sum + debt.balanceCents, 0);
  const profileMap = new Map<string, number>();
  for (const debt of arrearsDebts) profileMap.set(debt.creditType, (profileMap.get(debt.creditType) ?? 0) + debt.balanceCents);
  const profileTotal = [...profileMap.values()].reduce((sum, value) => sum + value, 0);
  const debtProfile = [...profileMap.entries()].map(([creditType, balance]) => ({
    type: CREDIT_TYPE_LABEL[creditType] ?? creditType,
    balance: zarM(balance),
    pct: profileTotal ? Math.round(balance / profileTotal * 100) : 0,
    col: CREDIT_TYPE_COLOR[creditType] ?? "#8497a7",
  }));

  const creditorMap = new Map<string, { accounts: number; balance: number }>();
  for (const debt of arrearsDebts) {
    const bucket = creditorMap.get(debt.creditorName) ?? { accounts: 0, balance: 0 };
    bucket.accounts++;
    bucket.balance += debt.balanceCents;
    creditorMap.set(debt.creditorName, bucket);
  }
  const palette = ["#e0492f", "#0078c7", "#005e9e", "#1fa463", "#8a4fc4", "#8497a7"];
  const creditors = [...creditorMap.entries()]
    .sort((a, b) => b[1].balance - a[1].balance)
    .map(([name, bucket], index) => ({
      name,
      color: palette[index % palette.length],
      accounts: bucket.accounts,
      balance: zarM(bucket.balance),
      avg: zar(Math.round(bucket.balance / Math.max(1, bucket.accounts))),
      status: "elig",
      statusL: "In journey",
    }));
  const creditorsTotal = { accounts: arrearsDebts.length, balance: zarM(arrearsTotal) };

  const stateAggregate = (state: string) => {
    const rows = debts.filter((debt: any) => debt.state === state);
    return {
      rand: rows.reduce((sum: number, debt: any) => sum + debt.balanceCents, 0),
      employees: new Set(rows.map((debt: any) => debt.platformUserId)).size,
    };
  };
  const active = stateAggregate("ACTIVE_INTERVENTION");
  const challenged = stateAggregate("CHALLENGED");
  const guided = stateAggregate("GUIDED");

  const ratingDistribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const rating of ratings) ratingDistribution[rating.stars] = (ratingDistribution[rating.stars] ?? 0) + 1;
  const ratingResponses = ratings.length;
  const avgRating = ratingResponses ? ratings.reduce((sum: number, rating: any) => sum + rating.stars, 0) / ratingResponses : 0;
  const ratingPct: Record<number, number> = {};
  for (let stars = 1; stars <= 5; stars++) ratingPct[stars] = ratingResponses ? Math.round(ratingDistribution[stars] / ratingResponses * 100) : 0;
  const fiveStarPct = ratingPct[5];

  const challengeRows = debts.filter((debt: any) => debt.challengeStatus);
  const challengeOrder = ["IDENTIFIED", "LETTER_SENT", "CREDITOR_CONCEDED", "WRITTEN_OFF"];
  const stageCount = (stage: string) => challengeRows.filter((debt: any) => challengeOrder.indexOf(debt.challengeStatus) >= challengeOrder.indexOf(stage)).length;
  const challengedBalance = challengeRows.reduce((sum: number, debt: any) => sum + debt.balanceCents, 0);
  const writtenOffBalance = challengeRows.filter((debt: any) => debt.challengeStatus === "WRITTEN_OFF").reduce((sum: number, debt: any) => sum + debt.balanceCents, 0);

  const incomeColors = ["#003a66", "#0078c7", "#4ea3da", "#bfe0f5", "#8497a7"];
  const incomeCounts = new Map<string, number>();
  for (const user of activatedUsers as any[]) {
    const employee = employeeByPlatformUser.get(user.id);
    if (!employee?.incomeBand) continue;
    incomeCounts.set(employee.incomeBand, (incomeCounts.get(employee.incomeBand) ?? 0) + 1);
  }
  const income = [...incomeCounts.entries()].map(([band, count], index) => ({
    value: band,
    name: INCOME_LABEL[band] ?? band,
    count,
    color: incomeColors[index % incomeColors.length],
  }));

  const chatTotal = chats.length;
  const chatResolved = chats.filter((chat: any) => chat.resolvedInChat).length;
  const chatCsatRows = chats.filter((chat: any) => chat.satisfaction != null);
  const chatCsat = chatCsatRows.length ? chatCsatRows.reduce((sum: number, chat: any) => sum + chat.satisfaction, 0) / chatCsatRows.length : 0;
  const replyTimes = chats.filter((chat: any) => chat.firstReplySeconds != null).map((chat: any) => chat.firstReplySeconds).sort((a: number, b: number) => a - b);
  const medianReply = replyTimes.length ? replyTimes[Math.floor((replyTimes.length - 1) / 2)] : 0;
  const chatByType = new Map<string, { convos: number; sentimentTotal: number; sentimentCount: number; themes: Map<string, number> }>();
  const questionCounts = new Map<string, { count: number; journey: string }>();
  const weekCounts = new Map<string, number>();
  for (const chat of chats as any[]) {
    const key = chat.journeyType ?? "GENERAL";
    const bucket = chatByType.get(key) ?? { convos: 0, sentimentTotal: 0, sentimentCount: 0, themes: new Map() };
    bucket.convos++;
    if (chat.sentiment != null) { bucket.sentimentTotal += chat.sentiment; bucket.sentimentCount++; }
    if (chat.theme) bucket.themes.set(chat.theme, (bucket.themes.get(chat.theme) ?? 0) + 1);
    chatByType.set(key, bucket);
    if (chat.primaryQuestion) {
      const question = questionCounts.get(chat.primaryQuestion) ?? { count: 0, journey: JOURNEY_LABEL[key] ?? "General" };
      question.count++;
      questionCounts.set(chat.primaryQuestion, question);
    }
    const week = new Date(chat.startedAt);
    const day = (week.getUTCDay() + 6) % 7;
    week.setUTCDate(week.getUTCDate() - day);
    const keyWeek = week.toISOString().slice(0, 10);
    weekCounts.set(keyWeek, (weekCounts.get(keyWeek) ?? 0) + 1);
  }
  const chatByJourney = [...chatByType.entries()].sort((a, b) => b[1].convos - a[1].convos).map(([key, bucket]) => ({
    key: key.toLowerCase(),
    name: JOURNEY_LABEL[key] ?? "General / account",
    convos: bucket.convos,
    pct: chatTotal ? Math.round(bucket.convos / chatTotal * 100) : 0,
    sentiment: bucket.sentimentCount ? Math.round(((bucket.sentimentTotal / bucket.sentimentCount) + 1) / 2 * 100) : 0,
    themes: [...bucket.themes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([theme, count]) => ({ t: theme, n: count })),
  }));
  const chatTrending = [...questionCounts.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 6).map(([question, value]) => ({ q: question, n: value.count, journey: value.journey, trend: "flat" }));
  const chatVolume = [...weekCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-10).map((entry) => entry[1]);

  const sharers = new Set(referrals.map((referral: any) => referral.platformUserId)).size;
  const completedFlowUsers = new Set(flowCompleted.map((journey: any) => journey.platformUserId)).size;
  const channelCounts = new Map<string, number>();
  for (const referral of referrals as any[]) if (referral.channel) channelCounts.set(referral.channel, (channelCounts.get(referral.channel) ?? 0) + 1);
  const topChannel = [...channelCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—";
  const referral = {
    shares: referrals.length,
    shareRate: completedFlowUsers ? Math.round(sharers / completedFlowUsers * 100) : 0,
    channel: topChannel,
    impliedReach: referrals.length ? `≈ ${(referrals.length * 3).toLocaleString("en-ZA")}` : "—",
  };

  const ewaClients = new Set(advances.map((advance: any) => advance.clientId)).size;
  const ewaTotal = advances.reduce((sum: number, advance: any) => sum + advance.amountCents, 0);
  const ewaByMonth = new Map<string, number>();
  for (const advance of advances as any[]) ewaByMonth.set(monthKey(advance.advancedAt), (ewaByMonth.get(monthKey(advance.advancedAt)) ?? 0) + advance.amountCents);
  const ewaMonths = [...ewaByMonth.keys()].sort().slice(-10);
  const ewa = {
    clients: ewaClients,
    advances: advances.length,
    total: zar(ewaTotal),
    totalRaw: rand(ewaTotal),
    avg: zar(advances.length ? Math.round(ewaTotal / advances.length) : 0),
    avgRaw: advances.length ? rand(Math.round(ewaTotal / advances.length)) : 0,
    perClient: ewaClients ? Number((advances.length / ewaClients).toFixed(1)) : 0,
    trend: ewaMonths.map((key) => Math.round(rand(ewaByMonth.get(key) ?? 0) / 1_000)),
    trendLabels: ewaMonths.map(monthLabel),
  };

  const savingByMonth = new Map<string, number>();
  for (const journey of cumulativeCompleted as any[]) {
    if (!journey.completedAt || !journey.monthlySavingCents) continue;
    const key = monthKey(journey.completedAt);
    savingByMonth.set(key, (savingByMonth.get(key) ?? 0) + journey.monthlySavingCents);
  }
  let cumulative = 0;
  const rangeMonth = filter.rangeStart ? monthKey(filter.rangeStart) : null;
  const savingsPairs = [...savingByMonth.keys()].sort().map((key) => {
    cumulative += savingByMonth.get(key) ?? 0;
    return { key, value: Math.round(rand(cumulative) / 1_000) };
  }).filter((point) => !rangeMonth || point.key >= rangeMonth).slice(-10);
  const savings = savingsPairs.map((point) => point.value);
  const savingsLabels = savingsPairs.map((point) => monthLabel(point.key));

  const regions: any[] = [];
  const stressMap: any[] = [];
  const siteStats: any[] = [];
  const sites = [...new Set(eligibleEmployees.map((employee: any) => employee.site?.name).filter(Boolean))].sort();
  for (const siteName of sites) {
    if (filter.site && filter.site !== siteName) continue;
    const siteEmployees = eligibleEmployees.filter((employee: any) => employee.site?.name === siteName && (!filter.income || employee.incomeBand === filter.income));
    const siteUserIds = new Set(siteEmployees.map((employee: any) => employee.platformUser?.id).filter(Boolean));
    const siteUsers = platformUsers.filter((user: any) => siteUserIds.has(user.id));
    if (!siteEmployees.length) continue;
    const siteDebts = arrearsDebts.filter((debt: any) => siteUserIds.has(debt.platformUserId));
    const siteArrearsUsers = new Set(siteDebts.map((debt: any) => debt.platformUserId)).size;
    const averageDebt = siteDebts.length ? siteDebts.reduce((sum: number, debt: any) => sum + debt.balanceCents, 0) / siteDebts.length : 0;
    const arrearsRate = siteUsers.length ? siteArrearsUsers / siteUsers.length : 0;
    const stress = Math.round(Math.min(100, arrearsRate * 70 + Math.min(30, rand(averageDebt) / 40_000 * 30)));
    const engagement = Math.round(siteUsers.length / siteEmployees.length * 100);
    regions.push({ name: siteName, pct: engagement, stress, indebted: zar(Math.round(averageDebt)) });
    siteStats.push({ name: siteName, stress, engagement, averageDebt });
  }
  regions.sort((a, b) => b.stress - a.stress);
  if (siteStats.length) {
    const byStress = [...siteStats].sort((a, b) => b.stress - a.stress);
    const byEngagement = [...siteStats].sort((a, b) => b.engagement - a.engagement);
    const byDebt = [...siteStats].sort((a, b) => b.averageDebt - a.averageDebt);
    stressMap.push({ l: "Highest stress site", v: byStress[0].name, d: `index ${byStress[0].stress} · avg debt ${zar(Math.round(byStress[0].averageDebt))}`, tone: "red" });
    const lowestStress = byStress[byStress.length - 1];
    stressMap.push({ l: "Lowest stress site", v: lowestStress.name, d: `index ${lowestStress.stress} · most resilient`, tone: "green" });
    stressMap.push({ l: "Most engaged site", v: byEngagement[0].name, d: `${byEngagement[0].engagement}% enrolled`, tone: "blue" });
    stressMap.push({ l: "Most indebted site", v: byDebt[0].name, d: `${zar(Math.round(byDebt[0].averageDebt))} avg unsecured debt`, tone: "amber" });
  }

  const countPolicy = (type: string, unresolvedOnly = false) => policies.filter((policy: any) => policy.type === type && policy.isWasteful && (!unresolvedOnly || !policy.isResolved)).length;
  const duplicateCreditLife = countPolicy("CREDIT_LIFE");
  const duplicateFuneral = countPolicy("FUNERAL");
  const overShortTerm = countPolicy("SHORT_TERM");
  const riskSignals = [
    { sig: "Paying duplicate credit life", n: duplicateCreditLife, sev: "high", note: "insurance on loans they could replace cheaper" },
    { sig: "Excessive / duplicate funeral cover", n: duplicateFuneral, sev: "high", note: "overlapping or over-priced policies" },
    { sig: "Unsecured arrears", n: arrearsUserIds.size, sev: "high", note: "behind on one or more accounts" },
    { sig: "Possible prescribed debt", n: challengeRows.length, sev: "med", note: "old debt that may no longer be owed" },
    { sig: "Over-insured short-term", n: overShortTerm, sev: "low", note: "paying more than cover requires" },
  ].filter((signal) => signal.n > 0);

  const unresolvedPolicies = policies.filter((policy: any) => policy.isWasteful && !policy.isResolved);
  const unresolvedPremium = unresolvedPolicies.reduce((sum: number, policy: any) => sum + policy.premiumCents, 0);
  // Do not apply an assumed savings percentage. This is the directly observed
  // unresolved premium under review; any realised saving comes from journey outcomes.
  const estimatedMonthlyOpportunity = unresolvedPremium;
  const prescribable = debts.filter((debt: any) => ["IDENTIFIED", "LETTER_SENT"].includes(debt.challengeStatus));
  const prescribableBalance = prescribable.reduce((sum: number, debt: any) => sum + debt.balanceCents, 0);
  const opportunities = {
    cards: [
      { name: "Credit life replacement", eligible: countPolicy("CREDIT_LIFE", true), saving: "see audit", icon: "shield" },
      { name: "Funeral consolidation", eligible: countPolicy("FUNERAL", true), saving: "see audit", icon: "umbrella" },
      { name: "Short-term insurance audit", eligible: countPolicy("SHORT_TERM", true), saving: "see audit", icon: "car" },
      { name: "Prescription review", eligible: prescribable.length, saving: "—", extra: `${zarM(prescribableBalance)} challengeable`, icon: "scroll" },
    ].filter((card) => card.eligible > 0),
    estMonthly: zar(estimatedMonthlyOpportunity),
    estAnnual: zarM(estimatedMonthlyOpportunity * 12),
    valueLabel: "Unresolved premium under review",
    valueNote: "Observed premium only; no assumed savings percentage is applied.",
  };

  let priorScore: number | null = null;
  if (!filter.site && !filter.income) {
    const periodKey = filter.period ?? currentPeriod();
    const prior = await prisma.scoreSnapshot.findFirst({
      where: { employerId, period: { lt: periodKey }, payloadVersion: { gte: 3 } },
      orderBy: { period: "desc" },
    });
    priorScore = prior?.optimiseScore ?? null;
  }

  const sectionAvailability = {
    workforce: headcountDataAvailable,
    enrolment: headcountDataAvailable && feedCoverage.platform_users.available,
    journeys: feedCoverage.platform_users.available && feedCoverage.journeys.available,
    debt: feedCoverage.platform_users.available && feedCoverage.debt_accounts.available,
    insurance: feedCoverage.platform_users.available && feedCoverage.policies.available,
    ratings: feedCoverage.ratings.available,
    referrals: feedCoverage.referrals.available,
    ewa: feedCoverage.salary_advances.available,
  };
  const kpiAvailability = {
    takeUp: sectionAvailability.enrolment,
    activated: sectionAvailability.enrolment,
    monthlySaving: sectionAvailability.journeys,
    avgRating: sectionAvailability.ratings,
  };

  const missingFeeds = CORE_FEEDS.filter((feed) => !feedCoverage[feed].available);
  const loadedFeedCount = CORE_FEEDS.length - missingFeeds.length;
  const scoreDriverLabels: Record<keyof DriverAvailability, string> = {
    engagement: "Engagement",
    cashflow: "Cashflow relief",
    debtRisk: "Debt risk",
    insurance: "Insurance efficiency",
  };
  const missingScoreDrivers = score.missingDrivers.map((driver) => scoreDriverLabels[driver]);

  const warnings: string[] = [];
  if (missingFeeds.length) {
    warnings.push(`Integration incomplete: ${loadedFeedCount} of ${CORE_FEEDS.length} core datasets are available. Missing: ${missingFeeds.map((feed) => CORE_FEED_LABELS[feed]).join(", ")}.`);
  }
  if (!score.complete) {
    warnings.push(`The Workforce Financial Wellness Score is unavailable until the required data is present for: ${missingScoreDrivers.join(", ")}.`);
  }
  if (!headcountSnapshot && !filter.site && !filter.income && (feedCoverage.workforce_snapshots.available || feedCoverage.employees.available)) warnings.push("No workforce headcount snapshot existed at the selected as-of date; the employee effective-date count/current cache was used.");
  if (headcountSnapshot && !filter.site && !filter.income && headcountSnapshot.eligibleCount !== eligibleEmployees.length) {
    warnings.push(`The workforce snapshot denominator (${headcountSnapshot.eligibleCount}) does not match the dated employee detail (${eligibleEmployees.length}) at the selected as-of date; cohort and join coverage should be reconciled.`);
  }
  if (workforceState.usedFallback) warnings.push("Some employees used the current workforce projection because no dated workforce observations were available; historical site/income cohorts should be backfilled.");
  if (workforceState.missingAsAtCount > 0) warnings.push(`${workforceState.missingAsAtCount} employee record(s) had dated workforce history but no valid observation at or before the selected as-of date.`);
  if (eligibleEmployees.some((employee: any) => !employee.eligibleFrom)) warnings.push("Some legacy employee records have no eligible_from date; historical workforce cohorts may be incomplete until they are backfilled.");
  if (debtState.usedFallback) warnings.push("Some debt accounts used the current projection because no immutable observation history was available.");
  if (policyState.usedFallback) warnings.push("Some policies used the current projection because no immutable observation history was available.");
  if ((filter.site || filter.income) && (!employeeIds.length || headcount === 0)) warnings.push("The selected cohort has no eligible employees at the as-of date.");

  const sourceDataUpdatedAt = maxDate([
    employer.sourceUpdatedAt,
    headcountSnapshot?.sourceUpdatedAt,
    ...cohortEmployees.map((employee: any) => employee.sourceUpdatedAt),
    ...platformUsers.map((user: any) => user.sourceUpdatedAt),
    ...liveJourneys.map((journey: any) => journey.sourceUpdatedAt),
    ...debts.map((debt: any) => debt.sourceUpdatedAt),
    ...policies.map((policy: any) => policy.sourceUpdatedAt),
    ...ratings.map((rating: any) => rating.sourceUpdatedAt),
    ...chats.map((chat: any) => chat.sourceUpdatedAt),
    ...referrals.map((referral: any) => referral.sourceUpdatedAt),
    ...advances.map((advance: any) => advance.sourceUpdatedAt),
  ]);
  const averagePerActive = activated ? Math.round(cumulativeMonthlySaving / activated) : 0;
  const arrearsRate = sectionAvailability.debt && debtVisibleUserIds.size
    ? Math.round(arrearsUserIds.size / debtVisibleUserIds.size * 100)
    : null;
  const averageArrearsAccount = arrearsDebts.length ? arrearsTotal / arrearsDebts.length : 0;
  const stressIndex = arrearsRate == null
    ? null
    : Math.round(Math.min(100, (arrearsRate / 100) * 70 + Math.min(30, rand(averageArrearsAccount) / 40_000 * 30)));

  return {
    employer: employer.name,
    headcount,
    dataAsOf: filter.asAt.toISOString(),
    sourceDataUpdatedAt: sourceDataUpdatedAt?.toISOString() ?? null,
    filterContext: {
      period: filter.period,
      range: filter.range,
      label: filter.label,
      rangeStart: filter.rangeStart?.toISOString() ?? null,
      rangeEnd: filter.rangeEnd.toISOString(),
      asAt: filter.asAt.toISOString(),
      site: filter.site,
      income: filter.income,
      incomeLabel: filter.income ? INCOME_LABEL[filter.income] : null,
      semantics: {
        stock: "Headcount, funnel, wellness, debt and insurance are measured as at the range end.",
        flow: "Outcomes, ratings, chat, referrals and wage advances are measured inside the selected range.",
      },
    },
    filterOptions: {
      sites: sites.map((site) => ({ value: site, label: site })),
      incomes: INCOME_VALUES.map((value) => ({ value, label: INCOME_LABEL[value] })),
    },
    dataQuality: {
      warnings,
      loadedFeedCount,
      coreFeedCount: CORE_FEEDS.length,
      missingFeeds: missingFeeds.map((feed) => ({ key: feed, label: CORE_FEED_LABELS[feed] })),
      feedCoverage,
      scoreReady: score.complete,
      missingScoreDrivers,
      headcountSource: filter.site || filter.income ? "effective employee rows" : headcountSnapshot ? `snapshot ${headcountSnapshot.asOfDate.toISOString().slice(0, 10)}` : eligibleEmployees.length ? "effective employee rows" : "employer current cache",
      workforceObservationRows: workforceState.versionCount,
      workforceProjectionFallback: workforceState.usedFallback,
      workforceMissingAtAsOf: workforceState.missingAsAtCount,
      debtObservationRows: debtState.versionCount,
      policyObservationRows: policyState.versionCount,
    },
    availability: sectionAvailability,
    portfolio: {
      takeUp: sectionAvailability.enrolment ? pct(enrolled) : null,
      engaged: sectionAvailability.enrolment ? pct(activated) : null,
      wellness: score.optimiseScore,
      saving: sectionAvailability.journeys ? rand(cumulativeMonthlySaving) : null,
      betterOff: sectionAvailability.journeys ? completedFix : null,
      oppValue: sectionAvailability.insurance ? rand(estimatedMonthlyOpportunity) : null,
      stress: stressIndex,
      arrears: arrearsRate,
      rating: sectionAvailability.ratings ? Number(avgRating.toFixed(1)) : null,
      fiveStarPct: sectionAvailability.ratings ? fiveStarPct : null,
    },
    exec: { items: [
      { v: sectionAvailability.enrolment ? enrolled.toLocaleString("en-ZA") : "—", l: "employees enrolled", available: sectionAvailability.enrolment },
      { v: sectionAvailability.journeys ? zar(cumulativeMonthlySaving) : "—", l: "monthly cashflow restored", available: sectionAvailability.journeys },
      { v: sectionAvailability.debt ? zarM(active.rand) : "—", l: "debt under active intervention", available: sectionAvailability.debt },
      { v: sectionAvailability.debt ? String(challengeRows.length) : "—", l: "prescribed debts challenged", available: sectionAvailability.debt },
      { v: sectionAvailability.journeys ? completedFix.toLocaleString("en-ZA") : "—", l: "employees better off", available: sectionAvailability.journeys },
      { v: sectionAvailability.ratings ? `${avgRating.toFixed(1)}/5` : "—", l: "employee satisfaction", available: sectionAvailability.ratings },
    ] },
    wellness: {
      score: score.optimiseScore,
      prior: priorScore,
      band: wellnessBand(score.optimiseScore),
      complete: score.complete,
      missingDrivers: missingScoreDrivers,
      drivers: [
        { name: "Engagement", score: score.sub.engagement, available: score.sub.engagement != null, weight: weights.ENGAGEMENT, note: "started a journey vs. eligible" },
        { name: "Cashflow relief", score: score.sub.cashflow, available: score.sub.cashflow != null, weight: weights.CASHFLOW, note: "savings unlocked vs. potential" },
        { name: "Debt risk", score: score.sub.debtRisk, available: score.sub.debtRisk != null, weight: weights.DEBT_RISK, note: "users in arrears (lower = riskier)" },
        { name: "Insurance efficiency", score: score.sub.insurance, available: score.sub.insurance != null, weight: weights.INSURANCE, note: "wasteful cover resolved" },
      ],
    },
    debtStates: {
      available: sectionAvailability.debt,
      active: { rand: rand(active.rand), employees: active.employees, label: "Under active intervention", note: "settlement or reduced-instalment arrangements sent" },
      challenged: { rand: rand(challenged.rand), employees: challenged.employees, label: "Being challenged", note: "potentially prescribed debt contested" },
      guided: { rand: rand(guided.rand), employees: guided.employees, label: "Self-managed via guidance", note: "educated on prescription where no arrangement was affordable" },
    },
    kpis: {
      takeUp: { pct: kpiAvailability.takeUp ? pct(enrolled) : null, enrolled: kpiAvailability.takeUp ? enrolled : null, available: kpiAvailability.takeUp },
      activated: { pct: kpiAvailability.activated ? pct(activated) : null, count: kpiAvailability.activated ? activated : null, available: kpiAvailability.activated },
      monthlySaving: { rand: kpiAvailability.monthlySaving ? rand(cumulativeMonthlySaving) : null, perHead: kpiAvailability.monthlySaving ? rand(averagePerActive) : null, available: kpiAvailability.monthlySaving },
      avgRating: { val: kpiAvailability.avgRating ? Number(avgRating.toFixed(1)) : null, responses: kpiAvailability.avgRating ? ratingResponses : null, available: kpiAvailability.avgRating },
    },
    funnel: [
      { label: "Eligible workforce", sub: "as at range end", n: headcountDataAvailable ? headcount : null, pct: headcountDataAvailable ? 100 : null, available: headcountDataAvailable },
      { label: "Enrolled", sub: "joined by range end", n: sectionAvailability.enrolment ? enrolled : null, pct: sectionAvailability.enrolment ? pct(enrolled) : null, available: sectionAvailability.enrolment },
      { label: "Activated", sub: "started a fix by range end", n: sectionAvailability.enrolment ? activated : null, pct: sectionAvailability.enrolment ? pct(activated) : null, available: sectionAvailability.enrolment },
      { label: "Completed a fix", sub: "at least one resolved by range end", n: sectionAvailability.journeys ? completedFix : null, pct: sectionAvailability.journeys ? pct(completedFix) : null, available: sectionAvailability.journeys },
      { label: "Multiple fixes", sub: "two or more resolved by range end", n: sectionAvailability.journeys ? multipleFix : null, pct: sectionAvailability.journeys ? pct(multipleFix) : null, available: sectionAvailability.journeys },
    ],
    outcomes,
    valueStrip: [
      { l: "Monthly cash freed up", v: sectionAvailability.journeys ? zar(cumulativeMonthlySaving) : "—", d: sectionAvailability.journeys ? `${zarM(cumulativeMonthlySaving * 12)} annualised` : "Journey data not loaded", available: sectionAvailability.journeys },
      { l: "New monthly savings in range", v: sectionAvailability.journeys ? zar(flowMonthlySaving) : "—", d: sectionAvailability.journeys ? filter.label : "Journey data not loaded", available: sectionAvailability.journeys },
      { l: "Prescribed debt challenged", v: sectionAvailability.debt ? zarM(challengedBalance) : "—", d: sectionAvailability.debt ? `${challengeRows.length} accounts as at end` : "Debt data not loaded", available: sectionAvailability.debt },
      { l: "Arrears under active intervention", v: sectionAvailability.debt ? zarM(active.rand) : "—", d: sectionAvailability.debt ? `${active.employees} employees as at end` : "Debt data not loaded", available: sectionAvailability.debt },
    ],
    debtProfile,
    creditors,
    creditorsTotal,
    income,
    savings,
    savingsLabels,
    stressMap,
    regions,
    referral: { ...referral, available: sectionAvailability.referrals },
    ewa: { ...ewa, available: sectionAvailability.ewa },
    riskSignals,
    opportunities,
    ratings: { avg: sectionAvailability.ratings ? Number(avgRating.toFixed(1)) : null, dist: ratingPct, fiveStarPct: sectionAvailability.ratings ? fiveStarPct : null, responses: sectionAvailability.ratings ? ratingResponses : null, available: sectionAvailability.ratings },
    prescription: {
      available: sectionAvailability.debt,
      total: zarM(challengedBalance),
      accounts: challengeRows.length,
      avgPerAccount: challengeRows.length ? zar(Math.round(challengedBalance / challengeRows.length)) : "R 0",
      statusBars: [
        { l: "Identified", n: stageCount("IDENTIFIED"), pct: challengeRows.length ? 100 : 0, c: "#bfe0f5" },
        { l: "Letter dispatched", n: stageCount("LETTER_SENT"), pct: challengeRows.length ? Math.round(stageCount("LETTER_SENT") / challengeRows.length * 100) : 0, c: "#4ea3da" },
        { l: "Creditor conceded", n: stageCount("CREDITOR_CONCEDED"), pct: challengeRows.length ? Math.round(stageCount("CREDITOR_CONCEDED") / challengeRows.length * 100) : 0, c: "#0078c7" },
        { l: "Written off", n: stageCount("WRITTEN_OFF"), pct: challengeRows.length ? Math.round(stageCount("WRITTEN_OFF") / challengeRows.length * 100) : 0, c: "#1fa463" },
      ],
      writtenOff: zarM(writtenOffBalance),
    },
    chat: {
      // Chat is supplied by a separate integration, not the 10 core source feeds.
      // Until that source has supplied records, the UI must show it as unavailable
      // rather than presenting confirmed zeroes.
      available: (chatsAll as any[]).length > 0,
      conversations: chatTotal,
      resolvedInChat: chatTotal ? Math.round(chatResolved / chatTotal * 100) : 0,
      escalated: chatTotal ? Math.round((chatTotal - chatResolved) / chatTotal * 100) : 0,
      avgFirstReply: `${medianReply}s`,
      csat: Number(chatCsat.toFixed(1)),
      byJourney: chatByJourney,
      trending: chatTrending,
      volume: chatVolume,
    },
    monthActivity: {
      label: filter.label,
      enrolled: sectionAvailability.enrolment ? platformUsers.filter((user: any) => inWindow(user.enrolledAt, filter)).length : null,
      completed: sectionAvailability.journeys ? flowCompleted.length : null,
      savingUnlocked: sectionAvailability.journeys ? zar(flowMonthlySaving) : null,
      advancesCount: sectionAvailability.ewa ? advances.length : null,
      advancesTotal: sectionAvailability.ewa ? zar(ewaTotal) : null,
    },
  };
}

export async function getDashboardPayload(employerId: string, query: DashboardQuery = {}) {
  return buildDashboardPayload(employerId, query);
}

async function persistScoreSnapshot(employerId: string, period: string, payload: any): Promise<boolean> {
  if (!payload?.wellness?.complete || payload?.wellness?.score == null) return false;
  const weights: Weights = {
    ENGAGEMENT: payload.wellness.drivers[0].weight,
    CASHFLOW: payload.wellness.drivers[1].weight,
    DEBT_RISK: payload.wellness.drivers[2].weight,
    INSURANCE: payload.wellness.drivers[3].weight,
  };
  const sub = {
    engagement: payload.wellness.drivers[0].score,
    cashflow: payload.wellness.drivers[1].score,
    debtRisk: payload.wellness.drivers[2].score,
    insurance: payload.wellness.drivers[3].score,
  };
  const rawScore = Number((
    sub.engagement * weights.ENGAGEMENT
    + sub.cashflow * weights.CASHFLOW
    + sub.debtRisk * weights.DEBT_RISK
    + sub.insurance * weights.INSURANCE
  ).toFixed(2));
  const rangeStart = new Date(payload.filterContext.rangeStart ?? startOfMonth(period));
  const rangeEnd = new Date(payload.filterContext.rangeEnd ?? endOfMonth(period));
  const asAt = new Date(payload.filterContext.asAt ?? rangeEnd);
  const snapshotData = {
    rangeStart,
    rangeEnd,
    asAt,
    payloadVersion: 3,
    optimiseScore: payload.wellness.score,
    rawScore,
    engagementScore: sub.engagement,
    cashflowScore: sub.cashflow,
    debtRiskScore: sub.debtRisk,
    insuranceScore: sub.insurance,
    engagementWeight: weights.ENGAGEMENT,
    cashflowWeight: weights.CASHFLOW,
    debtRiskWeight: weights.DEBT_RISK,
    insuranceWeight: weights.INSURANCE,
    payload,
  };
  await prisma.scoreSnapshot.upsert({
    where: { employerId_period: { employerId, period } },
    create: { employerId, period, ...snapshotData },
    update: { ...snapshotData, computedAt: new Date() },
  });
  return true;
}

export async function snapshotEmployer(employerId: string, period: string = currentPeriod()) {
  if (!isValidPeriod(period) || period > currentPeriod()) throw new Error(`invalid or future period: ${period}`);
  const payload: any = await buildDashboardPayload(employerId, { period });
  const persisted = await persistScoreSnapshot(employerId, period, payload);
  if (persisted) await buildMonthlySnapshots(employerId, currentPeriod());
  return { ok: true, persisted, period, asAt: payload.filterContext.asAt, scoreReady: payload.wellness.complete };
}

async function monthsWithData(employerId: string): Promise<string[]> {
  const employees: any[] = await prisma.employee.findMany({ where: { employerId }, select: { id: true, platformUser: { select: { id: true } } } });
  const employeeIds = employees.map((employee: any) => employee.id);
  const platformUserIds = employees.map((employee: any) => employee.platformUser?.id).filter((id: string | undefined): id is string => !!id);
  const [workforceVersions, users, journeys, ratings, chats, referrals, advances, headcounts, debtVersions, policyVersions] = await Promise.all([
    employeeIds.length ? prisma.employeeVersion.findMany({ where: { employeeId: { in: employeeIds } }, select: { observedAt: true, eligibleFrom: true, eligibleTo: true } }) : [],
    platformUserIds.length ? prisma.platformUser.findMany({ where: { id: { in: platformUserIds } }, select: { enrolledAt: true, activatedAt: true } }) : [],
    platformUserIds.length ? prisma.journey.findMany({ where: { platformUserId: { in: platformUserIds } }, select: { startedAt: true, completedAt: true } }) : [],
    platformUserIds.length ? prisma.rating.findMany({ where: { platformUserId: { in: platformUserIds } }, select: { createdAt: true } }) : [],
    employeeIds.length ? prisma.chatSession.findMany({ where: { employerId, employeeId: { in: employeeIds } }, select: { startedAt: true } }) : [],
    platformUserIds.length ? prisma.referral.findMany({ where: { platformUserId: { in: platformUserIds } }, select: { sharedAt: true, convertedAt: true } }) : [],
    employeeIds.length ? prisma.salaryAdvance.findMany({ where: { employerId, employeeId: { in: employeeIds } }, select: { advancedAt: true } }) : [],
    prisma.employerHeadcountSnapshot.findMany({ where: { employerId }, select: { asOfDate: true } }),
    platformUserIds.length ? prisma.debtAccountVersion.findMany({ where: { account: { platformUserId: { in: platformUserIds } } }, select: { observedAt: true } }) : [],
    platformUserIds.length ? prisma.insurancePolicyVersion.findMany({ where: { policy: { platformUserId: { in: platformUserIds } } }, select: { observedAt: true } }) : [],
  ]);
  const months = new Set<string>();
  const add = (date: Date | null | undefined) => { if (date) months.add(monthKey(date)); };
  for (const workforce of workforceVersions as any[]) { add(workforce.observedAt); add(workforce.eligibleFrom); add(workforce.eligibleTo); }
  for (const user of users as any[]) { add(user.enrolledAt); add(user.activatedAt); }
  for (const journey of journeys as any[]) { add(journey.startedAt); add(journey.completedAt); }
  for (const rating of ratings as any[]) add(rating.createdAt);
  for (const chat of chats as any[]) add(chat.startedAt);
  for (const referral of referrals as any[]) { add(referral.sharedAt); add(referral.convertedAt); }
  for (const advance of advances as any[]) add(advance.advancedAt);
  for (const headcount of headcounts as any[]) add(headcount.asOfDate);
  for (const debt of debtVersions as any[]) add(debt.observedAt);
  for (const policy of policyVersions as any[]) add(policy.observedAt);
  return [...months].sort();
}

export async function buildMonthlySnapshots(employerId: string, currentP: string = currentPeriod()) {
  const months = await monthsWithData(employerId);
  for (const period of months) {
    if (period >= currentP) continue;
    const payload: any = await buildDashboardPayload(employerId, { period });
    await persistScoreSnapshot(employerId, period, payload);
  }
}

export { prisma };
