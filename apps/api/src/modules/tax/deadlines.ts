// Deadline derivation (MP Tax Ops + CLAUDE.md hard rule): extended deadlines
// DERIVE from return type + fiscal year end — never a hardcoded date swap.
//
// Model: statutory due date = 15th day of the Nth month after fiscal year
// end; extension = original + 6 months. For calendar-year filers this yields
// exactly the spec's table (1065/1120-S → Mar 15 → Sep 15 · 1040/1120 →
// Apr 15 → Oct 15 · 990 → May 15 → Nov 15), and fiscal-year filers get their
// +6-months offsets for free.
//
// Conventions & known simplifications (documented, revisit with Brian):
//  - tax_year = the calendar year in which the fiscal year ENDS.
//  - Weekend/holiday observance is NOT modeled (statutory 15ths only) — the
//    dashboard countdown is at worst a day or two conservative, never late.
//  - The June-30-FYE C-corp special rule and 1120-F no-US-office rule are not
//    modeled; 1120-C uses the general corporate month (housing co-ops are not
//    §6072(d) farm co-ops).

export type DeadlineReturnType =
  | '1040' | '1065' | '1120s' | '1120' | '990' | '990ez'
  | '1120c' | '1120f' | '1120h' | '1120pol' | 'w7_itin';

/** 15th day of the Nth month after fiscal year end, per return type. */
const MONTHS_AFTER_YEAR_END: Record<DeadlineReturnType, number | null> = {
  '1040': 4,      // Apr 15 for calendar year
  '1065': 3,      // Mar 15
  '1120s': 3,     // Mar 15
  '1120': 4,      // Apr 15
  '990': 5,       // May 15
  '990ez': 5,     // May 15
  '1120c': 4,
  '1120f': 4,
  '1120h': 4,
  '1120pol': 4,
  w7_itin: null,  // filed with the return — no standalone deadline
};

const EXTENSION_MONTHS = 6;

function fifteenthOf(year: number, monthOffsetFromJan1: number): string {
  // monthOffsetFromJan1 may exceed 12 — roll into subsequent years.
  const y = year + Math.floor((monthOffsetFromJan1 - 1) / 12);
  const m = ((monthOffsetFromJan1 - 1) % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}-15`;
}

/**
 * Original statutory due date (YYYY-MM-DD) for a return.
 * @param fiscalYearEndMonth 1–12; 12 = calendar-year filer.
 */
export function originalDeadline(
  returnType: DeadlineReturnType,
  taxYear: number,
  fiscalYearEndMonth = 12
): string | null {
  const offset = MONTHS_AFTER_YEAR_END[returnType];
  if (offset === null) return null;
  // Fiscal year ends in `taxYear`, month `fiscalYearEndMonth`; due the 15th of
  // (fye month + offset), rolling into the next calendar year as needed.
  return fifteenthOf(taxYear, fiscalYearEndMonth + offset);
}

/** Extended due date = original + 6 months (never a two-value swap). */
export function extendedDeadline(
  returnType: DeadlineReturnType,
  taxYear: number,
  fiscalYearEndMonth = 12
): string | null {
  const offset = MONTHS_AFTER_YEAR_END[returnType];
  if (offset === null) return null;
  return fifteenthOf(taxYear, fiscalYearEndMonth + offset + EXTENSION_MONTHS);
}

/** Days from `from` (YYYY-MM-DD) to `to` (YYYY-MM-DD); negative when past. */
export function daysBetween(from: string, to: string): number {
  const a = Date.UTC(
    Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10))
  );
  const b = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
  return Math.round((b - a) / 86400000);
}

/** Shift a YYYY-MM-DD date by n days (n may be negative). */
export function addDays(date: string, n: number): string {
  const d = new Date(
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))
  );
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Today's date in the firm's timezone (America/Chicago), as YYYY-MM-DD. */
export function todayChicago(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
}
