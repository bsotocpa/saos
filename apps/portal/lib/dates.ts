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

/** "Aug 16, 2026" / "16 ago 2026" — a date-only value is a calendar day, never zone-shifted. */
export function formatDate(v: DateInput, lang: PortalLang): string {
  if (isDateOnly(v)) {
    const [y, m, d] = v.split('-').map(Number);
    return new Intl.DateTimeFormat(localeFor(lang), { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
      .format(new Date(Date.UTC(y!, m! - 1, d!)));
  }
  const d = toDate(v);
  return d ? new Intl.DateTimeFormat(localeFor(lang), { month: 'short', day: 'numeric', year: 'numeric' }).format(d) : '—';
}

/** Date and time in the reader's zone. */
export function formatDateTime(v: DateInput, lang: PortalLang): string {
  const d = toDate(v);
  return d
    ? new Intl.DateTimeFormat(localeFor(lang), { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d)
    : '—';
}

/** Time of day in the reader's zone. */
export function formatTime(v: DateInput, lang: PortalLang): string {
  const d = toDate(v);
  return d ? new Intl.DateTimeFormat(localeFor(lang), { hour: 'numeric', minute: '2-digit' }).format(d) : '—';
}

export const RAW_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
