// Deadline derivation — v4.3 AUTHORITATIVE TAX DEADLINE TABLE (MP addendum;
// CLAUDE.md hard rule). Every deadline anywhere in the system derives from
// THE_TABLE below + entity fiscal year end; a hardcoded date pair outside
// this module is a build failure. The table mirrors the spec row-for-row so
// review is a side-by-side read.
//
// Calendar-year rows are the spec's explicit dates. Fiscal-year filers:
// original = 15th of month N after fiscal year end (N = 4; 5 for 990),
// extended = original + 6 months (spec's fiscal rule). Rows that break the
// +6 pattern on calendar year (1041 → Sep 30; expat) carry explicit values.
//
// All produced deadlines ROLL to the next business day (weekends + observed
// federal holidays + DC Emancipation Day, which the IRS honors for April
// deadlines) per the spec's "roll to next business day" rule.

export type DeadlineReturnType =
  | '1040' | '1065' | '1120s' | '1120' | '990' | '990ez'
  | '1120c' | '1120f' | '1120f_foreign' | '1120h' | '1120pol'
  | '1041' | '1040_expat' | 'fbar' | 'w7_itin';

interface DeadlineRule {
  /** Original due = 15th of (FYE month + N); null = no standalone deadline. */
  monthsAfterYearEnd: number | null;
  /** Calendar-year ORIGINAL override 'MM-DD' (expat + foreign-corp June 15). */
  calendarOriginal?: string;
  /** Calendar-year EXTENDED override 'MM-DD' (1041's Sep 30 breaks +6). */
  calendarExtended?: string;
  /** Extension needs no filing (FBAR): keep it OFF extension decision lists. */
  extensionAutomatic?: boolean;
}

/** v4.3 AUTHORITATIVE TAX DEADLINE TABLE — one row per spec row. */
const THE_TABLE: Record<DeadlineReturnType, DeadlineRule> = {
  '1065':          { monthsAfterYearEnd: 3 },                                  // Mar 15 → Sep 15
  '1120s':         { monthsAfterYearEnd: 3 },                                  // Mar 15 → Sep 15
  '1040':          { monthsAfterYearEnd: 4 },                                  // Apr 15 → Oct 15
  '1120':          { monthsAfterYearEnd: 4 },                                  // Apr 15 → Oct 15
  '1120c':         { monthsAfterYearEnd: 4 },                                  // spec: 1120-C with 1120
  '1120h':         { monthsAfterYearEnd: 4 },                                  // spec: 1120-H with 1120
  '1120pol':       { monthsAfterYearEnd: 4 },                                  // spec: 1120-POL with 1120
  '1041':          { monthsAfterYearEnd: 4, calendarExtended: '09-30' },       // Apr 15 → Sep 30 (NOT +6)
  '990':           { monthsAfterYearEnd: 5 },                                  // May 15 → Nov 15 (v4.3 corrected)
  '990ez':         { monthsAfterYearEnd: 5 },                                  // May 15 → Nov 15
  '1120f':         { monthsAfterYearEnd: 4 },                                  // foreign corp WITH US office: Apr 15 → Oct 15
  '1120f_foreign': { monthsAfterYearEnd: 6, calendarOriginal: '06-15' },       // no US office: Jun 15 → Dec 15
  '1040_expat':    { monthsAfterYearEnd: 4, calendarOriginal: '06-15', calendarExtended: '10-15' }, // Jun 15 auto → Oct 15
  fbar:            { monthsAfterYearEnd: 4, extensionAutomatic: true },        // Apr 15 → Oct 15 AUTOMATIC
  w7_itin:         { monthsAfterYearEnd: null },                               // filed with the return
};

/** Estimated-payment due dates (staff board always; client display is toggled). */
export const ESTIMATE_DATES: ReadonlyArray<{ quarter: 'Q1' | 'Q2' | 'Q3' | 'Q4'; monthDay: string }> = [
  { quarter: 'Q1', monthDay: '04-15' },
  { quarter: 'Q2', monthDay: '06-15' },
  { quarter: 'Q3', monthDay: '09-15' },
  { quarter: 'Q4', monthDay: '01-15' }, // of the FOLLOWING year
];

// ── business-day rolling ─────────────────────────────────────────────────────

function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const day = 1 + ((7 + weekday - first.getUTCDay()) % 7) + (n - 1) * 7;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function lastWeekdayOfMonth(year: number, month: number, weekday: number): string {
  const last = new Date(Date.UTC(year, month, 0)); // final day of month
  const day = last.getUTCDate() - ((7 + last.getUTCDay() - weekday) % 7);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Observed date for a fixed holiday: Sat → Friday before, Sun → Monday after. */
function observed(year: number, monthDay: string): string {
  const date = `${year}-${monthDay}`;
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (dow === 6) return addDays(date, -1);
  if (dow === 0) return addDays(date, 1);
  return date;
}

/** Observed federal holidays + DC Emancipation Day (IRS honors it in April). */
export function federalHolidays(year: number): Set<string> {
  return new Set([
    observed(year, '01-01'),                 // New Year's Day
    nthWeekdayOfMonth(year, 1, 1, 3),        // MLK Day — 3rd Monday Jan
    nthWeekdayOfMonth(year, 2, 1, 3),        // Washington's Birthday — 3rd Monday Feb
    observed(year, '04-16'),                 // DC Emancipation Day (moves Apr 15!)
    lastWeekdayOfMonth(year, 5, 1),          // Memorial Day — last Monday May
    observed(year, '06-19'),                 // Juneteenth
    observed(year, '07-04'),                 // Independence Day
    nthWeekdayOfMonth(year, 9, 1, 1),        // Labor Day — 1st Monday Sep
    nthWeekdayOfMonth(year, 10, 1, 2),       // Columbus Day — 2nd Monday Oct
    observed(year, '11-11'),                 // Veterans Day
    nthWeekdayOfMonth(year, 11, 4, 4),       // Thanksgiving — 4th Thursday Nov
    observed(year, '12-25'),                 // Christmas
  ]);
}

/** Roll a date forward past weekends and observed federal holidays. */
export function rollToBusinessDay(date: string): string {
  let d = date;
  for (let guard = 0; guard < 10; guard++) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    const holidays = federalHolidays(Number(d.slice(0, 4)));
    if (dow !== 0 && dow !== 6 && !holidays.has(d)) return d;
    d = addDays(d, 1);
  }
  return d; // unreachable in practice
}

// ── derivation ───────────────────────────────────────────────────────────────

function fifteenthOf(year: number, monthOffsetFromJan1: number): string {
  const y = year + Math.floor((monthOffsetFromJan1 - 1) / 12);
  const m = ((monthOffsetFromJan1 - 1) % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}-15`;
}

/**
 * Original statutory due date (YYYY-MM-DD, business-day rolled).
 * @param fiscalYearEndMonth 1–12; 12 = calendar-year filer.
 */
export function originalDeadline(
  returnType: DeadlineReturnType,
  taxYear: number,
  fiscalYearEndMonth = 12
): string | null {
  const rule = THE_TABLE[returnType];
  if (rule.monthsAfterYearEnd === null) return null;
  if (fiscalYearEndMonth === 12 && rule.calendarOriginal) {
    return rollToBusinessDay(`${taxYear + 1}-${rule.calendarOriginal}`);
  }
  return rollToBusinessDay(fifteenthOf(taxYear, fiscalYearEndMonth + rule.monthsAfterYearEnd));
}

/** Extended due date (business-day rolled). Fiscal filers: original + 6 months. */
export function extendedDeadline(
  returnType: DeadlineReturnType,
  taxYear: number,
  fiscalYearEndMonth = 12
): string | null {
  const rule = THE_TABLE[returnType];
  if (rule.monthsAfterYearEnd === null) return null;
  if (fiscalYearEndMonth === 12 && rule.calendarExtended) {
    // Calendar FYE = December of taxYear → every override date falls in the
    // FOLLOWING calendar year (1041's Sep 30, expat's Oct 15).
    return rollToBusinessDay(`${taxYear + 1}-${rule.calendarExtended}`);
  }
  return rollToBusinessDay(fifteenthOf(taxYear, fiscalYearEndMonth + rule.monthsAfterYearEnd + 6));
}

/** True when the extension to the extended date requires NO filing (skip decision lists). */
export function isExtensionAutomatic(returnType: DeadlineReturnType): boolean {
  return THE_TABLE[returnType].extensionAutomatic === true;
}

/** Return types with automatic extensions — excluded from extension decision lists. */
export const AUTOMATIC_EXTENSION_TYPES: DeadlineReturnType[] = (
  Object.keys(THE_TABLE) as DeadlineReturnType[]
).filter((t) => THE_TABLE[t].extensionAutomatic === true);

/** The next `count` estimated-payment dates on/after `from` (business-day rolled). */
export function upcomingEstimateDates(
  from: string,
  count = 4
): Array<{ quarter: string; date: string }> {
  const out: Array<{ quarter: string; date: string }> = [];
  const startYear = Number(from.slice(0, 4)) - 1;
  for (let year = startYear; out.length < count && year < startYear + 4; year++) {
    for (const { quarter, monthDay } of ESTIMATE_DATES) {
      // Q4 of tax year Y falls in January of Y+1.
      const calYear = quarter === 'Q4' ? year + 1 : year;
      const rolled = rollToBusinessDay(`${calYear}-${monthDay}`);
      if (rolled >= from && out.length < count && !out.some((o) => o.date === rolled)) {
        out.push({ quarter: `${quarter} ${year}`, date: rolled });
      }
    }
    out.sort((a, b) => a.date.localeCompare(b.date));
  }
  return out.slice(0, count);
}

// ── date utilities (unchanged) ───────────────────────────────────────────────

/** Days from `from` (YYYY-MM-DD) to `to` (YYYY-MM-DD); negative when past. */
export function daysBetween(from: string, to: string): number {
  const a = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)));
  const b = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
  return Math.round((b - a) / 86400000);
}

/** Shift a YYYY-MM-DD date by n days (n may be negative). */
export function addDays(date: string, n: number): string {
  const d = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Today's date in the firm's timezone (America/Chicago), as YYYY-MM-DD. */
export function todayChicago(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
}
