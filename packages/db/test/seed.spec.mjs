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
  // ACCT_SEMI_ANNUAL is deliberately NOT in this list any more — see the test
  // below. A resolved conflict moves from "flagged" to "confirmed at this price";
  // it does not stop being asserted.
  for (const expected of [
    'IND_CPA_LETTER',
    'SCOPE_FULLMGMT_SALES_TAX',
    'ENTITY_FORMATION_EIN',
    'ENTITY_ANNUAL_REPORT',
    'SPEC_TAX_PLANNING',
    'DEPOSIT_BUSINESS_TAX',
  ]) {
    assert.ok(codes.includes(expected), `${expected} should be flagged needs_confirmation`);
  }
});

test('a conflict Brian RESOLVED is seeded at the ruled price, unflagged', async () => {
  // ACCT_SEMI_ANNUAL was the $900 / $800 / $1,000 conflict. Brian ruled $1,000
  // all-in on 2026-08-09. The seed carries the ruling, so this asserts the
  // decision rather than the pending state it replaced — and it would fail if a
  // future seed edit quietly moved the price back to a sheet value.
  const { rows } = await client.query(`
    SELECT i.amount_cents, i.unit, i.needs_confirmation, i.confirmation_note
    FROM price_book_items i
    JOIN price_book_versions v ON v.id = i.version_id AND v.version_number = 1
    WHERE i.item_code = 'ACCT_SEMI_ANNUAL'
  `);
  assert.equal(rows.length, 1, 'ACCT_SEMI_ANNUAL must be seeded');
  assert.equal(rows[0].amount_cents, 100000, "Brian's ruling: $1,000 all-in");
  assert.equal(rows[0].unit, 'per_6_months');
  assert.equal(rows[0].needs_confirmation, false, 'a ruled price is not still pending');
  assert.equal(rows[0].confirmation_note, null, 'and carries no leftover conflict note');
});

test('re-seeding can never un-confirm a price a human confirmed', async () => {
  // The seed upserts v1 with DO UPDATE, which used to include
  // `needs_confirmation = EXCLUDED.needs_confirmation`. That meant every deploy
  // re-flagged any item Brian had confirmed in Admin → Pricing: his decision
  // silently reverted, and the ⚠ badge reappeared on a price he had already
  // ruled on. This test pins the fix.
  await client.query('BEGIN');
  try {
    const v1 = await client.query(`SELECT id FROM price_book_versions WHERE version_number = 1`);
    // Simulate the admin confirm endpoint on a still-flagged item.
    const target = await client.query(
      `UPDATE price_book_items SET needs_confirmation = false, confirmation_note = NULL
       WHERE version_id = $1 AND item_code = 'IND_CPA_LETTER' RETURNING item_code`,
      [v1.rows[0].id]
    );
    assert.equal(target.rows.length, 1);

    const { seedPriceBook } = await import('../seeds/data/price_book.mjs');
    await seedPriceBook(client);

    const after = await client.query(
      `SELECT needs_confirmation, confirmation_note FROM price_book_items
       WHERE version_id = $1 AND item_code = 'IND_CPA_LETTER'`,
      [v1.rows[0].id]
    );
    assert.equal(after.rows[0].needs_confirmation, false, 're-seeding must not re-flag a confirmed price');
    assert.equal(after.rows[0].confirmation_note, null, 'nor restore the resolved conflict note');
  } finally {
    await client.query('ROLLBACK');
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

test('legal package v3: final text seeded, nothing active still a placeholder', async () => {
  // This test used to assert the OPPOSITE — that the engagement letter and both
  // §7216 consents were flagged PLACEHOLDER awaiting Brian's attorney. v3 FINAL
  // landed, so the launch-gate assertion inverts: the gate is now that no ACTIVE
  // template is a placeholder, and the retired letters keep their flag and their
  // reason for the record.
  const active = await client.query(
    `SELECT key FROM templates WHERE is_placeholder AND is_active ORDER BY key`
  );
  assert.deepEqual(active.rows.map((r) => r.key), [], 'no active template may be a placeholder');

  const legal = await client.query(`
    SELECT key, kind::text AS kind, is_active, needs_es_review, body_es IS NOT NULL AS has_spanish
    FROM templates
    WHERE key IN ('engagement_master', 'consent_7216_use', 'consent_7216_disclose')
    ORDER BY key
  `);
  assert.equal(legal.rows.length, 3, 'the Master + both §7216 consents must be seeded');
  for (const row of legal.rows) {
    assert.equal(row.is_active, true, `${row.key} must be active`);
    // English controls until Brian approves a translation, so ES is deliberately
    // absent-and-queued rather than machine-translated.
    assert.equal(row.needs_es_review, true, `${row.key} must be queued for Spanish approval`);
    assert.equal(row.has_spanish, false, `${row.key} must not ship unapproved Spanish`);
  }
  assert.equal(legal.rows.find((r) => r.key === 'engagement_master').kind, 'master');

  const schedules = await client.query(
    `SELECT s.schedule_code, t.is_active FROM service_schedules s
     JOIN templates t ON t.key = s.template_key ORDER BY s.schedule_code`
  );
  // F joined when the attest schedule landed.
  assert.deepEqual(schedules.rows.map((r) => r.schedule_code), ['A', 'B', 'C', 'D', 'E', 'F']);
  for (const row of schedules.rows) assert.equal(row.is_active, true);

  const retired = await client.query(
    `SELECT key, retired_reason FROM templates
     WHERE key LIKE 'engagement_letter_%' AND NOT is_active`
  );
  assert.equal(retired.rows.length, 5, 'the five old letters are retired, not deleted');
  for (const row of retired.rows) {
    assert.ok(row.retired_reason, `${row.key} must record WHY it was retired`);
  }
});

test('the late-fee disclosure lives on the Master, and nowhere else', async () => {
  const { rows } = await client.query(
    `SELECT key FROM templates WHERE has_late_fee_disclosure AND is_active`
  );
  assert.deepEqual(
    rows.map((r) => r.key), ['engagement_master'],
    'the fee job reads this stamp — exactly one active template may carry it'
  );
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
