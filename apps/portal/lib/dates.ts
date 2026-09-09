// ONE DATE HELPER FOR THE PORTAL (2026-09-09, Brian's ruling). The client's own locale and
// their own clock: a portal page never shows a raw ISO timestamp, and never shows Chicago
// time to someone in another zone.

type DateInput = string | Date | null | undefined;
export type PortalLang = 'en' | 'es';

function toDate(v: DateInput): Date | null {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isDateOnly(v: DateInput): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/** The reader's locale: the portal language first, the browser's language as the region hint. */
export function localeFor(lang: PortalLang): string {
  const browser = typeof navigator !== 'undefined' ? navigator.language : '';
  if (lang === 'es') return browser.toLowerCase().startsWith('es') ? browser : 'es-US';
  return browser.toLowerCase().startsWith('en') ? browser : 'en-US';
}

/*
 * TYPED INPUT (2026-09-09, Brian's ruling). A DATE column is a calendar day — 'YYYY-MM-DD',
 * no zone, never shifted: formatDate. A TIMESTAMPTZ is an instant in the reader's zone:
 * formatDateTime/formatTime, or dayOf for the day it fell on. An instant handed to formatDate
 * renders the right day with a visible ⚠ marker (WRONG_HELPER); the build guard refuses the
 * static cases.
 */
export type CalendarDate = `${number}-${number}-${number}`;
export type Instant = string;
export const WRONG_HELPER = '⚠';

/** The reader's calendar day an instant fell on — "received Aug 16, 2026". */
export function dayOf(v: Instant | Date | null | undefined, lang: PortalLang): string {
  const d = toDate(v);
  return d ? new Intl.DateTimeFormat(localeFor(lang), { month: 'short', day: 'numeric', year: 'numeric' }).format(d) : '—';
}

/** "Aug 16, 2026" / "16 ago 2026" — a CALENDAR DAY (DATE column), never zone-shifted. For an instant, use dayOf. */
export function formatDate(v: CalendarDate | string | null | undefined, lang: PortalLang): string {
  if (isDateOnly(v)) {
    const [y, m, d] = v.split('-').map(Number);
    return new Intl.DateTimeFormat(localeFor(lang), { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
      .format(new Date(Date.UTC(y!, m! - 1, d!)));
  }
  if (!toDate(v)) return '—';
  return `${WRONG_HELPER} ${dayOf(v, lang)}`;
}

/** Date and time in the reader's zone — an INSTANT (timestamptz). */
export function formatDateTime(v: Instant | Date | null | undefined, lang: PortalLang): string {
  const d = toDate(v);
  return d
    ? new Intl.DateTimeFormat(localeFor(lang), { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d)
    : '—';
}

/** Time of day in the reader's zone — an INSTANT (timestamptz). */
export function formatTime(v: Instant | Date | null | undefined, lang: PortalLang): string {
  const d = toDate(v);
  return d ? new Intl.DateTimeFormat(localeFor(lang), { hour: 'numeric', minute: '2-digit' }).format(d) : '—';
}

export const RAW_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
