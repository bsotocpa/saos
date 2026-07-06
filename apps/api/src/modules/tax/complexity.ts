// Complexity score (MP Tax Operations): pure, table-driven, unit-tested.
//   Base 1 | Sch C +1 each | Sch E +0.5/property | K-1 +0.5 each |
//   multi-state +0.5/additional state | foreign +1 | depreciation +0.5 |
//   late docs +0.5 | cleanup +1 | IRS notice +1. Cap L5.
// Interpretation notes: "multi-state +0.5/state" counts states BEYOND the
// first (one state is included in every base price); Sch C is per schedule.

export interface ComplexityInputs {
  schC?: number | undefined;
  schEProperties?: number | undefined;
  k1s?: number | undefined;
  /** Total states filed, including the first/home state. */
  states?: number | undefined;
  foreign?: boolean | undefined;
  depreciation?: boolean | undefined;
  lateDocs?: boolean | undefined;
  priorYearCleanup?: boolean | undefined;
  irsNotice?: boolean | undefined;
}

export function computeComplexityScore(inputs: ComplexityInputs): number {
  let score = 1;
  score += (inputs.schC ?? 0) * 1;
  score += (inputs.schEProperties ?? 0) * 0.5;
  score += (inputs.k1s ?? 0) * 0.5;
  score += Math.max(0, (inputs.states ?? 1) - 1) * 0.5;
  if (inputs.foreign) score += 1;
  if (inputs.depreciation) score += 0.5;
  if (inputs.lateDocs) score += 0.5;
  if (inputs.priorYearCleanup) score += 1;
  if (inputs.irsNotice) score += 1;
  return Math.min(5, Math.round(score * 10) / 10);
}
