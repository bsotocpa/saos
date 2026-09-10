// AUDIT ITEM 6 (2026-09-09, Brian's ruling): draft quotes show who started them and when; a
// draft older than 30 days is flagged stale (never auto-deleted); a draft is withdrawn with a
// reason, and only a draft. Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { createQuote, sendQuote } from '../src/modules/pricing/quotes.ts';

let app: FastifyInstance;
let config: Config;
let ceo: TestStaff & { token: string };
const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name: `Synthetic ${role}`, role, password: `${role}-password-1234567`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}
const actor = () => ({ id: ceo.id, email: ceo.email, fullName: ceo.fullName, roleKey: 'ceo' as const, permissions: ['*'], sessionId: 'test' });

async function anyItem(): Promise<string> {
  const { rows } = await app.db.query<{ item_code: string }>(
    `SELECT pbi.item_code FROM price_book_items pbi JOIN price_book_versions v ON v.id = pbi.version_id
      WHERE pbi.is_active AND pbi.display_on_quote AND pbi.amount_cents IS NOT NULL
        AND v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)
      ORDER BY pbi.item_code LIMIT 1`);
  return rows[0]!.item_code;
}

before(async () => {
  config = await createTestConfig('quotedrafts');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  ceo = await staffWithToken('ceo-drafts@example.test', 'ceo');
});

after(async () => {
  await app.close();
});

test('the quotes list says who started a draft; 31 days old is stale, 29 is not; withdrawing needs a reason and only takes a draft', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Quotedrafts', email: 'quotedrafts@example.test' });
  await app.db.query(`UPDATE contacts SET soto_status = 'active' WHERE id = $1`, [c.id]);
  const old = await createQuote(app, { contactId: c.id, lines: [{ itemCode: await anyItem() }] }, actor());
  const fresh = await createQuote(app, { contactId: c.id, lines: [{ itemCode: await anyItem() }] }, actor());
  const sentOne = await createQuote(app, { contactId: c.id, lines: [{ itemCode: await anyItem() }] }, actor());
  await sendQuote(app, sentOne.id, actor());
  await app.db.query(`UPDATE quotes SET created_at = now() - interval '31 days' WHERE id = $1`, [old.id]);
  await app.db.query(`UPDATE quotes SET created_at = now() - interval '29 days' WHERE id = $1`, [fresh.id]);

  const list = await app.inject({ method: 'GET', url: `/contacts/${c.id}/quotes`, headers: auth(ceo) });
  assert.equal(list.statusCode, 200, list.body);
  const rows = list.json().quotes as Array<{ id: string; status: string; created_by: string | null; is_stale: boolean }>;
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId[old.id]!.created_by, ceo.fullName, 'who started it — a name, never an email');
  assert.equal(byId[old.id]!.is_stale, true, '31 days: stale');
  assert.equal(byId[fresh.id]!.is_stale, false, '29 days: not yet');
  assert.equal(byId[sentOne.id]!.is_stale, false, 'a sent quote is never "stale" — it is the client\'s to decide on');

  const noReason = await app.inject({ method: 'POST', url: `/quotes/${old.id}/withdraw-draft`, headers: auth(ceo), payload: { reason: 'no' } });
  assert.equal(noReason.statusCode, 400, 'a reason is required');
  const notDraft = await app.inject({ method: 'POST', url: `/quotes/${sentOne.id}/withdraw-draft`, headers: auth(ceo), payload: { reason: 'trying to withdraw a sent quote' } });
  assert.equal(notDraft.statusCode, 409, notDraft.body);
  assert.equal(notDraft.json().error, 'not_a_draft');

  const withdrawn = await app.inject({ method: 'POST', url: `/quotes/${old.id}/withdraw-draft`, headers: auth(ceo), payload: { reason: 'abandoned — the client went with the bundle instead' } });
  assert.equal(withdrawn.statusCode, 200, withdrawn.body);
  const after = (await app.db.query<{ status: string }>(`SELECT status::text AS status FROM quotes WHERE id = $1`, [old.id])).rows[0]!;
  assert.equal(after.status, 'void', 'withdrawn, on the record — not deleted');
  const audit = await app.db.query<{ details: { reason: string }; actor_label: string }>(`SELECT details, actor_label FROM audit_log WHERE action = 'quote.draft_withdrawn' AND object_id = $1`, [old.id]);
  assert.equal(audit.rows.length, 1);
  assert.match(audit.rows[0]!.details.reason, /abandoned/);
  assert.equal(audit.rows[0]!.actor_label, ceo.fullName);
});
