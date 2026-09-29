/*
 * THE YEARS A QUOTE IS FOR (Brian, 2026-09-29, R89).
 *
 * Answer A: a quote may carry the same return for several years, and each chosen year repeats the
 * return and its schedules as its own group of lines. Every return line (a line on individual_tax or
 * business_tax) carries the year it is for. A quote that names no year on its lines is a one-year
 * quote, as every quote before R89 was: its return lines take the quote's one year (the interview's
 * or the builder's, else the default), written onto each line so every reader asks the line.
 *
 * Answer B: the server adds PRIOR_YEAR_SURCHARGE once for every quoted year more than two back,
 * single-year and multi-year alike, at the book's price. Nobody types it: a submitted surcharge line
 * is refused, and a package that lists it as a component has that line replaced by the server's.
 */
import { AppError } from '../../types.ts';
import { surchargeApplies } from '../tax/resolution.ts';

/** The price lines a return is sold on; their lines carry a year. */
export const RETURN_LINES = new Set(['individual_tax', 'business_tax']);

export interface YearedLine {
  itemCode: string;
  chosen: boolean;
  /** The year the person set on the line, or null. */
  taxYear: number | null;
}

/** The quote's one year from the interview answers the builder sends, when it names a sane one. */
export function quoteYearFromAnswers(answers: Record<string, string | number | boolean> | undefined): number | null {
  const n = Number(answers?.['tax_year']);
  return Number.isInteger(n) && n >= 1990 && n <= 2199 ? n : null;
}

/**
 * Every return line gets its year; any other line gets none. Refuses a quote that names a year on
 * some return lines and not others (which year would the rest be?), a year on a line that is not a
 * return, and a year past the newest the builder offers. Returns the chosen return lines' years,
 * newest first.
 */
export function assignLineYears<L extends YearedLine>(
  lines: L[],
  serviceLineOf: (l: L) => string | null,
  opts: { quoteYear: number; newestYear: number }
): number[] {
  const isReturn = (l: L) => RETURN_LINES.has(serviceLineOf(l) ?? '');
  const named = lines.filter((l) => l.taxYear !== null);
  const stray = named.filter((l) => !isReturn(l));
  if (stray.length > 0) {
    throw new AppError(400, 'tax_year_on_non_return', `A year belongs on return lines only: ${stray.map((l) => l.itemCode).join(', ')}.`);
  }
  if (named.length > 0) {
    const bare = lines.filter((l) => isReturn(l) && l.taxYear === null);
    if (bare.length > 0) {
      throw new AppError(400, 'tax_year_missing', `Every return line names its year when any does: ${bare.map((l) => l.itemCode).join(', ')} names none.`);
    }
  } else {
    for (const l of lines) if (isReturn(l)) l.taxYear = opts.quoteYear;
  }
  const late = lines.filter((l) => l.taxYear !== null && l.taxYear > opts.newestYear);
  if (late.length > 0) {
    throw new AppError(400, 'tax_year_future', `No return is quoted for a year after ${opts.newestYear}.`);
  }
  return [...new Set(lines.filter((l) => l.chosen && isReturn(l)).map((l) => l.taxYear!))].sort((a, b) => b - a);
}

/** The quoted years that carry the prior-year surcharge: more than two years back. */
export function surchargeYears(years: number[], today?: string): number[] {
  return years.filter((y) => surchargeApplies(y, today));
}
