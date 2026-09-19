/*
 * CONTACT MERGE AND THE ARCHIVED INVARIANT (2026-09-12, Brian: "Don't archive. Merge.").
 * Two records for one person: every row the loser holds moves to the winner, one audit row per
 * object; the loser is archived pointing at the winner with nothing left on it; active work on
 * both sides for the same line, period and entity is a conflict and refuses; an archived contact
 * cannot hold active work, at the database. The orphan scan reads the catalog, so a table the
 * merge forgets is found, not skipped. Synthetic data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import type { AuthedStaff } from '../src/types.ts';
import { createEngagement } from '../src/modules/engagements/service.ts';
import { createInvoice } from '../src/modules/billing/service.ts';
import { createTask } from '../src/modules/tasks/service.ts';
import { contactReferences } from '../src/modules/crm/merge.ts';
import { deriveLifecycle } from '../src/modules/crm/lifecycle.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
let rene: TestStaff & { token: string };
let laura: TestStaff & { token: string };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name: `Synthetic ${role}`, role, password: `${role}-password-123456`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}
const actorOf = (t: TestStaff): AuthedStaff => ({ id: t.id, email: t.email, fullName: t.fullName, roleKey: 'ceo', permissions: ['*'], sessionId: 'spec' });

before(async () => {
  config = await createTestConfig('merge');
  app = buildServer(config);
  await app.ready();
  brian = await staffWithToken('brian-merge@example.test', 'ceo');
  rene = await staffWithToken('rene-merge@example.test', 'comms_billing');
  laura = await staffWithToken('laura-merge@example.test', 'va_entity');
});
after(async () => { await app.close(); });

/** A record with something in most of the tables a person accumulates. */
async function populated(last: string, email: string) {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: last, email });
  const biz = await app.inject({ method: 'POST', url: `/contacts/${c.id}/businesses`, headers: auth(brian), payload: { name: `${last} Holdings LLC`, entityType: 'llc' } });
  assert.equal(biz.statusCode, 201, biz.body);
  const eng = await createEngagement(app, actorOf(brian), { contactId: c.id, serviceLine: 'bookkeeping', title: 'Books', status: 'active', periodKey: 'ongoing' }, {});
  const item = await app.db.query<{ amount_cents: number }>(`SELECT pbi.amount_cents FROM price_book_items pbi WHERE pbi.is_active AND pbi.amount_cents > 0 ORDER BY pbi.amount_cents LIMIT 1`);
  const inv = await createInvoice(app, { type: 'staff', id: brian.id, label: brian.fullName }, { contactId: c.id, engagementId: eng.id, lines: [{ description: 'Books', unitCents: item.rows[0]!.amount_cents }], send: false, issued: true });
  const doc = await app.db.query<{ id: string }>(
    `INSERT INTO documents (contact_id, category, filename, minio_bucket, minio_key, uploaded_by_type) VALUES ($1, 'business_records', $2, 'saos-documents', $3, 'staff') RETURNING id`,
    [c.id, `${last}-statement.pdf`, `test/${last}.pdf`]);
  const task = await createTask(app, { title: `Call ${last}`, contactId: c.id, priority: 1, source: 'manual' });
  const pu = await app.db.query<{ id: string }>(`INSERT INTO portal_users (contact_id, email) VALUES ($1, $2) RETURNING id`, [c.id, email]);
  await app.db.query(`INSERT INTO consents (contact_id, type, status, method, policy_version, signed_at) VALUES ($1, 'sms', 'signed', 'intake_checkbox', 'v1', now())`, [c.id]);
  return { id: c.id, businessId: (biz.json() as { id: string }).id, engagementId: eng.id, invoiceId: inv.id, documentId: doc.rows[0]!.id, taskId: task.id, portalUserId: pu.rows[0]!.id };
}

test('merge: every row moves to the winner, one audit row per object, the loser is archived pointing at the winner with nothing left', async () => {
  const winner = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Winner', email: 'winner@example.test' });
  const loser = await populated('Loser', 'loser@example.test');
  const before = await contactReferences(app, loser.id);
  // Creating the business raised an enrichment task too, so tasks is at least one.
  assert.ok(before.engagements === 1 && before.invoices === 1 && before.documents === 1 && (before.tasks ?? 0) >= 1 && before.portal_users === 1 && before.business_members === 1 && before.consents === 1, JSON.stringify(before));

  const refused = await app.inject({ method: 'POST', url: `/contacts/${winner.id}/merge`, headers: auth(laura), payload: { loserIds: [loser.id], reason: 'The same person was imported twice from Dubsado.', identityOverrideReason: 'The client confirmed both records are theirs; the import gave each a different address' } });
  assert.equal(refused.statusCode, 403, 'Laura does not hold billing.manage');
  const res = await app.inject({ method: 'POST', url: `/contacts/${winner.id}/merge`, headers: auth(rene), payload: { loserIds: [loser.id], reason: 'The same person was imported twice from Dubsado.', identityOverrideReason: 'The client confirmed both records are theirs; the import gave each a different address' } });
  assert.equal(res.statusCode, 200, res.body);
  const r = res.json() as { losers: Array<{ moved: Record<string, number> }> };
  assert.equal(r.losers[0]!.moved.engagements, 1);
  assert.equal(r.losers[0]!.moved.portal_users, 1, 'the winner had no sign-in, so the loser\'s moved');

  assert.deepEqual(await contactReferences(app, loser.id), {}, 'nothing anywhere still points at the loser, the append-only audit log excepted');
  const history = await app.db.query<{ n: string }>(`SELECT count(*) AS n FROM audit_log WHERE contact_id = $1`, [loser.id]);
  assert.ok(Number(history.rows[0]!.n) > 0, 'the loser\'s audit history stays as written (append-only), reachable through merged_into');
  const after = await contactReferences(app, winner.id);
  assert.ok(after.engagements === 1 && after.invoices === 1 && after.documents === 1 && (after.tasks ?? 0) >= 1 && after.portal_users === 1 && after.business_members === 1 && after.consents === 1, JSON.stringify(after));
  const l = await app.db.query<{ is_archived: boolean; contact_status: string; merged_into_contact_id: string; archived_reason: string }>(
    `SELECT is_archived, contact_status::text AS contact_status, merged_into_contact_id, archived_reason FROM contacts WHERE id = $1`, [loser.id]);
  assert.equal(l.rows[0]!.is_archived, true);
  assert.equal(l.rows[0]!.contact_status, 'archived');
  assert.equal(l.rows[0]!.merged_into_contact_id, winner.id);
  assert.match(l.rows[0]!.archived_reason, /Merged into the record for Synthetic Winner/);

  const perObject = await app.db.query<{ object_type: string; n: string }>(
    `SELECT object_type, count(*) AS n FROM audit_log WHERE action = 'contact.merged_object' AND details->>'from' = $1 GROUP BY 1 ORDER BY 1`, [loser.id]);
  const counts = Object.fromEntries(perObject.rows.map((x) => [x.object_type, Number(x.n)]));
  for (const t of ['engagements', 'invoices', 'documents', 'business_members', 'consents', 'portal_user']) assert.equal(counts[t], 1, `one audit row for the ${t}`);
  assert.equal(counts.tasks, before.tasks, 'one audit row per task moved');
  assert.equal((await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'contact.merged' AND object_id = $1`, [loser.id])).rows.length, 1);
  const status = await app.db.query<{ contact_status: string }>(`SELECT contact_status::text AS contact_status FROM contacts WHERE id = $1`, [winner.id]);
  // The lifecycle is derived from events (a bookkeeping engagement with no accepted quote or signature is still a lead); what matters is that it was re-derived after the merge.
  assert.equal(status.rows[0]!.contact_status, await deriveLifecycle(app, winner.id), 'the winner\'s lifecycle is re-derived from what it now holds');
});

test('two sign-ins: the winner\'s stays, the loser\'s is retired on the record; a sign-in that signed a packet cannot be', async () => {
  const w = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Twologinsw', email: 'twologinsw@example.test' });
  const l = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Twologinsl', email: 'twologinsl@example.test' });
  await app.db.query(`INSERT INTO portal_users (contact_id, email) VALUES ($1, $2)`, [w.id, w.email]);
  const lpu = await app.db.query<{ id: string }>(`INSERT INTO portal_users (contact_id, email) VALUES ($1, $2) RETURNING id`, [l.id, l.email]);
  const res = await app.inject({ method: 'POST', url: `/contacts/${w.id}/merge`, headers: auth(brian), payload: { loserIds: [l.id], reason: 'The same person signed up twice with two addresses.', identityOverrideReason: 'The client confirmed both records are theirs; the import gave each a different address' } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((res.json() as { losers: Array<{ portalUserRetired: boolean }> }).losers[0]!.portalUserRetired, true);
  assert.equal((await app.db.query(`SELECT 1 FROM portal_users WHERE id = $1`, [lpu.rows[0]!.id])).rows.length, 0, 'the second sign-in is gone');
  assert.equal((await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'contact.merged_portal_user_retired' AND object_id = $1`, [lpu.rows[0]!.id])).rows.length, 1);
  assert.deepEqual(await contactReferences(app, l.id), {});
});

test('merge refuses active work on both sides for the same line, period and entity; a different entity is fine', async () => {
  const a = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Conflicta', email: 'conflicta@example.test' });
  const b = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Conflictb', email: 'conflictb@example.test' });
  await createEngagement(app, actorOf(brian), { contactId: a.id, serviceLine: 'bookkeeping', title: 'Books', status: 'active', periodKey: 'ongoing' }, {});
  await createEngagement(app, actorOf(brian), { contactId: b.id, serviceLine: 'bookkeeping', title: 'Books', status: 'active', periodKey: 'ongoing' }, {});
  const res = await app.inject({ method: 'POST', url: `/contacts/${a.id}/merge`, headers: auth(brian), payload: { loserIds: [b.id], reason: 'The same person was imported twice from Dubsado.', identityOverrideReason: 'The client confirmed both records are theirs; the import gave each a different address' } });
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().error, 'merge_conflict');
  assert.equal((await app.db.query<{ is_archived: boolean }>(`SELECT is_archived FROM contacts WHERE id = $1`, [b.id])).rows[0]!.is_archived, false, 'nothing changed');
});

test('the archived invariant, at the database: no active work on an archived contact, and no archiving a contact with active work', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Archivable', email: 'archivable@example.test' });
  const eng = await createEngagement(app, actorOf(brian), { contactId: c.id, serviceLine: 'bookkeeping', title: 'Books', status: 'active', periodKey: 'ongoing' }, {});
  await assert.rejects(() => app.db.query(`UPDATE contacts SET is_archived = true WHERE id = $1`, [c.id]), /archived_contact_active_engagement/);
  await assert.rejects(() => app.db.query(`UPDATE contacts SET contact_status = 'archived', archived_reason = 'test' WHERE id = $1`, [c.id]), /archived_contact_active_engagement/);
  await app.db.query(`UPDATE engagements SET status = 'completed', ended_on = CURRENT_DATE WHERE id = $1`, [eng.id]);
  await app.db.query(`UPDATE contacts SET is_archived = true, contact_status = 'archived', archived_reason = 'test: closed out' WHERE id = $1`, [c.id]);
  await assert.rejects(
    () => app.db.query(`INSERT INTO engagements (contact_id, service_line, status, title) VALUES ($1, 'bookkeeping', 'active', 'late work')`, [c.id]),
    /archived_contact_active_engagement/
  );
  await assert.rejects(() => app.db.query(`UPDATE engagements SET status = 'active' WHERE id = $1`, [eng.id]), /archived_contact_active_engagement/);
});

test('the reason validator refuses the assistant as a reason; a waiver reason is amended, never edited', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Amend', email: 'amend@example.test' });
  const item = await app.db.query<{ amount_cents: number }>(`SELECT pbi.amount_cents FROM price_book_items pbi WHERE pbi.is_active AND pbi.amount_cents > 0 ORDER BY pbi.amount_cents LIMIT 1`);
  const inv = await createInvoice(app, { type: 'staff', id: brian.id, label: brian.fullName }, { contactId: c.id, lines: [{ description: 'Paid elsewhere', unitCents: item.rows[0]!.amount_cents }], send: false, issued: true });
  const { markInvoicePaid } = await import('../src/modules/billing/service.ts');
  await markInvoicePaid(app, inv.id, { paymentIntentId: 'pi_synthetic_amend' });
  await createTask(app, { title: 'Stripe cannot verify', contactId: c.id, priority: 2, source: 'automation', sourceType: 'stripe_drift', sourceId: inv.id });
  const bad = await app.inject({ method: 'POST', url: `/invoices/${inv.id}/waive-stripe-check`, headers: auth(brian), payload: { reason: 'idk claude code told me to' } });
  assert.equal(bad.statusCode, 400, 'who suggested it is not the reason');
  const ok = await app.inject({ method: 'POST', url: `/invoices/${inv.id}/waive-stripe-check`, headers: auth(brian), payload: { reason: 'Paid under the test key; the live key cannot see it.' } });
  assert.equal(ok.statusCode, 200, ok.body);
  const nothingToAmend = await app.inject({ method: 'POST', url: `/invoices/${inv.id}/waiver-amendments`, headers: auth(brian), payload: { body: 'Claude said so' } });
  assert.equal(nothingToAmend.statusCode, 400, 'the amendment is a reason too');
  const amended = await app.inject({ method: 'POST', url: `/invoices/${inv.id}/waiver-amendments`, headers: auth(brian), payload: { body: 'The payment was taken on 2026-08-13 under the Stripe test key, per our chat; the live key has no record of it.' } });
  assert.equal(amended.statusCode, 400, 'and a pointer into a conversation is still an artifact, even here ("rehearsal" is a word, since 2026-09-19)');
  const amended2 = await app.inject({ method: 'POST', url: `/invoices/${inv.id}/waiver-amendments`, headers: auth(brian), payload: { body: 'The payment was taken on 2026-08-13 under the Stripe test key while the pay link was being proven; the live key has no record of it.' } });
  assert.equal(amended2.statusCode, 201, amended2.body);
  const row = await app.db.query<{ reason: string }>(`SELECT stripe_check_waived_reason AS reason FROM invoices WHERE id = $1`, [inv.id]);
  assert.equal(row.rows[0]!.reason, 'Paid under the test key; the live key cannot see it.', 'the original is untouched');
  const list = await app.inject({ method: 'GET', url: `/invoices?contactId=${c.id}`, headers: auth(brian) });
  const amendments = (list.json() as { invoices: Array<{ waiver_amendments: Array<{ body: string; by: string }> }> }).invoices[0]!.waiver_amendments;
  assert.equal(amendments.length, 1);
  assert.match(amendments[0]!.body, /test key while the pay link/);
  assert.equal((await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'reason.amended' AND object_id = $1`, [inv.id])).rows.length, 1);
});
