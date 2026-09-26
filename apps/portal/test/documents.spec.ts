/*
 * THE DOCUMENTS PAGE RENDERS EVERY SHAPE THE API RETURNS (R49, Brian, 2026-09-26).
 *
 * The rows below are the JSON GET /portal/documents returned for Brian's own account on a copy of
 * production (2026-09-26; file names, ids and free text redacted to their types): a signed
 * authorization with no year and a delivered return with one. The page labelled them with
 * `t(\`cat_${category}\`)`, the dictionary had no entry for either staff-filed category, and
 * translate() threw "Cannot read properties of undefined (reading '0')" — the client-side
 * exception. The first test pins that history; the rest prove the labels for every value of the
 * database enums and for a value the dictionary has never met.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docCategoryLabel, docStatusLabel, docStatusTone, hasDictKey, humanise, translate, type DictKey } from '../lib/i18n.ts';

// What the API returned for Brian's account, shape for shape (the probe's r49-out.json).
const BRIANS_ROWS = [
  { id: '<uuid>', category: 'signed_authorizations', status: 'uploaded', filename: '<string:23>', tax_year: null, uploaded_at: '2026-09-20T22:08:16.454Z' },
  { id: '<uuid>', category: 'return_deliverable', status: 'uploaded', filename: '<string:36>', tax_year: 2025, uploaded_at: '2026-09-20T22:02:42.937Z' },
];

// packages/db/migrations: 0004 created the enums; 0009, 0024, 0094 and 0113 added values.
const DOCUMENT_CATEGORIES = [
  'tax_documents', 'business_records', 'id_verification', 'irs_notices', 'signed_authorizations', 'return_deliverable', 'other',
  'recording', 'financial_statements', 'entity_filings', 'mailing_receipts',
];
const DOCUMENT_STATUSES = ['uploaded', 'under_review', 'accepted', 'needs_replacement', 'archived'];

test('the page as it was: an asserted dictionary key throws on a category the dictionary lacks', () => {
  const asItWas = (category: string) => translate('en', `cat_${category}` as DictKey);
  assert.throws(() => asItWas('a_category_no_dictionary_has'), /Cannot read properties of undefined \(reading '0'\)/);
  // The two categories from Brian's account now have entries, so even the old call would render them.
  for (const row of BRIANS_ROWS) assert.equal(hasDictKey(`cat_${row.category}`), true, row.category);
});

test("Brian's two rows render in both languages with a label each and no throw", () => {
  for (const lang of ['en', 'es'] as const) {
    for (const row of BRIANS_ROWS) {
      const category = docCategoryLabel(lang, row.category);
      const status = docStatusLabel(lang, row.status);
      assert.ok(category.length > 0 && !category.includes('_'), `${lang} ${row.category} -> ${category}`);
      assert.ok(status.length > 0, `${lang} ${row.status} -> ${status}`);
    }
  }
  assert.equal(docCategoryLabel('en', 'signed_authorizations'), 'Signed authorizations');
  assert.equal(docCategoryLabel('es', 'return_deliverable'), 'Declaración terminada');
});

test('every value of document_category and document_status has a dictionary entry', () => {
  for (const c of DOCUMENT_CATEGORIES) assert.equal(hasDictKey(`cat_${c}`), true, `cat_${c}`);
  for (const s of DOCUMENT_STATUSES) assert.equal(hasDictKey(`doc_status_${s}`), true, `doc_status_${s}`);
});

test('a value the dictionary has never met renders as words, never as an exception', () => {
  assert.equal(docCategoryLabel('en', 'some_future_category'), 'Some future category');
  assert.equal(docStatusLabel('es', 'quarantined'), 'Quarantined');
  assert.equal(docCategoryLabel('en', null), '');
  assert.equal(docStatusLabel('en', undefined), '');
  assert.equal(humanise('___'), '');
});

test('the status tone marks only what the client acts on or is reassured by', () => {
  assert.equal(docStatusTone('needs_replacement'), 'danger');
  assert.equal(docStatusTone('accepted'), 'ok');
  assert.equal(docStatusTone('uploaded'), '');
  assert.equal(docStatusTone(null), '');
});
