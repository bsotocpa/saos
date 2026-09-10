// Audit item 11 (2026-09-09): one label map per enum, exhaustive, and the portal's word where
// the client sees the same state. The enum values here mirror the migrations; a new status
// without a word fails this spec before it reaches a badge.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ENGAGEMENT_STATUS_LABEL, INVOICE_STATUS_LABEL, QUOTE_STATUS_LABEL, TAX_STAGE_LABEL,
  engagementStatusLabel, invoiceStatusLabel, quoteStatusLabel, taxStageLabel,
} from '../lib/labels.ts';

const INVOICE_STATUSES = ['draft', 'sent', 'paid', 'overdue', 'void', 'refunded', 'partially_refunded', 'disputed'];
const ENGAGEMENT_STATUSES = ['draft', 'active', 'on_hold', 'completed', 'withdrawn'];
const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'expired', 'void'];
const TAX_STAGES = ['intake_started', 'scheduled', 'documents_requested', 'pending_client_response', 'in_preparation', 'internal_review', 'client_review', 'ready_to_file', 'filed', 'completed', 'on_hold', 'withdrawn', 'rejected'];

test('every enum value has a word, and no word is the raw enum', () => {
  for (const [name, values, map] of [
    ['invoice_status', INVOICE_STATUSES, INVOICE_STATUS_LABEL],
    ['engagement_status', ENGAGEMENT_STATUSES, ENGAGEMENT_STATUS_LABEL],
    ['quote_status', QUOTE_STATUSES, QUOTE_STATUS_LABEL],
    ['tax_stage', TAX_STAGES, TAX_STAGE_LABEL],
  ] as const) {
    for (const v of values) {
      const word = (map as Record<string, string>)[v];
      assert.ok(word, `${name}.${v} has a label`);
      assert.doesNotMatch(word, /_/, `${name}.${v}: a word, not an enum`);
    }
    assert.deepEqual(Object.keys(map).sort(), [...values].sort(), `${name}: the map is exactly the enum`);
  }
});

test('the client and Ops read the same word for the same invoice state', () => {
  const i18n = readFileSync(new URL('../../portal/lib/i18n.ts', import.meta.url), 'utf8');
  const portal = (key: string) => (i18n.match(new RegExp(`${key}: \\['([^']+)'`)) ?? [])[1];
  assert.equal(invoiceStatusLabel('sent'), portal('inv_open'), 'sent reads "Open" in both');
  assert.equal(invoiceStatusLabel('void'), portal('inv_void'), 'void reads "Cancelled" in both');
  assert.equal(invoiceStatusLabel('disputed'), portal('inv_disputed'), 'disputed reads "Under review" in both');
  assert.equal(invoiceStatusLabel('partially_refunded'), portal('inv_partially_refunded'));
});

test('the helpers never crash a page on an unknown value', () => {
  assert.equal(engagementStatusLabel('on_hold'), 'On hold');
  assert.equal(quoteStatusLabel('void'), 'Withdrawn');
  assert.equal(taxStageLabel('pending_client_response'), 'Waiting on client');
  assert.equal(invoiceStatusLabel('something_new'), 'something new');
});
