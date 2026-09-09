// The one Ops date helper (2026-09-09, Brian's ruling): Chicago time, never a raw ISO string.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDate, formatDateTime, formatTime, dayOf, RAW_TIMESTAMP, WRONG_HELPER } from '../lib/dates.ts';

test('a timestamp renders as a Chicago date, never as ISO-T', () => {
  // 2026-08-16T00:00:00Z is 7 PM on Aug 15 in Chicago (CDT). An instant's day comes from dayOf;
  // the premise that formatDate takes an instant was inverted on 2026-09-09 (typed input):
  // it still renders the right Chicago day, but marked, because the caller used the wrong helper.
  assert.equal(dayOf('2026-08-16T00:00:00.000Z'), 'Aug 15, 2026');
  assert.equal(formatDate('2026-08-16T00:00:00.000Z'), `${WRONG_HELPER} Aug 15, 2026`);
  assert.equal(formatDateTime('2026-08-16T00:00:00.000Z'), 'Aug 15, 2026, 7:00 PM CT');
  assert.equal(formatTime('2026-08-16T00:00:00.000Z'), '7:00 PM CT');
  for (const out of [formatDate('2026-08-16T00:00:00.000Z'), formatDateTime('2026-08-16T00:00:00.000Z')]) {
    assert.doesNotMatch(out, RAW_TIMESTAMP);
  }
});

test('a date-only value is a calendar day and is not shifted by the zone', () => {
  assert.equal(formatDate('2026-08-16'), 'Aug 16, 2026');
});

test('nothing renders as a dash, not as "Invalid Date"', () => {
  assert.equal(formatDate(null), '—');
  assert.equal(formatDateTime(undefined), '—');
  assert.equal(formatDate('not a date'), '—');
});
