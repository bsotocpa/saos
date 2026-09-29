// R97 (Brian, 2026-09-29): SAME-NAME PAIRS WITHOUT A SPREADSHEET. The pass archives the empty record
// of a name-only pair with a redirect (audited "Empty duplicate from the Dubsado migration", no merge),
// and puts every other pair on both client pages as a banner; Compare reads them side by side; Not a
// duplicate dismisses with a reason (audited, banner gone on both); Merge is the R92 pair door and
// closes the suggestion. Protected names and pairs sharing an identifier are never read. Synthetic only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { createTask } from '../src/modules/tasks/service.ts';

let app: FastifyInstance;
let config: Config;
let ceo: TestStaff & { token: string };
let rene: TestStaff & { token: string };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name: `Synthetic ${role}`, role, password: `${role}-password-1234567`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}
let n = 0;
async function person(first: string, last: string, holds: boolean): Promise<string> {
  n++;
  const c = await makeContact(app.db, { firstName: first, lastName: last, email: `samename${n}@example.test` });
  if (holds) await createTask(app, { title: `Synthetic work for ${first} ${last}`, contactId: c.id });
  return c.id;
}
const contact = (id: string) => app.inject({ method: 'GET', url: `/contacts/${id}`, headers: auth(ceo) }).then((r) => r.json());

before(async () => {
  config = await createTestConfig('same_name');
  app = buildServer(config);
  await app.ready();
  ceo = await staffWithToken('ceo-samename@example.test', 'ceo');
  rene = await staffWithToken('rene-samename@example.test', 'comms_billing');
});

after(async () => {
  await app.close();
});

test('the pass: an empty record is archived with a redirect, not merged; both empty keeps the older; the rest become banners; protected names and shared identifiers are never read', async () => {
  const kept = await person('Synthetic', 'Emptypair', true);
  const empty = await person('Synthetic', 'Emptypair', false);
  const olderEmpty = await person('Synthetic', 'Bothempty', false);
  const newerEmpty = await person('Synthetic', 'Bothempty', false);
  const f1 = await person('Synthetic', 'Fullpair', true);
  const f2 = await person('Synthetic', 'Fullpair', true);
  const p1 = await person('Jackson', 'Flores', true);
  const p2 = await person('Jackson', 'Flores', false);
  const s1 = await person('Synthetic', 'Sharedmail', true);
  const s2 = await person('Synthetic', 'Sharedmail', false);
  await app.db.query(`UPDATE contacts SET email = 'shared-samename@example.test' WHERE id = ANY($1::uuid[])`, [[s1, s2]]);

  const refused = await app.inject({ method: 'POST', url: '/contacts/same-name/resolve', headers: auth(rene), payload: { apply: true } });
  assert.equal(refused.statusCode, 403, 'the pass is the CEO\'s');
  const dry = await app.inject({ method: 'POST', url: '/contacts/same-name/resolve', headers: auth(ceo), payload: { apply: false } });
  assert.equal(dry.statusCode, 200, dry.body);
  assert.deepEqual({ e: dry.json().empty_archived, b: dry.json().both_empty_newer_archived, s: dry.json().suggested }, { e: 1, b: 1, s: 1 });
  assert.equal((await contact(empty)).contact?.id, empty, 'the count wrote nothing');

  const run = await app.inject({ method: 'POST', url: '/contacts/same-name/resolve', headers: auth(ceo), payload: { apply: true } });
  assert.deepEqual({ e: run.json().empty_archived, b: run.json().both_empty_newer_archived, s: run.json().suggested }, { e: 1, b: 1, s: 1 });
  assert.deepEqual(await contact(empty), { merged_into: kept }, 'the empty record redirects to the other');
  assert.deepEqual(await contact(newerEmpty), { merged_into: olderEmpty }, 'both empty: the newer goes');
  const audit = await app.db.query<{ details: { reason: string; merged: boolean } }>(`SELECT details FROM audit_log WHERE action = 'contact.archived' AND object_id = $1`, [empty]);
  assert.equal(audit.rows[0]!.details.reason, 'Empty duplicate from the Dubsado migration');
  assert.equal(audit.rows[0]!.details.merged, false);
  const merged = await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'contact.merged' AND object_id = $1`, [empty]);
  assert.equal(merged.rows.length, 0, 'no merge');
  for (const id of [f1, f2]) assert.equal((await contact(id)).possibleDuplicates.length, 1, 'a banner on both pages');
  for (const id of [p1, p2, s1, s2]) assert.deepEqual((await contact(id)).possibleDuplicates, [], 'protected names and shared identifiers are not this pass\'s');
  assert.equal((await contact(p2)).contact?.id, p2, 'a protected record is never archived by the pass');

  const again = await app.inject({ method: 'POST', url: '/contacts/same-name/resolve', headers: auth(ceo), payload: { apply: true } });
  assert.deepEqual({ e: again.json().empty_archived, s: again.json().suggested, a: again.json().already_suggested }, { e: 0, s: 0, a: 1 }, 'a second pass changes nothing');
});

test('Compare and Not a duplicate: side by side, dismissed with a reason, audited, the banner gone from both; Merge closes the suggestion', async () => {
  const d1 = await person('Synthetic', 'Dismisspair', true);
  const d2 = await person('Synthetic', 'Dismisspair', true);
  const m1 = await person('Synthetic', 'Mergepairr', true);
  const m2 = await person('Synthetic', 'Mergepairr', true);
  await app.inject({ method: 'POST', url: '/contacts/same-name/resolve', headers: auth(ceo), payload: { apply: true } });
  const sugg = (await contact(d1)).possibleDuplicates[0];
  assert.equal(sugg.otherId, d2);
  const cmp = await app.inject({ method: 'GET', url: `/contacts/duplicate-suggestions/${sugg.suggestionId}/compare`, headers: auth(rene) });
  assert.equal(cmp.statusCode, 200, cmp.body);
  for (const k of ['email', 'phone', 'businesses', 'engagements', 'lastActivity', 'portalUser']) assert.ok(k in cmp.json().a && k in cmp.json().b, `compare shows ${k}`);
  const noReason = await app.inject({ method: 'POST', url: `/contacts/duplicate-suggestions/${sugg.suggestionId}/dismiss`, headers: auth(rene), payload: { reason: 'no' } });
  assert.equal(noReason.statusCode, 400);
  const ok = await app.inject({ method: 'POST', url: `/contacts/duplicate-suggestions/${sugg.suggestionId}/dismiss`, headers: auth(rene), payload: { reason: 'Two brothers with one name; different addresses on file.' } });
  assert.equal(ok.statusCode, 200, ok.body);
  for (const id of [d1, d2]) assert.deepEqual((await contact(id)).possibleDuplicates, [], 'the banner is gone from both');
  const audit = await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'contact.duplicate_dismissed' AND details->>'suggestion_id' = $1`, [sugg.suggestionId]);
  assert.equal(audit.rows.length, 1);

  const ms = (await contact(m1)).possibleDuplicates[0];
  const merge = await app.inject({ method: 'POST', url: '/contacts/merge-pair', headers: auth(ceo), payload: { aId: m1, bId: m2, reason: 'One person recorded twice by the Dubsado onboarding.', identityOverrideReason: 'One person recorded twice by the Dubsado onboarding.' } });
  assert.equal(merge.statusCode, 200, merge.body);
  const st = await app.db.query<{ status: string }>(`SELECT status::text FROM contact_duplicate_suggestions WHERE id = $1`, [ms.suggestionId]);
  assert.equal(st.rows[0]!.status, 'merged');
  assert.deepEqual((await contact(merge.json().survivorId)).possibleDuplicates, [], 'no banner once merged');
});
