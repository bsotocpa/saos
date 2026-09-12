// REASON TEXT IS WRITTEN FOR THE NEXT READER (2026-09-12, Brian's standing rule): a reason that
// cites a conversation, a ruling number, a migration, a rehearsal or a bare record id is refused
// at the door, with a message that says what to write instead. Staff reasons only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { conversationArtifact } from '../src/reasons.ts';
import { createInvoice } from '../src/modules/billing/service.ts';
import { createEngagement } from '../src/modules/engagements/service.ts';

let app: FastifyInstance;
let config: Config;
let ceo: TestStaff;
let token = '';
const CEO_TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const totp = () => new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(CEO_TOTP) }).generate();
const auth = () => ({ authorization: `Bearer ${token}` });

before(async () => {
  config = await createTestConfig('reasons');
  const mailer: Mailer = { transport: 'console', async send() { return { id: 'x' }; } };
  app = buildServer(config, { mailer });
  await app.ready();
  ceo = await makeStaff(app.db, config, { email: 'reasons-ceo@example.test', name: 'Synthetic CEO', role: 'ceo', password: 'ceo-password-12345678', totpSecret: CEO_TOTP });
  const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: ceo.email, password: ceo.password, totp: totp() } });
  token = r.json().token;
});
after(async () => { await app.close(); });

test('the shapes that were actually written are named, and honest reasons pass', () => {
  const refused = [
    'duplicate accept — superseded by 6e474b1f (Brian\'s ruling 1)',
    'per our chat, void this',
    'as discussed on the call',
    'Duplicate acceptance (migration 0061).',
    'duplicate accept — rehearsal 2026-09-09',
    'overnight batch cleanup',
    'see decision 3',
    'canonical quote e0acf123-f82b-4ce5-9a2c-abd3c73e1196',
  ];
  for (const r of refused) assert.ok(conversationArtifact(r), `should refuse: ${r}`);

  const fine = [
    'Withdrawn: this quote was accepted twice for the same service line. The engagement from the first acceptance carries the work.',
    'Client paid by check on 2026-09-11, invoice 12345678 cleared.',   // pure digits are not an id
    'IL SOS file # 72224825 restored',
    'Superseded by the corrected invoice issued today.',
    'Client is travelling until October.',
  ];
  for (const r of fine) assert.equal(conversationArtifact(r), null, `should allow: ${r}`);
});

test('a void with a ruling number in the reason is refused at the route, and the invoice stays sent', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Reasons', email: 'reasons@example.test' });
  const e = await createEngagement(app, { id: ceo.id, email: ceo.email, fullName: ceo.fullName, roleKey: 'ceo', permissions: ['*'], sessionId: 't' }, { contactId: c.id, serviceLine: 'bookkeeping', title: 'Books', status: 'active' }, {});
  const inv = await createInvoice(app, { type: 'staff', id: ceo.id, label: ceo.fullName }, { contactId: c.id, engagementId: e.id, lines: [{ description: 'Books — month', unitCents: 100 }], send: false, issued: true });

  const bad = await app.inject({ method: 'POST', url: `/invoices/${inv.id}/void`, headers: auth(), payload: { reason: 'superseded by 6e474b1f (Brian\'s ruling 1)' } });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.match(bad.body, /whoever reads this next/);
  const still = await app.db.query<{ status: string }>(`SELECT status::text AS status FROM invoices WHERE id = $1`, [inv.id]);
  assert.equal(still.rows[0]!.status, 'sent', 'nothing moved');

  const good = await app.inject({ method: 'POST', url: `/invoices/${inv.id}/void`, headers: auth(), payload: { reason: 'Superseded by the corrected invoice issued today.' } });
  assert.equal(good.statusCode, 200, good.body);
});
