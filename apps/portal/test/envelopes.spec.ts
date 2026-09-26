/*
 * ONE ROW PER DOCUMENT, LABELLED BY WHAT IT BELONGS TO (R46, Brian, 2026-09-26).
 *
 * The rows below are the shape GET /portal/signature-envelopes returned for the production contact
 * whose portal home showed two "Engagement letter" rows and two "Tax information consent" rows under
 * "Waiting for your signature" beside a signed packet (2026-09-26 diagnosis; ids and names synthetic).
 * The page now folds envelopes of one type on one engagement into one row, the furthest-along status
 * standing for the document, and names the engagement or business each row belongs to.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envelopeContext, envelopeLabel, envelopeRows, translate, type DictKey, type Envelope } from '../lib/i18n.ts';

const t = (key: DictKey) => translate('en', key);

test('two envelopes of one type on one engagement are one row, and the signed copy stands for it', () => {
  const rows = envelopeRows([
    { id: 'a', type: 'engagement_letter', status: 'draft', engagement_id: 'e1', return_type: '1120s', tax_year: 2025 },
    { id: 'b', type: 'engagement_letter', status: 'completed', completed_at: '2026-09-20T22:08:16.454Z', engagement_id: 'e1', return_type: '1120s', tax_year: 2025 },
    { id: 'c', type: 'consent_7216', status: 'draft', engagement_id: null },
    { id: 'd', type: 'consent_7216', status: 'draft', engagement_id: null },
  ]);
  assert.equal(rows.length, 2, 'four envelopes, two documents');
  assert.equal(rows.find((r) => r.type === 'engagement_letter')?.id, 'b', 'the signed copy is the row');
  assert.equal(rows.filter((r) => r.type === 'consent_7216').length, 1, 'the two consents are one row');
});

test('envelopes of one type on DIFFERENT engagements stay separate rows and read apart', () => {
  const rows = envelopeRows([
    { id: 'a', type: 'engagement_letter', status: 'draft', engagement_id: 'e1', return_type: '1120s', tax_year: 2025, business_name: 'Synthetic S Corp, LLC' },
    { id: 'b', type: 'engagement_letter', status: 'draft', engagement_id: 'e2', return_type: '1040', tax_year: 2025 },
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => envelopeLabel(t, r)), ['Engagement letter — Synthetic S Corp, LLC', 'Engagement letter — 1040 2025']);
});

test('the label names the business first, then the return, then nothing; an unknown type never throws', () => {
  const base: Envelope = { id: 'x', type: 'engagement_letter', status: 'draft' };
  assert.equal(envelopeContext({ ...base, business_name: 'Acme LLC', return_type: '1120s', tax_year: 2025 }), 'Acme LLC');
  assert.equal(envelopeContext({ ...base, return_type: '1120s', tax_year: 2025 }), '1120S 2025');
  assert.equal(envelopeContext({ ...base, tax_year: 2024 }), '2024');
  assert.equal(envelopeContext(base), null);
  assert.equal(envelopeLabel(t, base), 'Engagement letter');
  assert.equal(envelopeLabel(t, { ...base, type: 'grant_agreement' }), 'grant agreement', 'a type the dictionary lacks reads as its words');
  assert.equal(envelopeLabel((k) => translate('es', k), { ...base, type: 'consent_7216' }), 'Consentimiento de información fiscal (§7216)');
});
