// M20 "Prove it": price edit → NEW version; old engagements keep the old
// version; the calculator follows the new one. Plus: ⚠ confirmation flow,
// template editing with the placeholder-clearing launch gate (verified by the
// M11 envelope actually becoming sendable), settings with old/new audit, and
// RBAC (non-leadership 403). Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeStaff, auditRows, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
let ana: TestStaff & { token: string };

const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, {
    email, name: `Synthetic ${role}`, role, password: `${role}-password-123456`, totpSecret: secret,
  });
  const code = new OTPAuth.TOTP({
    algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret),
  }).generate();
  const res = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { email, password: staff.password, totp: code },
  });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

before(async () => {
  config = await createTestConfig('adm');
  app = buildServer(config);
  await app.ready();
  brian = await staffWithToken('brian-adm@example.test', 'ceo');
  ana = await staffWithToken('ana-adm@example.test', 'tax_preparer');
});

after(async () => {
  await app.close();
});

test('THE prove-it: price edit → new version; pinned engagements keep v1; calculator follows v2', async () => {
  // An engagement quoted (and pinned) on v1.
  const contact = await app.db.query<{ id: string }>(
    `INSERT INTO contacts (first_name, last_name, email, soto_status)
     VALUES ('Synthetic', 'Grandfathered', 'grandfathered@example.test', 'active') RETURNING id`
  );
  const created = await app.inject({
    method: 'POST', url: '/tax-engagements', headers: auth(ana),
    payload: { contactId: contact.rows[0]!.id, taxYear: 2025, returnType: '1040' },
  });
  const teId = created.json().id as string;
  const quoted = await app.inject({
    method: 'POST', url: `/tax-engagements/${teId}/quote`, headers: auth(ana),
    payload: { items: [{ code: 'IND_BASE_MFJ' }] },
  });
  assert.equal(quoted.statusCode, 200, quoted.body);
  const v1Id = quoted.json().quote.priceBookVersionId as string;
  // v1 range: 20000 … 23000 (15% band).
  assert.deepEqual(quoted.json().quote.revenue.one_time, { minCents: 20000, maxCents: 23000 });

  // RBAC: the preparer cannot touch pricing (spec: "No pricing changes").
  const refused = await app.inject({
    method: 'POST', url: '/admin/price-book/versions', headers: auth(ana),
    payload: { effectiveFrom: '2026-08-01', note: 'nope', changes: [{ itemCode: 'IND_BASE_MFJ', amountCents: 21000 }] },
  });
  assert.equal(refused.statusCode, 403);

  // Brian raises MFJ to $210 effective Aug 1 (future-dated increases work).
  const version = await app.inject({
    method: 'POST', url: '/admin/price-book/versions', headers: auth(brian),
    payload: {
      effectiveFrom: '2026-08-01',
      note: 'August adjustment (synthetic test)',
      changes: [{ itemCode: 'IND_BASE_MFJ', amountCents: 21000 }],
    },
  });
  assert.equal(version.statusCode, 201, version.body);
  assert.equal(version.json().versionNumber, 2);

  // v2 is a full copy: 73 items + 3 bundle rules; only MFJ changed.
  const v2 = await app.db.query<{ id: string }>(`SELECT id FROM price_book_versions WHERE version_number = 2`);
  const counts = await app.db.query(
    `SELECT (SELECT count(*)::int FROM price_book_items WHERE version_id = $1) AS items,
            (SELECT count(*)::int FROM bundle_rules WHERE version_id = $1) AS rules`,
    [v2.rows[0]!.id]
  );
  assert.equal(counts.rows[0].items, 74); // 74th = LATE_FEE_MONTHLY (v4.3 flow 4 rate)
  assert.equal(counts.rows[0].rules, 3);

  const prices = await app.db.query(
    `SELECT v.version_number, i.amount_cents FROM price_book_items i
     JOIN price_book_versions v ON v.id = i.version_id
     WHERE i.item_code = 'IND_BASE_MFJ' ORDER BY v.version_number`
  );
  assert.equal(prices.rows[0].amount_cents, 20000, 'v1 untouched');
  assert.equal(prices.rows[1].amount_cents, 21000, 'v2 carries the new price');

  // The quoted engagement stays pinned to v1 — grandfathering holds.
  const pinned = await app.db.query(
    `SELECT e.price_book_version_id FROM engagements e
     JOIN tax_engagements te ON te.engagement_id = e.id WHERE te.id = $1`,
    [teId]
  );
  assert.equal(pinned.rows[0].price_book_version_id, v1Id);

  // New quotes follow the version in force on their date (v2 from Aug 1).
  const augustQuote = await app.inject({
    method: 'POST', url: '/pricing/quote', headers: auth(ana),
    payload: { items: [{ code: 'IND_BASE_MFJ' }], asOf: '2026-08-02' },
  });
  assert.equal(augustQuote.json().priceBookVersionNumber, 2);
  assert.deepEqual(augustQuote.json().revenue.one_time, { minCents: 21000, maxCents: 24150 });

  assert.ok((await auditRows(app.db, 'price_book.version_created')) >= 1);
});

test('⚠ confirmation queue: confirming a seed conflict clears the flag without a new version', async () => {
  const confirm = await app.inject({
    method: 'POST', url: '/admin/price-book/items/ACCT_SEMI_ANNUAL/confirm', headers: auth(brian),
  });
  assert.equal(confirm.statusCode, 200, confirm.body);
  const row = await app.db.query(
    `SELECT i.needs_confirmation FROM price_book_items i
     JOIN price_book_versions v ON v.id = i.version_id
     WHERE i.item_code = 'ACCT_SEMI_ANNUAL' ORDER BY v.version_number DESC LIMIT 1`
  );
  assert.equal(row.rows[0].needs_confirmation, false);
  assert.ok((await auditRows(app.db, 'price_book.item_confirmed')) >= 1);

  const again = await app.inject({
    method: 'POST', url: '/admin/price-book/items/ACCT_SEMI_ANNUAL/confirm', headers: auth(brian),
  });
  assert.equal(again.statusCode, 404, 'already confirmed');
});

test('template editor: edits bump versions; clearing PLACEHOLDER opens the M11 envelope gate', async () => {
  // A draft engagement-letter envelope blocked by the placeholder gate.
  const contact = await app.db.query<{ id: string }>(
    `INSERT INTO contacts (first_name, last_name, email) VALUES ('Synthetic', 'Gateopen', 'gateopen@example.test') RETURNING id`
  );
  const envelope = await app.inject({
    method: 'POST', url: '/signature-envelopes', headers: auth(ana),
    payload: { contactId: contact.rows[0]!.id, type: 'engagement_letter', serviceLine: 'tax' },
  });
  const envId = envelope.json().id as string;
  const blocked = await app.inject({ method: 'POST', url: `/signature-envelopes/${envId}/send`, headers: auth(ana) });
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().error, 'template_placeholder_blocked');

  // Ana cannot edit templates.
  const refused = await app.inject({
    method: 'PATCH', url: '/admin/templates/engagement_letter_tax', headers: auth(ana),
    payload: { bodyEn: 'nope' },
  });
  assert.equal(refused.statusCode, 403);

  // Brian supplies final text and clears the flag — THE launch-gate action.
  const cleared = await app.inject({
    method: 'PATCH', url: '/admin/templates/engagement_letter_tax', headers: auth(brian),
    payload: {
      bodyEn: 'FINAL ENGAGEMENT LETTER (synthetic legal text) for {{client_name}} — {{service_scope}} at {{fee_summary}}.',
      bodyEs: 'CARTA DE COMPROMISO FINAL (texto legal sintético) para {{client_name}} — {{service_scope}} por {{fee_summary}}.',
      isPlaceholder: false,
    },
  });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.equal(cleared.json().placeholderCleared, true);
  assert.ok((await auditRows(app.db, 'template.placeholder_cleared')) >= 1);

  const template = await app.db.query(
    `SELECT is_placeholder, version FROM templates WHERE key = 'engagement_letter_tax'`
  );
  assert.equal(template.rows[0].is_placeholder, false);
  assert.equal(template.rows[0].version, 2);

  // The envelope now sends — copy change, zero deploy.
  const sends = await app.inject({ method: 'POST', url: `/signature-envelopes/${envId}/send`, headers: auth(ana) });
  assert.equal(sends.statusCode, 200, sends.body);
});

test('settings: value updates carry old/new in the audit trail; unknown keys 404', async () => {
  const updated = await app.inject({
    method: 'PATCH', url: '/admin/settings/sla.doc_request_reminder_days', headers: auth(brian),
    payload: { value: 5 },
  });
  assert.equal(updated.statusCode, 200, updated.body);
  const setting = await app.db.query(
    `SELECT value FROM app_settings WHERE key = 'sla.doc_request_reminder_days'`
  );
  assert.equal(setting.rows[0].value, 5);
  const audit = await app.db.query(
    `SELECT details FROM audit_log WHERE action = 'setting.updated' ORDER BY occurred_at DESC LIMIT 1`
  );
  assert.equal(audit.rows[0].details.from, 3);
  assert.equal(audit.rows[0].details.to, 5);

  const unknown = await app.inject({
    method: 'PATCH', url: '/admin/settings/not.a.real.key', headers: auth(brian),
    payload: { value: 1 },
  });
  assert.equal(unknown.statusCode, 404);
});

test('roles endpoint feeds the staff admin UI', async () => {
  const res = await app.inject({ method: 'GET', url: '/admin/roles', headers: auth(brian) });
  assert.equal(res.statusCode, 200);
  const roles = res.json().roles as Array<{ key: string; permissions: string[] }>;
  assert.equal(roles.length, 10);
  assert.ok(roles.find((r) => r.key === 'tax_preparer')!.permissions.includes('engagements.tax.manage'));
});
