// ════════════════════════════════════════════════════════════════════
//  FINANCIAL WELLNESS SCORE ENGINE
//
//  A score is only reportable when the source data needed for every
//  weighted driver is available. Missing feeds are represented as null,
//  never as a synthetic zero or perfect score.
// ════════════════════════════════════════════════════════════════════

export type Driver = "ENGAGEMENT" | "CASHFLOW" | "DEBT_RISK" | "INSURANCE";

export interface ScoreInputs {
  // engagement
  usersStartedJourney: number;
  eligibleEmployees: number;
  // cashflow (rands; cents internally but ratio is unit-free)
  savingsUnlocked: number;
  savingsAchievable: number;
  // debt risk — denominator is the population with credit-profile visibility
  platformUsersInArrears: number;
  platformUsers: number;
  // insurance
  wastefulCoverFixed: number;
  wastefulCoverFound: number;
  policiesObserved?: number;
}

export interface Weights {
  ENGAGEMENT: number;
  CASHFLOW: number;
  DEBT_RISK: number;
  INSURANCE: number;
}

export const DEFAULT_WEIGHTS: Weights = {
  ENGAGEMENT: 0.2,
  CASHFLOW: 0.3,
  DEBT_RISK: 0.3,
  INSURANCE: 0.2,
};

const clamp = (n: number) => Math.max(0, Math.min(100, n));
const ratio = (num: number, den: number) => (den <= 0 ? 0 : (num / den) * 100);

export interface NumericSubScores {
  engagement: number;
  cashflow: number;
  debtRisk: number;
  insurance: number;
}

export interface SubScores {
  engagement: number | null;
  cashflow: number | null;
  debtRisk: number | null;
  insurance: number | null;
}

export interface DriverAvailability {
  engagement: boolean;
  cashflow: boolean;
  debtRisk: boolean;
  insurance: boolean;
}

const ALL_AVAILABLE: DriverAvailability = {
  engagement: true,
  cashflow: true,
  debtRisk: true,
  insurance: true,
};

export function computeSubScores(i: ScoreInputs): NumericSubScores {
  const insurance = i.wastefulCoverFound <= 0 && (i.policiesObserved ?? 0) > 0
    ? 100
    : ratio(i.wastefulCoverFixed, i.wastefulCoverFound);

  return {
    engagement: Math.round(clamp(ratio(i.usersStartedJourney, i.eligibleEmployees))),
    cashflow: Math.round(clamp(ratio(i.savingsUnlocked, i.savingsAchievable))),
    debtRisk: Math.round(
      clamp(
        i.platformUsers <= 0
          ? 0
          : 100 - (i.platformUsersInArrears / i.platformUsers) * 100,
      ),
    ),
    insurance: Math.round(clamp(insurance)),
  };
}

export interface ScoreResult {
  optimiseScore: number | null;
  rawScore: number | null;
  sub: SubScores;
  weights: Weights;
  complete: boolean;
  missingDrivers: Array<keyof DriverAvailability>;
}

export function computeOptimiseScore(
  inputs: ScoreInputs,
  weights: Weights = DEFAULT_WEIGHTS,
  availability: DriverAvailability = ALL_AVAILABLE,
): ScoreResult {
  const sum = weights.ENGAGEMENT + weights.CASHFLOW + weights.DEBT_RISK + weights.INSURANCE;
  if (Math.abs(sum - 1) > 1e-6) {
    throw new Error(`Score weights must sum to 1.0, got ${sum}`);
  }

  const numeric = computeSubScores(inputs);
  const sub: SubScores = {
    engagement: availability.engagement ? numeric.engagement : null,
    cashflow: availability.cashflow ? numeric.cashflow : null,
    debtRisk: availability.debtRisk ? numeric.debtRisk : null,
    insurance: availability.insurance ? numeric.insurance : null,
  };

  const missingDrivers = (Object.keys(availability) as Array<keyof DriverAvailability>)
    .filter((key) => !availability[key]);
  const complete = missingDrivers.length === 0;

  if (!complete) {
    return {
      optimiseScore: null,
      rawScore: null,
      sub,
      weights,
      complete,
      missingDrivers,
    };
  }

  const raw =
    (sub.engagement as number) * weights.ENGAGEMENT +
    (sub.cashflow as number) * weights.CASHFLOW +
    (sub.debtRisk as number) * weights.DEBT_RISK +
    (sub.insurance as number) * weights.INSURANCE;

  return {
    optimiseScore: Math.round(raw),
    rawScore: Number(raw.toFixed(2)),
    sub,
    weights,
    complete,
    missingDrivers,
  };
}
