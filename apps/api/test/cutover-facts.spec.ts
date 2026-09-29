/*
 * R90 (Brian, 2026-09-29): THE TRELLO CUTOVER FACTS, and the internal task ladder.
 *
 *   · sales_tax_status = client_self_files: no sales-tax engagement, no hold, no frequency; the fact
 *     lands on the business (or the contact, for a person with no business row), never over a value
 *     a person set; a live engagement the card contradicts is left alone and one task goes to Rene.
 *   · card_last_activity before 2026-09-21 writes "books current through" unconfirmed, with one task
 *     per business to the bookkeeper; an unconfirmed import never replaces a value that is not itself
 *     unconfirmed; the Confirm / Correct door clears it, audited before and after, and closes the task.
 *   · both fields absent: the import reads as it always has.
 *   · the internal task ladder: a typed internal task is due in five business days; three business
 *     days past due raises one CEO alert; a client to-do is not on it.
 *
 * Synthetic data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeContact, makeStaff, businessFor, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import type { AuthedStaff } from '../src/types.ts';
import { applyBooksCurrentThrough, applyRecurringServiceFact, salesTaxStatusOf } from '../src/modules/engagements/import-facts.ts';
import { createEngagement } from '../src/modules/engagements/service.ts';
import { createTask, runInternalTaskLadderJob } from '../src/modules/tasks/service.ts';
import { addBusinessDays, addDays, businessDaysAfter, todayChicago } from '../src/modules/tax/deadlines.ts';

let app: FastifyInstance;
let config: Config;
let ceo: TestStaff & { token: string };
let marian: TestStaff & { token: string };
let rene: TestStaff & { token: string };
let importer: AuthedStaff;
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name: `Synthetic ${role}`, role, password: `${role}-password-123456`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

before(async () => {
  // The business page reads the flag; its switch is on here, as it is in production.
  config = { ...(await createTestConfig('cutover_facts')), OPS_BUSINESS_PAGE: 'on' };
  app = buildServer(config, {});
  await app.ready();
  ceo = await staffWithToken('ceo-cutover@example.test', 'ceo');
  marian = await staffWithToken('marian-cutover@example.test', 'bookkeeper');
  rene = await staffWithToken('rene-cutover@example.test', 'comms_billing');
  importer = { id: ceo.id, email: ceo.email, fullName: `${ceo.fullName} (cutover rehearsal, synthetic)`, roleKey: 'ceo', permissions: [], sessionId: 'synthetic' };
});

after(async () => {
  await app.close();
});

let seq = 0;
async function client(): Promise<{ contactId: string; businessId: string }> {
  seq++;
  const c = await makeContact(app.db, { firstName: 'Cutover', lastName: `Client${seq}`, email: `cutover.client${seq}@example.test` });
  return { contactId: c.id, businessId: await businessFor(app.db, c.id) };
}
const salesTax = (who: { contactId: string; businessId: string | null }, values: Record<string, unknown>, cardLastActivity: string | null = null) =>
  applyRecurringServiceFact(app, importer, {
    factType: 'sales_tax', sourceId: `st-cut-${seq}-${Math.random().toString(36).slice(2, 8)}`, matchKey: 'CUTOVER CLIENT', asOf: '2026-09-25',
    appliedBy: importer.fullName, sourceTag: 'synthetic-bundle', contactId: who.contactId, businessId: who.businessId, values, cardLastActivity,
  });
const salesTaxEngagements = async (contactId: string) =>
  (await app.db.query(`SELECT id, filing_frequency FROM engagements WHERE contact_id = $1 AND service_line = 'sales_tax'`, [contactId])).rows;

test('sales_tax_status: absent reads firm_files; client_self_files is read; anything else is refused', () => {
  assert.equal(salesTaxStatusOf({}), 'firm_files');
  assert.equal(salesTaxStatusOf({ sales_tax_status: 'client_self_files' }), 'client_self_files');
  assert.throws(() => salesTaxStatusOf({ sales_tax_status: 'client files' }), /unknown_sales_tax_status|not a sales_tax_status/);
});

test('client_self_files: no engagement, no hold, no frequency; the fact on the business, or the contact with no business; a rerun does nothing', async () => {
  const biz = await client();
  const r = await salesTax(biz, { frequency: 'quarterly', sales_tax_status: 'client_self_files' }, '2026-09-24');
  assert.equal(r.outcome, 'self_files');
  assert.deepEqual(await salesTaxEngagements(biz.contactId), [], 'no sales-tax engagement is created for a client who files their own ST-1');
  const b = await app.db.query<{ by: string; as_of: string }>(`SELECT sales_tax_filed_by::text AS by, sales_tax_filed_by_as_of::text AS as_of FROM businesses WHERE id = $1`, [biz.businessId]);
  assert.deepEqual(b.rows[0], { by: 'client', as_of: '2026-09-25' });
  const ledger = await app.db.query<{ card_last_activity: string }>(`SELECT card_last_activity::text FROM service_fact_imports WHERE business_id = $1`, [biz.businessId]);
  assert.equal(ledger.rows[0]!.card_last_activity, '2026-09-24', 'the card\'s activity day is on the ledger');

  const person = await client();
  const p = await salesTax({ contactId: person.contactId, businessId: null }, { sales_tax_status: 'client_self_files' });
  assert.equal(p.outcome, 'self_files', 'a self-filer needs no frequency');
  const c = await app.db.query<{ by: string }>(`SELECT sales_tax_filed_by::text AS by FROM contacts WHERE id = $1`, [person.contactId]);
  assert.equal(c.rows[0]!.by, 'client', 'a person with no business row carries it on the contact');

  // A closed card still wins: nothing written.
  const closed = await client();
  const x = await salesTax(closed, { frequency: 'monthly', sales_tax_status: 'client_self_files', closed_or_not_client: true });
  assert.equal(x.outcome, 'closed');
});

test('client_self_files against a live engagement: nothing changes on it, one task to Rene with its SOP, due in five business days', async () => {
  const who = await client();
  const e = await createEngagement(app, importer, { contactId: who.contactId, businessId: who.businessId, serviceLine: 'sales_tax', title: 'Sales tax filings', status: 'active', periodKey: 'ongoing', origin: { via: 'staff', reason: 'Synthetic: a person opened this engagement in SAOS.' } }, {});
  await app.db.query(`UPDATE engagements SET filing_frequency = 'monthly' WHERE id = $1`, [e.id]);
  const r = await salesTax(who, { frequency: 'quarterly', sales_tax_status: 'client_self_files' });
  assert.equal(r.outcome, 'self_files_conflict');
  const after = await app.db.query<{ status: string; filing_frequency: string; billing_hold: boolean }>(
    `SELECT status::text, filing_frequency, billing_hold FROM engagements WHERE id = $1`, [e.id]
  );
  assert.deepEqual(after.rows[0], { status: 'active', filing_frequency: 'monthly', billing_hold: false }, 'the engagement is as it was');
  const t = await app.db.query<{ assigned_staff_id: string; due_date: string; sop_link: string | null }>(
    `SELECT assigned_staff_id, due_date::text AS due_date, sop_link FROM tasks WHERE source_type = 'trello_sales_tax_filer_conflict' AND engagement_id = $1`, [e.id]
  );
  assert.equal(t.rows.length, 1);
  assert.equal(t.rows[0]!.assigned_staff_id, rene.id, 'the conflict task is Rene\'s');
  assert.equal(t.rows[0]!.due_date, addBusinessDays(todayChicago(), 5), 'due in five business days');
  assert.match(t.rows[0]!.sop_link ?? '', /rene-trello-sales-tax-filer-conflict/);
  const biz = await app.db.query<{ by: string }>(`SELECT sales_tax_filed_by::text AS by FROM businesses WHERE id = $1`, [who.businessId]);
  assert.equal(biz.rows[0]!.by, 'unknown', 'nothing written while a person has not decided');
});

test('books current through: a card untouched since before 2026-09-21 writes it unconfirmed with a task; it never replaces a confirmed value; the door confirms, audited, and closes the task', async () => {
  const who = await client();
  const u = await applyBooksCurrentThrough(app, { businessId: who.businessId, through: '2025-06-30', asOf: '2026-09-25', cardLastActivity: '2026-09-10', sourceId: `bk-${seq}`, contactId: who.contactId });
  assert.deepEqual(u, { written: 1, unconfirmed: true, taskRaised: true });
  const task = await app.db.query<{ assigned_staff_id: string; status: string }>(`SELECT assigned_staff_id, status::text FROM tasks WHERE source_type = 'trello_confirm_books_through' AND business_id = $1`, [who.businessId]);
  assert.equal(task.rows[0]!.assigned_staff_id, marian.id, 'the bookkeeper role\'s task');

  // The page reads it flagged, with the door for the bookkeeper.
  const page = await app.inject({ method: 'GET', url: `/businesses/${who.businessId}`, headers: auth(marian) });
  assert.equal(page.statusCode, 200, page.body);
  assert.equal(page.json().serviceFacts.books.unconfirmed, true);
  assert.equal(page.json().serviceFacts.books.canConfirm, true);

  // A person's confirmed value is never replaced by an unconfirmed import.
  const kept = await client();
  await app.db.query(`UPDATE businesses SET books_current_through = '2026-08-31', books_current_through_as_of = '2026-09-26' WHERE id = $1`, [kept.businessId]);
  const k = await applyBooksCurrentThrough(app, { businessId: kept.businessId, through: '2025-06-30', asOf: '2026-09-25', cardLastActivity: '2026-09-01', sourceId: `bk-kept-${seq}`, contactId: kept.contactId });
  assert.equal(k.written, 0);
  const kv = await app.db.query<{ through: string; unconfirmed: boolean }>(`SELECT books_current_through::text AS through, books_current_through_unconfirmed AS unconfirmed FROM businesses WHERE id = $1`, [kept.businessId]);
  assert.deepEqual(kv.rows[0], { through: '2026-08-31', unconfirmed: false });

  // Touched on or after 2026-09-21, or no activity day at all: confirmed, as the import always wrote it.
  const fresh = await client();
  assert.deepEqual(await applyBooksCurrentThrough(app, { businessId: fresh.businessId, through: '2026-08-31', asOf: '2026-09-25', cardLastActivity: '2026-09-22', sourceId: `bk-f-${seq}`, contactId: fresh.contactId }), { written: 1, unconfirmed: false, taskRaised: false });
  const bare = await client();
  assert.deepEqual(await applyBooksCurrentThrough(app, { businessId: bare.businessId, through: '2026-08-31', asOf: '2026-09-19', cardLastActivity: null, sourceId: `bk-b-${seq}`, contactId: bare.contactId }), { written: 1, unconfirmed: false, taskRaised: false });

  // The door: a preparer is refused; the bookkeeper corrects; audited before and after; the task closes.
  const prep = await staffWithToken(`prep-cutover-${seq}@example.test`, 'tax_preparer');
  const refused = await app.inject({ method: 'POST', url: `/businesses/${who.businessId}/books-current-through`, headers: auth(prep), payload: { action: 'confirm' } });
  assert.equal(refused.statusCode, 403, refused.body);
  const fixed = await app.inject({ method: 'POST', url: `/businesses/${who.businessId}/books-current-through`, headers: auth(marian), payload: { action: 'correct', month: '2025-09' } });
  assert.equal(fixed.statusCode, 200, fixed.body);
  const now = await app.db.query<{ through: string; unconfirmed: boolean }>(`SELECT books_current_through::text AS through, books_current_through_unconfirmed AS unconfirmed FROM businesses WHERE id = $1`, [who.businessId]);
  assert.deepEqual(now.rows[0], { through: '2025-09-30', unconfirmed: false });
  const audit = await app.db.query<{ details: { before: { through: string; unconfirmed: boolean }; after: { through: string } } }>(
    `SELECT details FROM audit_log WHERE action = 'business.books_current_through_corrected' AND object_id = $1`, [who.businessId]
  );
  assert.equal(audit.rows[0]!.details.before.through, '2025-06-30');
  assert.equal(audit.rows[0]!.details.before.unconfirmed, true);
  assert.equal(audit.rows[0]!.details.after.through, '2025-09-30');
  const closed = await app.db.query<{ status: string }>(`SELECT status::text FROM tasks WHERE source_type = 'trello_confirm_books_through' AND business_id = $1`, [who.businessId]);
  assert.equal(closed.rows[0]!.status, 'completed', 'the confirm task completes');
  const again = await app.inject({ method: 'POST', url: `/businesses/${who.businessId}/books-current-through`, headers: auth(marian), payload: { action: 'confirm' } });
  assert.equal(again.statusCode, 409, 'nothing left to confirm');
});

test('the internal task ladder: a typed internal task is due in five business days; three business days past due raises one CEO alert; a client to-do is not on it', async () => {
  const who = await client();
  const today = todayChicago();
  const t = await createTask(app, { title: 'Synthetic internal task', sourceType: 'close_cycle', sourceId: `ladder-${seq}`, businessId: who.businessId });
  const due = await app.db.query<{ due_date: string }>(`SELECT due_date::text AS due_date FROM tasks WHERE id = $1`, [t.id]);
  assert.equal(due.rows[0]!.due_date, addBusinessDays(today, 5));
  const untyped = await createTask(app, { title: 'Synthetic personal to-do' });
  const ud = await app.db.query<{ due_date: string | null }>(`SELECT due_date::text AS due_date FROM tasks WHERE id = $1`, [untyped.id]);
  assert.equal(ud.rows[0]!.due_date, null, 'a person\'s own untyped to-do keeps no date');

  // The boundary itself: the most recent day that is exactly three business days past, and the one two past.
  const dueBusinessDaysAgo = (n: number): string => {
    let d = today;
    while (businessDaysAfter(d, today) < n) d = addDays(d, -1);
    return d;
  };
  const late = await createTask(app, { title: 'Synthetic late internal task', sourceType: 'close_cycle', sourceId: `ladder-late-${seq}`, dueDate: dueBusinessDaysAgo(3) });
  const fresh = await createTask(app, { title: 'Synthetic fresh internal task', sourceType: 'close_cycle', sourceId: `ladder-fresh-${seq}`, dueDate: dueBusinessDaysAgo(2) });
  const clientTodo = await createTask(app, { title: 'Synthetic client to-do', sourceType: 'close_cycle', sourceId: `ladder-client-${seq}`, dueDate: '2026-01-02', clientVisible: true, contactId: who.contactId });
  const run = await runInternalTaskLadderJob(app, today);
  assert.ok(run.alerted >= 1);
  const alerts = async (id: string) => (await app.db.query(`SELECT 1 FROM notifications WHERE type = 'internal_task_overdue' AND related_object_id = $1 AND staff_id = $2`, [id, ceo.id])).rows.length;
  assert.equal(await alerts(late.id), 1, 'the CEO is alerted');
  assert.equal(await alerts(fresh.id), 0, 'two business days past due is not yet an alert');
  assert.equal(await alerts(clientTodo.id), 0, 'a client to-do is on the client ladder, not this one');
  await runInternalTaskLadderJob(app, today);
  assert.equal(await alerts(late.id), 1, 'once per task');
  const outbox = await app.db.query(`SELECT 1 FROM outbox WHERE created_at > now() - interval '1 minute'`).catch(() => ({ rows: [] }));
  assert.equal(outbox.rows.length, 0, 'the ladder never contacts a client');
});
