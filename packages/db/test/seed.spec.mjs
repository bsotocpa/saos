// Integration spot-checks against the RUNNING, migrated, seeded database
// (M2/M3 "Prove it"). Run: npm run test:db  (needs `docker compose up -d`,
// `npm run migrate`, `npm run seed` first).
//
// All fixture data below is synthetic (no real client data in tests — CLAUDE.md).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../../.env') });

const client = new pg.Client({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://saos:saos_dev_password@localhost:5432/saos',
});

before(async () => client.connect());
after(async () => client.end());

test('price book v1 exists with the full Pricing Seed Data', async () => {
  const v = await client.query(
    `SELECT id, version_number FROM price_book_versions WHERE version_number = 1`
  );
  assert.equal(v.rows.length, 1, 'price book v1 missing — run npm run seed');

  const count = await client.query(
    `SELECT count(*)::int AS n FROM price_book_items WHERE version_id = $1`,
    [v.rows[0].id]
  );
  assert.ok(count.rows[0].n >= 70, `expected ~74 seed items, found ${count.rows[0].n}`);
});

test('spot prices match the spec (MFJ base, 1120-S, monthly accounting)', async () => {
  const { rows } = await client.query(`
    SELECT i.item_code, i.amount_cents
    FROM price_book_items i
    JOIN price_book_versions v ON v.id = i.version_id AND v.version_number = 1
    WHERE i.item_code IN ('IND_BASE_MFJ', 'BIZ_1120S', 'ACCT_MONTHLY', 'ATTEST_AUDIT')
  `);
  const byCode = Object.fromEntries(rows.map((r) => [r.item_code, r.amount_cents]));
  assert.equal(byCode.IND_BASE_MFJ, 20000, 'MFJ base should be $200.00');
  assert.equal(byCode.BIZ_1120S, 70000, '1120-S should be $700.00');
  assert.equal(byCode.ACCT_MONTHLY, 25000, 'monthly accounting should be $250.00/mo');
  assert.equal(byCode.ATTEST_AUDIT, 500000, 'CPA audit should be $5,000.00');
});

test('the ⚠ conflicts are flagged needs_confirmation for Brian', async () => {
  const { rows } = await client.query(`
    SELECT i.item_code
    FROM price_book_items i
    JOIN price_book_versions v ON v.id = i.version_id AND v.version_number = 1
    WHERE i.needs_confirmation
  `);
  const codes = rows.map((r) => r.item_code);
  for (const expected of [
    'IND_CPA_LETTER',
    'ACCT_SEMI_ANNUAL',
    'SCOPE_FULLMGMT_SALES_TAX',
    'ENTITY_FORMATION_EIN',
    'ENTITY_ANNUAL_REPORT',
    'SPEC_TAX_PLANNING',
    'DEPOSIT_BUSINESS_TAX',
  ]) {
    assert.ok(codes.includes(expected), `${expected} should be flagged needs_confirmation`);
  }
});

test('the 3 bundle rules from the spec are seeded', async () => {
  const { rows } = await client.query(`
    SELECT b.rule_code, b.rule_type
    FROM bundle_rules b
    JOIN price_book_versions v ON v.id = b.version_id AND v.version_number = 1
  `);
  const byCode = Object.fromEntries(rows.map((r) => [r.rule_code, r.rule_type]));
  assert.equal(byCode.BUNDLE_QBO_PAYROLL_SETUP, 'bundle_price');
  assert.equal(byCode.FREE_ST1_WITH_MONTHLY, 'free_with');
  assert.equal(byCode.FREE_FORECAST_WITH_MONTHLY, 'free_with');
});

test('grandfathering: a new price book version does not touch v1 items', async () => {
  await client.query('BEGIN');
  try {
    const v2 = await client.query(`
      INSERT INTO price_book_versions (version_number, effective_from, note)
      VALUES (999, CURRENT_DATE, 'test version — rolled back')
      RETURNING id
    `);
    // "Raise" the MFJ base in v999 the way the admin editor will (new row, new version):
    await client.query(
      `INSERT INTO price_book_items (version_id, item_code, service_line, name_en, name_es, amount_cents, unit)
       SELECT $1, item_code, service_line, name_en, name_es, amount_cents * 2, unit
       FROM price_book_items i
       JOIN price_book_versions v ON v.id = i.version_id AND v.version_number = 1
       WHERE i.item_code = 'IND_BASE_MFJ'`,
      [v2.rows[0].id]
    );
    const v1Price = await client.query(`
      SELECT amount_cents FROM price_book_items i
      JOIN price_book_versions v ON v.id = i.version_id AND v.version_number = 1
      WHERE i.item_code = 'IND_BASE_MFJ'
    `);
    assert.equal(v1Price.rows[0].amount_cents, 20000, 'v1 must remain untouched by later versions');
  } finally {
    await client.query('ROLLBACK');
  }
});

test('audit_log is append-only (UPDATE and DELETE are rejected)', async () => {
  const inserted = await client.query(`
    INSERT INTO audit_log (actor_type, action, details)
    VALUES ('system', 'test.append_only_check', '{"synthetic": true}')
    RETURNING id
  `);
  const id = inserted.rows[0].id;

  await assert.rejects(
    client.query(`UPDATE audit_log SET action = 'tampered' WHERE id = $1`, [id]),
    /append-only/,
    'UPDATE on audit_log must be rejected by trigger'
  );
  await assert.rejects(
    client.query(`DELETE FROM audit_log WHERE id = $1`, [id]),
    /append-only/,
    'DELETE on audit_log must be rejected by trigger'
  );
});

test('scope creep requires a reason (CHECK constraint)', async () => {
  await client.query('BEGIN');
  try {
    const contact = await client.query(`
      INSERT INTO contacts (first_name, last_name, email)
      VALUES ('Synthetic', 'Testclient', 'synthetic.testclient@example.test')
      RETURNING id
    `);
    const eng = await client.query(
      `INSERT INTO engagements (contact_id, service_line) VALUES ($1, 'tax') RETURNING id`,
      [contact.rows[0].id]
    );
    await assert.rejects(
      client.query(
        `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, scope_creep_flag)
         VALUES ($1, 2025, '1040', true)`,
        [eng.rows[0].id]
      ),
      /check constraint/i,
      'scope_creep_flag without a reason must violate the CHECK'
    );
  } finally {
    await client.query('ROLLBACK');
  }
});

test('placeholder templates are seeded and flagged (launch gate data)', async () => {
  const { rows } = await client.query(`
    SELECT key, is_placeholder, body_es IS NOT NULL AS has_spanish
    FROM templates
    WHERE key IN ('engagement_letter_tax', 'consent_7216_use', 'consent_7216_disclose')
  `);
  assert.equal(rows.length, 3, 'engagement letter + both §7216 consents must be seeded');
  for (const row of rows) {
    assert.equal(row.is_placeholder, true, `${row.key} must be flagged PLACEHOLDER until Brian's final text`);
    assert.equal(row.has_spanish, true, `${row.key} must ship EN and ES`);
  }
});

test('roles for the whole team (incl. future roles) are seeded', async () => {
  const { rows } = await client.query(`SELECT key FROM roles`);
  const keys = rows.map((r) => r.key);
  for (const expected of [
    'ceo', 'ed_coo', 'tax_preparer', 'va_entity', 'auditor',
    'comms_billing', 'bookkeeper', 'intern', 'client_success', 'advisory_manager',
  ]) {
    assert.ok(keys.includes(expected), `role ${expected} missing`);
  }
});
