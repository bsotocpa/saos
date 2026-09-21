/*
 * THE QUOTES CARD'S DOORS (Brian, 2026-09-20).
 *
 *   The list behind the card carries who and which business a quote is for, its lines by code, when
 *   it was sent and when it expires. Copy client link reads the stored link back (0117) and changes
 *   nothing; only a quote sent before the link was kept rotates once. Resend goes through the one send site with a fresh
 *   link and another email; a transport failure puts the earlier link back so the record stays true.
 *   Every door is quotes.manage (seeded to the preparer) or engagements.tax.manage; a role holding
 *   neither is refused at each one.
 *
 * Synthetic data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;
let ana: TestStaff & { token: string };
let marian: TestStaff & { token: string };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

/** The mailer remembers every proposal link it carried, and can be told to fail like a dead transport. */
const links: string[] = [];
let transportDown = false;
const mailer: Mailer = {
  transport: 'console',
  async send(msg) {
    if (transportDown) throw new Error('the transport refused the message');
    const m = /\/quote\/([A-Za-z0-9_-]{20,})/.exec(`${msg.text ?? ''} ${msg.html ?? ''}`);
    if (m) links.push(m[1]!);
    return { id: 'silent' };
  },
};

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name: `Synthetic ${role}`, role, password: `${role}-password-123456`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

async function aSentQuote(tag: string): Promise<{ contactId: string; businessId: string; quoteId: string; token: string }> {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: `Card${tag}`, email: `card-${tag.toLowerCase()}@example.test` });
  const biz = await app.inject({ method: 'POST', url: `/contacts/${c.id}/businesses`, headers: auth(ana), payload: { name: `Synthetic Card ${tag} LLC`, entityType: 's_corp', state: 'IL' } });
  assert.equal(biz.statusCode, 403, 'the preparer does not add businesses; the route is not hers');
  const bizByCeo = await app.db.query<{ id: string }>(`INSERT INTO businesses (name, entity_type, state) VALUES ($1, 's_corp', 'IL') RETURNING id`, [`Synthetic Card ${tag} LLC`]);
  await app.db.query(`INSERT INTO business_members (business_id, contact_id, member_role, is_primary) VALUES ($1, $2, 'owner', true)`, [bizByCeo.rows[0]!.id, c.id]);
  const created = await app.inject({ method: 'POST', url: '/quotes', headers: auth(ana), payload: { contactId: c.id, businessId: bizByCeo.rows[0]!.id, lines: [{ itemCode: 'BIZ_1120S' }], expiresInDays: 30 } });
  assert.equal(created.statusCode, 201, created.body);
  const quoteId = created.json().id as string;
  const sent = await app.inject({ method: 'POST', url: `/quotes/${quoteId}/send`, headers: auth(ana) });
  assert.equal(sent.statusCode, 200, sent.body);
  return { contactId: c.id, businessId: bizByCeo.rows[0]!.id, quoteId, token: sent.json().token as string };
}

const opens = async (token: string): Promise<number> => (await app.inject({ method: 'GET', url: `/public/quote/${token}` })).statusCode;

before(async () => {
  config = await createTestConfig('quotescard');
  app = buildServer(config, { mailer });
  await app.ready();
  ana = await staffWithToken('ana-card@example.test', 'tax_preparer');
  marian = await staffWithToken('marian-card@example.test', 'bookkeeper');
});
after(async () => { await app.close(); });

test('the seed grants quotes.manage to the preparer, and the list carries who, which business, the lines, sent and expiry', async () => {
  const grants = await app.db.query<{ permission: string }>(`SELECT p.permission FROM role_permissions p JOIN roles r ON r.id = p.role_id WHERE r.key = 'tax_preparer'`);
  assert.ok(grants.rows.some((g) => g.permission === 'quotes.manage'), 'the preparer holds quotes.manage');
  assert.ok(!(await app.db.query<{ permission: string }>(`SELECT p.permission FROM role_permissions p JOIN roles r ON r.id = p.role_id WHERE r.key = 'bookkeeper'`)).rows.some((g) => g.permission === 'quotes.manage'), 'the bookkeeper does not');

  const q = await aSentQuote('List');
  const list = await app.inject({ method: 'GET', url: `/contacts/${q.contactId}/quotes`, headers: auth(ana) });
  assert.equal(list.statusCode, 200, list.body);
  const row = (list.json().quotes as Array<Record<string, unknown>>).find((r) => r.id === q.quoteId)!;
  assert.equal(row.status, 'sent');
  assert.equal(row.for_name, 'Synthetic CardList');
  assert.equal(row.business_name, 'Synthetic Card List LLC');
  assert.deepEqual(row.line_codes, ['BIZ_1120S'], 'the lines in short form: the price-book codes');
  assert.ok(Array.isArray(row.line_names) && (row.line_names as string[]).length === 1, 'and their names, for a reader who does not know the codes');
  assert.ok(row.sent_at, 'when it was sent');
  assert.ok(row.expires_at, 'and when it expires');

  // The Ops quote page reads the business by name from the one detail read, never a second fetch.
  const detail = await app.inject({ method: 'GET', url: `/quotes/${q.quoteId}`, headers: auth(ana) });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().quote.business_name, 'Synthetic Card List LLC');
});

test('Copy client link is passive: the stored link is read back, the emailed link keeps working, nothing rotates; a draft has no link', async () => {
  const q = await aSentQuote('Copy');
  assert.equal(await opens(q.token), 200, 'the emailed link opens');
  assert.equal(links.at(-1), q.token, 'and it is the one the mailer carried');

  const copied = await app.inject({ method: 'POST', url: `/quotes/${q.quoteId}/client-link`, headers: auth(ana), payload: {} });
  assert.equal(copied.statusCode, 200, copied.body);
  assert.equal(copied.json().rotated, false, 'nothing was reissued');
  assert.equal((copied.json().url as string).split('/').pop(), q.token, 'the copy IS the emailed link');
  assert.equal(await opens(q.token), 200, 'which still opens');
  const rotated = await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'quote.link_rotated' AND object_id = $1`, [q.quoteId]);
  assert.equal(rotated.rows.length, 0, 'no rotation on the record');
  const copiedAudit = await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'quote.link_copied' AND object_id = $1`, [q.quoteId]);
  assert.equal(copiedAudit.rows.length, 1, 'the copy is audited');
  // Only the hash and the encrypted copy are at rest: the plaintext is in neither column.
  const at = await app.db.query<{ public_token_hash: string; enc: string }>(`SELECT public_token_hash, encode(client_token_enc, 'base64') AS enc FROM quotes WHERE id = $1`, [q.quoteId]);
  assert.notEqual(at.rows[0]!.public_token_hash, q.token);
  assert.ok(!at.rows[0]!.enc.includes(q.token), 'the encrypted copy is not the token');

  const draft = await app.inject({ method: 'POST', url: '/quotes', headers: auth(ana), payload: { contactId: q.contactId, businessId: q.businessId, lines: [{ itemCode: 'BIZ_1120S' }] } });
  const noLink = await app.inject({ method: 'POST', url: `/quotes/${draft.json().id}/client-link`, headers: auth(ana), payload: {} });
  assert.equal(noLink.statusCode, 409, noLink.body);
  assert.equal(noLink.json().error, 'not_open');
});

test('a quote sent before the link was kept has nothing to read: Copy rotates once, says so, and the emailed link stops working', async () => {
  const q = await aSentQuote('Legacy');
  // The state a quote sent before 0117 is in: a hash and no encrypted copy.
  await app.db.query(`UPDATE quotes SET client_token_enc = NULL WHERE id = $1`, [q.quoteId]);

  const copied = await app.inject({ method: 'POST', url: `/quotes/${q.quoteId}/client-link`, headers: auth(ana), payload: {} });
  assert.equal(copied.statusCode, 200, copied.body);
  assert.equal(copied.json().rotated, true, 'a new link was issued, and the control is told');
  const fresh = (copied.json().url as string).split('/').pop()!;
  assert.notEqual(fresh, q.token);
  assert.equal(await opens(fresh), 200, 'the new link opens');
  assert.equal(await opens(q.token), 404, 'the emailed one no longer does');
  assert.ok(!links.includes(fresh), 'copying emails nothing');
  const audit = await app.db.query<{ details: { why: string } }>(`SELECT details FROM audit_log WHERE action = 'quote.link_rotated' AND object_id = $1`, [q.quoteId]);
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0]!.details.why, 'copied');

  // From here on the link is kept: a second copy is passive.
  const again = await app.inject({ method: 'POST', url: `/quotes/${q.quoteId}/client-link`, headers: auth(ana), payload: {} });
  assert.equal(again.json().rotated, false);
  assert.equal((again.json().url as string).split('/').pop(), fresh);
});

test('Resend goes through the one send site with a fresh link; a dead transport puts the earlier link back', async () => {
  const q = await aSentQuote('Resend');
  const before = links.length;

  transportDown = true;
  try {
    const failed = await app.inject({ method: 'POST', url: `/quotes/${q.quoteId}/send`, headers: auth(ana), payload: { resend: true } });
    assert.equal(failed.statusCode, 500, failed.body);
  } finally {
    transportDown = false;
  }
  assert.equal(await opens(q.token), 200, 'the link the client already has still opens after a failed resend');
  assert.equal(links.length, before, 'no new link left the mailer');
  const failedAudit = await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'quote.resend_failed' AND object_id = $1`, [q.quoteId]);
  assert.equal(failedAudit.rows.length, 1, 'the failure is on the record');

  const resent = await app.inject({ method: 'POST', url: `/quotes/${q.quoteId}/send`, headers: auth(ana), payload: { resend: true } });
  assert.equal(resent.statusCode, 200, resent.body);
  assert.equal(links.length, before + 1, 'the client was emailed again');
  assert.equal(links.at(-1), resent.json().token, 'with the fresh link');
  assert.equal(await opens(resent.json().token), 200);
  assert.equal(await opens(q.token), 404, 'the earlier link is retired');
  const status = await app.db.query<{ status: string }>(`SELECT status::text AS status FROM quotes WHERE id = $1`, [q.quoteId]);
  assert.equal(status.rows[0]!.status, 'sent', 'still sent, not sent twice');
  const resentAudit = await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'quote.resent' AND object_id = $1`, [q.quoteId]);
  assert.equal(resentAudit.rows.length, 1);

  // A plain send of a sent quote is still refused: resend is a declared act, not a retry.
  const plain = await app.inject({ method: 'POST', url: `/quotes/${q.quoteId}/send`, headers: auth(ana), payload: {} });
  assert.equal(plain.statusCode, 409);
  assert.equal(plain.json().error, 'already_sent');
});

test('role proof: a session without quotes.manage is refused at every door and told which permission', async () => {
  const q = await aSentQuote('Role');
  for (const [path, payload] of [
    [`/quotes/${q.quoteId}/client-link`, {}],
    [`/quotes/${q.quoteId}/send`, { resend: true }],
    [`/quotes/${q.quoteId}/withdraw-draft`, { reason: 'trying the withdraw door without the grant' }],
  ] as const) {
    const res = await app.inject({ method: 'POST', url: path, headers: auth(marian), payload });
    assert.equal(res.statusCode, 403, `${path}: ${res.body}`);
    assert.equal(res.json().permission, 'quotes.manage');
  }
  assert.equal(await opens(q.token), 200, 'the refused calls changed nothing: the client link still opens');
});
