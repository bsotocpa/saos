// Typed dates (2026-09-09, Brian's ruling): a calendar day is never shifted; an instant is
// rendered in Chicago; dayOf gives the Chicago day an instant fell on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDate, dayOf, isCalendarDate, formatDateTime, WRONG_HELPER } from '../lib/dates.ts';

test('a calendar day renders as that day — the 2026-08-16 that once rendered as Aug 15', () => {
  assert.equal(formatDate('2026-08-16'), 'Aug 16, 2026');
  assert.equal(formatDate('2026-09-09'), 'Sep 9, 2026');
  assert.ok(isCalendarDate('2026-09-09'));
  assert.ok(!isCalendarDate('2026-09-09T00:00:00.000Z'));
});

test('an instant renders in Chicago: the day it fell on there, and the time there', () => {
  assert.equal(dayOf('2026-08-16T00:00:00.000Z'), 'Aug 15, 2026');
  assert.equal(formatDateTime('2026-08-16T00:00:00.000Z'), 'Aug 15, 2026, 7:00 PM CT');
});

test('an instant handed to formatDate is marked, never silently the wrong day', () => {
  const out = formatDate('2026-08-16T00:00:00.000Z');
  assert.ok(out.startsWith(WRONG_HELPER), out);
  assert.ok(out.includes('Aug 15, 2026'), 'the Chicago day it fell on, marked');
  assert.equal(formatDate(null), '—');
});

test('started and ended read in order for the engagement that showed "started Sep 9 · ended Sep 8"', () => {
  const started = formatDate('2026-09-09');
  const ended = formatDate('2026-09-09');
  assert.equal(started, ended);
});
