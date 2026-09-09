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

/** "Aug 16, 2026" */
export function formatDate(v: DateInput): string {
  if (isDateOnly(v)) {
    const [y, m, d] = v.split('-').map(Number);
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
      .format(new Date(Date.UTC(y!, m! - 1, d!)));
  }
  const d = toDate(v);
  return d ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: OPS_TIME_ZONE }).format(d) : '—';
}

/** "Aug 16, 2026, 3:04 PM CT" */
export function formatDateTime(v: DateInput): string {
  const d = toDate(v);
  if (!d) return '—';
  return `${new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: OPS_TIME_ZONE,
  }).format(d)} CT`;
}

/** "3:04 PM CT" */
export function formatTime(v: DateInput): string {
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

/** The ISO-with-T shape a raw timestamp leaks as. The guard and the tests look for this. */
export const RAW_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
