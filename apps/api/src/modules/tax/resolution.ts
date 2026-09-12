// M26.5 (v4.6): the tax resolution lane — multi-year non-filer work.
//
// Everything here DERIVES from the tax year and the authoritative deadline
// table. Staff never choose a filing method, and no date or dollar figure is
// hardcoded at a call site.
//
//   filingLane      current + 2 prior → e-file/KBA;  older → PAPER
//   refundStatute   3 years from the ORIGINAL due date (then it's forfeited)
//   lookback        the 6-year non-filer norm, oldest year first
//   surcharge       prior-year surcharge applies on the same >2-years boundary
//                   (rate from the price book — never a literal here)

import type { FastifyInstance } from 'fastify';
import { addDays, originalDeadline, rollToBusinessDay, todayChicago, type DeadlineReturnType, calendarDay } from './deadlines.ts';

/** E-file is available for the current tax year and the two before it. */
export const EFILE_YEAR_SPAN = 2;
/** The non-filer norm Brian works to (DECIDED): six years including current. */
export const LOOKBACK_YEARS = 6;

export type FilingLane = 'efile' | 'paper';

/**
 * The tax year currently being prepared: through the filing season the
 * "current" year is last calendar year, and it rolls over once that year's
 * returns are done. Derived from the date, never stored.
 */
export function currentTaxYear(today: string = todayChicago()): number {
  return Number(today.slice(0, 4)) - 1;
}

/**
 * THE HARD RULE (CLAUDE.md): current + 2 prior years go through e-file; anything
 * older is PAPER — certified mail. Every 8879, either lane, is wet-signed in office
 * and uploaded to the return (2026-09-12). The system derives the lane from the
 * year; staff never pick.
 */
export function filingLane(taxYear: number, today: string = todayChicago()): FilingLane {
  return currentTaxYear(today) - taxYear <= EFILE_YEAR_SPAN ? 'efile' : 'paper';
}

/** True when the prior-year surcharge applies (same >2-years-back boundary). */
export function surchargeApplies(taxYear: number, today: string = todayChicago()): boolean {
  return currentTaxYear(today) - taxYear > EFILE_YEAR_SPAN;
}

/**
 * Refund-statute expiry: a refund is forfeited three years after the return's
 * ORIGINAL due date. This is the clock that sells the work and serves the
 * client — surfaced on the deadline dashboard AND in their own portal.
 */
export function refundStatuteExpiry(
  returnType: DeadlineReturnType,
  taxYear: number,
  fiscalYearEndMonth = 12
): string | null {
  const original = originalDeadline(returnType, taxYear, fiscalYearEndMonth);
  if (!original) return null;
  const [y, rest] = [Number(original.slice(0, 4)), original.slice(4)];
  return rollToBusinessDay(`${y + 3}${rest}`);
}

/** Is a refund still claimable for this year as of `today`? */
export function refundStillClaimable(
  returnType: DeadlineReturnType,
  taxYear: number,
  today: string = todayChicago(),
  fiscalYearEndMonth = 12
): boolean {
  const expiry = refundStatuteExpiry(returnType, taxYear, fiscalYearEndMonth);
  return expiry !== null && calendarDay(today) <= calendarDay(expiry, 'refund statute expiry');
}

/** The 6-year lookback window, OLDEST FIRST (the order work is chained in). */
export function lookbackYears(today: string = todayChicago(), years = LOOKBACK_YEARS): number[] {
  const current = currentTaxYear(today);
  return Array.from({ length: years }, (_, i) => current - (years - 1) + i);
}

/** Plain-language statute note for the quote and the portal (EN/ES). */
export function statuteNote(
  returnType: DeadlineReturnType,
  taxYear: number,
  language: 'en' | 'es' = 'en',
  today: string = todayChicago()
): string | null {
  const expiry = refundStatuteExpiry(returnType, taxYear);
  if (!expiry) return null;
  if (calendarDay(today) > calendarDay(expiry, 'refund statute expiry')) {
    return language === 'es'
      ? `El plazo para reclamar un reembolso de ${taxYear} venció el ${expiry}. Aún hay que presentarla, pero ya no se puede recibir reembolso de ese año.`
      : `The window to claim a ${taxYear} refund closed on ${expiry}. The return still needs filing, but a refund for that year is no longer available.`;
  }
  return language === 'es'
    ? `Presentar ${taxYear} antes del ${expiry} conserva cualquier reembolso de ese año.`
    : `Filing ${taxYear} by ${expiry} preserves any refund for that year.`;
}

/** Certified-mail tracking is required on the paper lane, not optional. */
export const PAPER_LANE_CHECKLIST = [
  'Print the full return packet (client + preparer copies)',
  'Wet-signature 8879 / signature page collected and scanned to Signed Authorizations',
  'Mail via USPS certified with return receipt',
  'Record the certified tracking number and the mailed date',
  'File the mailing receipt to the client record',
];

export interface ResolutionYearPlan {
  taxYear: number;
  returnType: DeadlineReturnType;
  lane: FilingLane;
  originalDeadline: string | null;
  refundStatuteExpiry: string | null;
  refundClaimable: boolean;
  surcharge: boolean;
  booksExist: 'yes' | 'partial' | 'no';
  needsReconstruction: boolean;
}

/**
 * The whole plan for a resolution client, oldest year first. Pure derivation —
 * every field comes from the year + the table, so the same inputs always
 * produce the same plan.
 */
export function planResolution(
  input: {
    years: Array<{ taxYear: number; returnType: DeadlineReturnType; booksExist?: 'yes' | 'partial' | 'no' | undefined }>;
    fiscalYearEndMonth?: number;
  },
  today: string = todayChicago()
): ResolutionYearPlan[] {
  const fye = input.fiscalYearEndMonth ?? 12;
  return [...input.years]
    .sort((a, b) => a.taxYear - b.taxYear) // OLDEST FIRST — carryforwards flow forward
    .map((y) => {
      const booksExist = y.booksExist ?? 'yes';
      return {
        taxYear: y.taxYear,
        returnType: y.returnType,
        lane: filingLane(y.taxYear, today),
        originalDeadline: originalDeadline(y.returnType, y.taxYear, fye),
        refundStatuteExpiry: refundStatuteExpiry(y.returnType, y.taxYear, fye),
        refundClaimable: refundStillClaimable(y.returnType, y.taxYear, today, fye),
        surcharge: surchargeApplies(y.taxYear, today),
        booksExist,
        // Partial or missing books pair a reconstruction engagement (v4.6).
        needsReconstruction: booksExist !== 'yes',
      };
    });
}

/**
 * SFR (Substitute For Return) risk: the IRS filed for the client. Recorded
 * from transcripts, not guessed — this only reads the flag staff set.
 */
export async function sfrFlaggedYears(app: FastifyInstance, contactId: string): Promise<number[]> {
  const { rows } = await app.db.query<{ tax_year: number }>(
    `SELECT te.tax_year
     FROM tax_engagements te
     JOIN engagements e ON e.id = te.engagement_id
     WHERE e.contact_id = $1 AND te.sfr_risk
     ORDER BY te.tax_year`,
    [contactId]
  );
  return rows.map((r) => r.tax_year);
}

/** Perfection-style helper for the paper lane: expected delivery window. */
export function certifiedMailFollowUp(mailedOn: string): string {
  return addDays(mailedOn, 21); // check tracking / IRS receipt by then
}
