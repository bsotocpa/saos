// The portal date helper (2026-09-09, Brian's ruling): the client's locale, never a raw ISO
// string. Under node there is no navigator, so the locale falls back to en-US / es-US.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDate, formatDateTime, localeFor, RAW_TIMESTAMP } from '../lib/dates.ts';

test('locale follows the portal language when the browser gives no hint', () => {
  assert.equal(localeFor('en'), 'en-US');
  assert.equal(localeFor('es'), 'es-US');
});

test('a date-only value is a calendar day in either language, never ISO-T', () => {
  assert.equal(formatDate('2026-08-16', 'en'), 'Aug 16, 2026');
  assert.match(formatDate('2026-08-16', 'es'), /ago/i);
  assert.doesNotMatch(formatDateTime('2026-08-16T00:00:00.000Z', 'en'), RAW_TIMESTAMP);
});

test('nothing renders as a dash', () => {
  assert.equal(formatDate(null, 'en'), '—');
  assert.equal(formatDateTime('garbage', 'es'), '—');
});
