// ONE DATE HELPER FOR OPS (2026-09-09, Brian's ruling). "ended 2026-08-16T00:00:00.000Z"
// rendered raw on the client page. Every timestamp Ops shows goes through here, in Chicago
// time — the office's clock, whatever machine or phone is reading.

export const OPS_TIME_ZONE = 'America/Chicago';

type DateInput = string | Date | null | undefined;

function toDate(v: DateInput): Date | null {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A date-only value ('2026-08-16') is a calendar day: shown as that day, not shifted by zone. */
function isDateOnly(v: DateInput): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/** The visible marker formatDate prints when it is handed an instant. Tests look for it. */
export const WRONG_HELPER = '⚠';

/** "Aug 16, 2026" — a CALENDAR DAY ('YYYY-MM-DD' from a DATE column). For an instant, use dayOf. */
export function formatDate(v: CalendarDate | string | null | undefined): string {
  if (isDateOnly(v)) {
    const [y, m, d] = v.split('-').map(Number);
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
      .format(new Date(Date.UTC(y!, m! - 1, d!)));
  }
  if (!toDate(v)) return '—';
  // An instant reached the calendar-day formatter: render the Chicago day it fell on, marked.
  return `${WRONG_HELPER} ${dayOf(v)}`;
}

/** "Aug 16, 2026, 3:04 PM CT" — an INSTANT (timestamptz), in Chicago. */
export function formatDateTime(v: Instant | Date | null | undefined): string {
  const d = toDate(v);
  if (!d) return '—';
  return `${new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: OPS_TIME_ZONE,
  }).format(d)} CT`;
}

/** "3:04 PM CT" — an INSTANT (timestamptz), in Chicago. */
export function formatTime(v: Instant | Date | null | undefined): string {
  const d = toDate(v);
  if (!d) return '—';
  return `${new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: OPS_TIME_ZONE }).format(d)} CT`;
}

/** "September 2026" from a YYYY-MM key. */
export function formatMonth(yyyyMm: string): string {
  const [y, m] = yyyyMm.split('-').map(Number);
  if (!y || !m) return yyyyMm;
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)));
}

/**
 * TYPED INPUT (2026-09-09, Brian's ruling). A DATE column is a calendar day — 'YYYY-MM-DD',
 * no zone, never shifted. A TIMESTAMPTZ is an instant, rendered in Chicago. formatDate takes
 * the first; formatDateTime/formatTime take the second; dayOf takes an instant and gives the
 * Chicago calendar day it fell on. Handing an instant to formatDate renders the right day
 * with a visible ⚠ marker (WRONG_HELPER) rather than a silently wrong one; the build guard
 * (check:date-rendering) refuses the static cases: a *_at field into formatDate, a *_on or
 * *_date field into dayOf/formatDateTime/formatTime.
 */
export type CalendarDate = `${number}-${number}-${number}`;
export type Instant = string;

export function isCalendarDate(v: unknown): v is CalendarDate {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/** The Chicago calendar day an instant fell on — for "paid on", "sent on" from timestamps. */
export function dayOf(v: Instant | Date | null | undefined): string {
  const d = toDate(v);
  if (!d) return '—';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: OPS_TIME_ZONE }).format(d);
}

/** The ISO-with-T shape a raw timestamp leaks as. The guard and the tests look for this. */
export const RAW_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
