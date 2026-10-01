/*
 * THE CHICAGO DAY IN SQL (Brian, 2026-09-30, R104). The database clock is UTC (production reads
 * Etc/UTC), so CURRENT_DATE, now()::date and date_trunc on now() turn over at 19:00 Chicago (18:00 in
 * winter): every evening they read tomorrow, and a month's last evening reads next month. The firm's
 * day is Chicago's. Every SQL "today", month and year boundary is one of these; check:chicago-dates
 * (the root chain) refuses the server-clock forms in apps/api/src.
 */

/** Today in Chicago, as a SQL date. */
export const CHICAGO_TODAY = `((now() AT TIME ZONE 'America/Chicago')::date)`;
/** The first instant of the current month in Chicago, as timestamptz. */
export const CHICAGO_MONTH_START = `(date_trunc('month', now() AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago')`;
/** The first instant of the current year in Chicago, as timestamptz. */
export const CHICAGO_YEAR_START = `(date_trunc('year', now() AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago')`;
/** The Chicago calendar day of a stored instant (a timestamptz column or expression). */
export const chicagoDayOf = (expr: string): string => `((${expr}) AT TIME ZONE 'America/Chicago')::date`;

/**
 * The price-book version in force today in Chicago (effective_from inclusive, effective_to exclusive).
 * `alias` is the price_book_versions alias in the query, or none.
 */
export function priceBookInForce(alias?: string): string {
  const p = alias ? `${alias}.` : '';
  return `${p}effective_from <= ${CHICAGO_TODAY} AND (${p}effective_to IS NULL OR ${p}effective_to > ${CHICAGO_TODAY})`;
}
