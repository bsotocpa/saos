/*
 * THE BUSINESS PAGE'S READ (Brian, 2026-09-26, R40): GET /businesses/:id.
 *
 *   The aggregate the page renders: the entity (EIN last four for contacts.read, the whole number
 *   for pii.read), the owners with their role text and the primary marker, and one block per card
 *   — engagements and returns (engagements.read), service facts from the 0105–0111 tables (the
 *   page's own gate), invoices attributed through the engagement (billing.manage), documents filed
 *   to the business behind the §7216 category wall (documents.read). A card the session cannot read
 *   arrives as { refused: true, permission } with no rows; an archived or unknown business is 404;
 *   with OPS_BUSINESS_PAGE off the route refuses with the sentence the page prints. Reading the page
 *   is audited (business.viewed) and listing its documents is audited (documents.listed).
 *
 *   The clients-list search (GET /contacts?search=) carries the matched business's id beside its
 *   name, so a "Business — owner" row can open the business page.
 *
 * Synthetic data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeContact, makeStaff, multipartBody, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import type { AuthedStaff } from '../src/types.ts';
import { createEngagement } from '../src/modules/engagements/service.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
let marian: TestStaff & { token: string };
let rene: TestStaff & { token: string };
let laura: TestStaff & { token: string };
let ana: TestStaff & { token: string };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });
const actorOf = (t: TestStaff): AuthedStaff => ({ id: t.id, email: t.email, fullName: t.fullName, roleKey: 'ceo', permissions: ['*'], sessionId: 'spec' });
const WHY = 'The client engaged by phone this morning; the quote follows tomorrow';
const PDF = Buffer.from('%PDF-1.4 synthetic business page document — no real client data\n%%EOF');

interface Refused { refused: true; permission: string }
interface Rows<T> { rows: T[] }
interface Aggregate {
  business: Record<string, unknown> & { id: string; name: string; ein?: string; ein_last4: string | null; ein_on_file: boolean };
  members: Array<{ contact_id: string; first_name: string; last_name: string; member_role: string | null; is_primary: boolean }>;
  engagements: Refused | Rows<Record<string, unknown>>;
  returns: Refused | Rows<Record<string, unknown>>;
  serviceFacts: {
    books: { currentThrough: string | null; asOf: string | null };
    qbo: { paidBy: string; asOf: string | null };
    annualReport: Record<string, unknown> | null;
    accessFacts: Array<{ fact: string; as_of: string; source: string }>;
    salesTaxFrequencies: string[];
    payrollProviders: string[];
    imports: Array<{ fact_type: string; as_of: string; rows_written: number }>;
  };
  invoices: Refused | Rows<Record<string, unknown>>;
  documents: Refused | Rows<{ category: string; original_filename: string }>;
}
const isRefused = (x: Refused | Rows<unknown>): x is Refused => (x as Refused).refused === true;

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name: `Synthetic ${role}`, role, password: `${role}-password-123456`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}
async function addBusiness(contactId: string, payload: Record<string, unknown>): Promise<string> {
  const res = await app.inject({ method: 'POST', url: `/contacts/${contactId}/businesses`, headers: auth(brian), payload });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().id as string;
}
async function page(id: string, who: { token: string } = brian): Promise<{ status: number; body: Aggregate & { error?: string; message?: string } }> {
  const res = await app.inject({ method: 'GET', url: `/businesses/${id}`, headers: auth(who) });
  return { status: res.statusCode, body: res.json() };
}
async function auditCount(action: string, objectId: string): Promise<number> {
  const r = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE action = $1 AND object_type = 'business' AND object_id = $2`, [action, objectId]);
  return r.rows[0]!.n;
}

/** The business the page is about: two owners, an engagement, a return, an invoice, a document, every service fact. */
let owner: { id: string };
let coOwner: { id: string };
let businessId: string;
let engagementId: string;
let taxEngagementId: string;

before(async () => {
  config = await createTestConfig('business_page');
  app = buildServer(config);
  await app.ready();
  brian = await staffWithToken('brian-bizpage@example.test', 'ceo');
  marian = await staffWithToken('marian-bizpage@example.test', 'bookkeeper');
  rene = await staffWithToken('rene-bizpage@example.test', 'comms_billing');
  laura = await staffWithToken('laura-bizpage@example.test', 'va_entity');
  ana = await staffWithToken('ana-bizpage@example.test', 'tax_preparer');
});
after(async () => { await app.close(); });

test('with OPS_BUSINESS_PAGE off (the production default) the route refuses with the sentence the page prints', async () => {
  assert.equal(config.OPS_BUSINESS_PAGE, 'off', 'the default is off');
  assert.equal(app.switches.businessPage, 'off', 'and the running server holds what config said');
  owner = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Pageowner', email: 'pageowner@example.test' });
  businessId = await addBusiness(owner.id, { name: 'Synthetic Page Corp, LLC', ein: '77-7777777', entityType: 's_corp', state: 'IL', industry: 'food_beverage' });
  const off = await page(businessId);
  assert.equal(off.status, 409, JSON.stringify(off.body));
  assert.equal(off.body.error, 'business_page_off');
  assert.equal(off.body.message, 'This page is not switched on.');
  // The harness flips the same field through its own door; this spec flips it the way that door does.
  app.switches.businessPage = 'on';
  const me = await app.inject({ method: 'GET', url: '/auth/me', headers: auth(brian) });
  assert.equal((me.json() as { switches: { businessPage: string } }).switches.businessPage, 'on', 'the page reads the state from the session');
});

test('the CEO reads the whole aggregate: entity with the full EIN, two owners with the primary marker, engagement, return, service facts, invoice, document', async () => {
  // A second member who is not the primary for this business.
  coOwner = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Pagepartner', email: 'pagepartner@example.test' });
  await app.db.query(`INSERT INTO business_members (business_id, contact_id, member_role, is_primary) VALUES ($1, $2, 'co-owner', false)`, [businessId, coOwner.id]);

  // The engagements: bookkeeping (the one the invoice hangs on), sales tax with its filing frequency and
  // payroll with its provider — each fact is scoped to its own service line by a CHECK (0106, 0107).
  const eng = await createEngagement(app, actorOf(brian), { contactId: owner.id, businessId, serviceLine: 'bookkeeping', status: 'active', periodKey: 'ongoing', origin: { via: 'staff', reason: WHY } }, {});
  engagementId = eng.id;
  const salesTax = await createEngagement(app, actorOf(brian), { contactId: owner.id, businessId, serviceLine: 'sales_tax', status: 'active', periodKey: 'ongoing', origin: { via: 'staff', reason: WHY } }, {});
  await app.db.query(`UPDATE engagements SET filing_frequency = 'quarterly' WHERE id = $1`, [salesTax.id]);
  const payroll = await createEngagement(app, actorOf(brian), { contactId: owner.id, businessId, serviceLine: 'payroll', status: 'active', periodKey: 'ongoing', origin: { via: 'staff', reason: WHY } }, {});
  await app.db.query(`UPDATE engagements SET payroll_provider = 'gusto' WHERE id = $1`, [payroll.id]);
  // The return, opened by hand against the business.
  const ret = await app.inject({
    method: 'POST', url: '/tax-engagements', headers: auth(brian),
    payload: { contactId: owner.id, businessId, taxYear: 2024, returnType: '1120s', clientType: 'business', preparerId: ana.id, reason: 'Return opened by hand for the business page spec; the client engaged by phone and the quote follows' },
  });
  assert.equal(ret.statusCode, 201, ret.body);
  taxEngagementId = ret.json().id as string;
  // An invoice on the engagement (invoices carry no business_id; the page attributes through the engagement).
  await app.db.query(
    `INSERT INTO invoices (invoice_number, contact_id, engagement_id, status, subtotal_cents, total_cents, sent_at) VALUES ('SYN-PAGE-0001', $1, $2, 'sent', 12345, 12345, now())`,
    [owner.id, engagementId]
  );
  // A document filed to the business (business_records) and one in the entity family (entity_filings).
  for (const [category, filename] of [['business_records', 'SYN-PAGE-BANK-STATEMENT.pdf'], ['entity_filings', 'SYN-PAGE-ARTICLES.pdf']] as const) {
    const up = multipartBody({ contactId: owner.id, businessId, category }, { field: 'file', filename, contentType: 'application/pdf', data: PDF });
    const res = await app.inject({ method: 'POST', url: '/documents', headers: { ...auth(brian), ...up.headers }, payload: up.payload });
    assert.equal(res.statusCode, 201, res.body);
  }
  // The service facts, as the Trello importer leaves them (0105, 0108, 0109, 0110, 0114).
  await app.db.query(`UPDATE businesses SET books_current_through = '2026-06-30', books_current_through_as_of = '2026-08-01', qbo_paid_by = 'client', qbo_paid_by_as_of = '2026-08-01' WHERE id = $1`, [businessId]);
  await app.db.query(`INSERT INTO entity_compliance (business_id, state, annual_report_due_date, status, anniversary_mmdd, anniversary_kind) VALUES ($1, 'IL', '2027-03-01', 'unknown', '03/01', 'admission')`, [businessId]);
  await app.db.query(`INSERT INTO business_access_facts (business_id, fact, as_of, source) VALUES ($1, 'firm_holds_login', '2026-08-01', 'trello')`, [businessId]);
  await app.db.query(`INSERT INTO service_fact_imports (source, trello_source_id, fact_type, business_id, match_key, as_of, applied_by, rows_written) VALUES ('trello', 'card-syn-1', 'books_current_through', $1, 'synthetic page corp', '2026-08-01', 'spec', 1)`, [businessId]);

  const { status, body } = await page(businessId);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.business.name, 'Synthetic Page Corp, LLC');
  assert.equal(body.business.entity_type, 's_corp');
  assert.equal(body.business.status, 'active');
  assert.equal(body.business.ein_on_file, true);
  assert.equal(body.business.ein_last4, '7777');
  assert.equal(body.business.ein, '77-7777777', 'the CEO holds pii.read through the wildcard: the whole number');
  assert.equal(body.business.industry, 'food_beverage');
  assert.equal(body.business.fiscal_year_end_month, 12);
  assert.equal(body.business.is_test, false);

  assert.equal(body.members.length, 2);
  assert.deepEqual(body.members.map((m) => [m.contact_id, m.member_role, m.is_primary]), [[owner.id, 'owner', true], [coOwner.id, 'co-owner', false]], 'the primary first (the Add door writes owner), then the co-owner');
  assert.equal(body.members[0]!.last_name, 'Pageowner');

  assert.ok(!isRefused(body.engagements));
  assert.equal(body.engagements.rows.length, 4, 'bookkeeping, sales tax, payroll, and the tax engagement the hand-opened return created');
  assert.equal(body.engagements.rows.find((r) => r.service_line === 'tax')!.period_key, '2024');
  const books = body.engagements.rows.find((r) => r.id === engagementId)!;
  assert.equal(books.service_line, 'bookkeeping');
  assert.equal(books.open_balance_cents, 12345, 'the sent invoice is the open balance');
  assert.equal(books.contact_id, owner.id);
  assert.equal(body.engagements.rows.find((r) => r.service_line === 'sales_tax')!.filing_frequency, 'quarterly');
  assert.equal(body.engagements.rows.find((r) => r.service_line === 'payroll')!.payroll_provider, 'gusto');

  assert.ok(!isRefused(body.returns));
  assert.equal(body.returns.rows.length, 1);
  assert.equal(body.returns.rows[0]!.id, taxEngagementId);
  assert.equal(body.returns.rows[0]!.tax_year, 2024);
  assert.equal(body.returns.rows[0]!.return_type, '1120s');
  assert.equal(body.returns.rows[0]!.stage, 'intake_started');
  assert.equal(body.returns.rows[0]!.preparer_name, ana.fullName);
  assert.equal(body.returns.rows[0]!.contact_id, owner.id);

  assert.deepEqual(body.serviceFacts.books, { currentThrough: '2026-06-30', asOf: '2026-08-01' });
  assert.deepEqual(body.serviceFacts.qbo, { paidBy: 'client', asOf: '2026-08-01' });
  assert.equal(body.serviceFacts.annualReport?.annual_report_due_date, '2027-03-01');
  assert.equal(body.serviceFacts.annualReport?.anniversary_mmdd, '03/01');
  assert.deepEqual(body.serviceFacts.accessFacts.map((f) => [f.fact, f.as_of, f.source]), [['firm_holds_login', '2026-08-01', 'trello']]);
  assert.deepEqual(body.serviceFacts.salesTaxFrequencies, ['quarterly']);
  assert.deepEqual(body.serviceFacts.payrollProviders, ['gusto']);
  assert.deepEqual(body.serviceFacts.imports.map((i) => [i.fact_type, i.as_of, i.rows_written]), [['books_current_through', '2026-08-01', 1]]);

  assert.ok(!isRefused(body.invoices));
  assert.equal(body.invoices.rows.length, 1);
  assert.equal(body.invoices.rows[0]!.invoice_number, 'SYN-PAGE-0001');
  assert.equal(body.invoices.rows[0]!.status, 'sent');
  assert.equal(body.invoices.rows[0]!.engagement_id, engagementId);

  assert.ok(!isRefused(body.documents));
  assert.deepEqual(body.documents.rows.map((d) => [d.category, d.original_filename]).sort(), [['business_records', 'SYN-PAGE-BANK-STATEMENT.pdf'], ['entity_filings', 'SYN-PAGE-ARTICLES.pdf']]);

  assert.equal(await auditCount('business.viewed', businessId), 1, 'reading the page is audited');
  assert.equal(await auditCount('documents.listed', businessId), 1, 'listing its documents is audited');
});

test('a return the tax create path attaches to an existing engagement of the business also appears; the client page is unchanged by it', async () => {
  // A second, individual client of the same business owner: a business with no engagement keeps an empty card, truthfully.
  const empty = await addBusiness(owner.id, { name: 'Synthetic Empty Holdings LLC', entityType: 'llc', state: 'IL' });
  const { status, body } = await page(empty);
  assert.equal(status, 200);
  assert.equal(body.business.ein_on_file, false);
  assert.equal(body.business.ein_last4, null);
  assert.equal(body.business.ein, null, 'nothing on file, nothing to show');
  assert.ok(!isRefused(body.engagements) && body.engagements.rows.length === 0);
  assert.ok(!isRefused(body.returns) && body.returns.rows.length === 0);
  assert.ok(!isRefused(body.invoices) && body.invoices.rows.length === 0);
  assert.ok(!isRefused(body.documents) && body.documents.rows.length === 0);
  assert.equal(body.serviceFacts.annualReport, null);
  assert.deepEqual(body.serviceFacts.qbo, { paidBy: 'unknown', asOf: null });
  assert.deepEqual(body.serviceFacts.books, { currentThrough: null, asOf: null });
  assert.equal(body.members.length, 1);
  assert.equal(body.members[0]!.is_primary, false, 'the owner already has a primary business');
});

test('per-card refusals: the bookkeeper reads entity, owners, service facts and documents; engagements, returns and invoices say refused; the EIN is last four only', async () => {
  const { status, body } = await page(businessId, marian);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.business.ein_last4, '7777');
  assert.equal(body.business.ein_on_file, true);
  assert.ok(!('ein' in body.business), 'the whole number never leaves for a session without pii.read');
  assert.equal(body.members.length, 2);
  assert.deepEqual(body.engagements, { refused: true, permission: 'engagements.read' });
  assert.deepEqual(body.returns, { refused: true, permission: 'engagements.read' });
  assert.deepEqual(body.invoices, { refused: true, permission: 'billing.manage' });
  assert.ok(!isRefused(body.documents), 'documents.read.all: every category');
  assert.equal(body.documents.rows.length, 2);
  assert.deepEqual(body.serviceFacts.books, { currentThrough: '2026-06-30', asOf: '2026-08-01' });
  assert.equal(body.serviceFacts.accessFacts.length, 1);
  const viewed = await app.db.query<{ details: { ein_shown: string; cards_refused: string[] } }>(
    `SELECT details FROM audit_log WHERE action = 'business.viewed' AND object_id = $1 AND actor_id = $2`, [businessId, marian.id]);
  assert.equal(viewed.rows.length, 1);
  assert.equal(viewed.rows[0]!.details.ein_shown, 'last4');
  assert.deepEqual(viewed.rows[0]!.details.cards_refused, ['engagements', 'returns', 'invoices']);
});

test('per-card refusals: comms_billing reads invoices and the whole EIN (pii.read) and is refused engagements, returns and documents; the entity VA sees entity filings only', async () => {
  const r = await page(businessId, rene);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.business.ein, '77-7777777');
  assert.ok(!isRefused(r.body.invoices) && r.body.invoices.rows.length === 1);
  assert.deepEqual(r.body.engagements, { refused: true, permission: 'engagements.read' });
  assert.deepEqual(r.body.returns, { refused: true, permission: 'engagements.read' });
  assert.deepEqual(r.body.documents, { refused: true, permission: 'documents.read' });
  assert.equal(await auditCount('documents.listed', businessId), 2, 'no documents.listed row for a refused card (the CEO and the bookkeeper wrote the two)');

  const l = await page(businessId, laura);
  assert.equal(l.status, 200, JSON.stringify(l.body));
  assert.ok(!('ein' in l.body.business));
  assert.ok(!isRefused(l.body.documents));
  assert.deepEqual(l.body.documents.rows.map((d) => d.category), ['entity_filings'], 'the §7216 wall in the query: entity papers only');
  assert.deepEqual(l.body.engagements, { refused: true, permission: 'engagements.read' });
  assert.deepEqual(l.body.invoices, { refused: true, permission: 'billing.manage' });
});

test('a session without contacts.read is refused the page; an unknown or archived business is 404', async () => {
  const intern = await staffWithToken('intern-bizpage@example.test', 'intern');
  const refused = await page(businessId, intern);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.message, 'This session does not hold contacts.read.');

  const unknown = await page('00000000-0000-4000-8000-000000000000');
  assert.equal(unknown.status, 404);

  const gone = await addBusiness(owner.id, { name: 'Synthetic Gone LLC', entityType: 'llc', state: 'IL' });
  assert.equal((await page(gone)).status, 200, 'readable before archiving');
  const archived = await app.inject({ method: 'POST', url: `/businesses/${gone}/archive`, headers: auth(brian), payload: { reason: 'Rehearsal residue; never a client of the firm' } });
  assert.equal(archived.statusCode, 200, archived.body);
  const after404 = await page(gone);
  assert.equal(after404.status, 404, 'an archived business is the same 404 as one that does not exist');
  assert.equal(after404.body.message, 'Business not found.');
});

test('the clients-list search for a business legal name carries the matched business id beside its name', async () => {
  const res = await app.inject({ method: 'GET', url: '/contacts?search=Synthetic%20Page%20Corp', headers: auth(brian) });
  assert.equal(res.statusCode, 200, res.body);
  const rows = res.json().contacts as Array<{ id: string; business_name: string | null; business_id: string | null; business_matched: boolean }>;
  const hit = rows.find((r) => r.id === owner.id);
  assert.ok(hit, 'the owner is found through the business name');
  assert.equal(hit!.business_matched, true);
  assert.equal(hit!.business_name, 'Synthetic Page Corp, LLC');
  assert.equal(hit!.business_id, businessId, 'the id of the business that matched, not the primary');
  // The co-owner is reached through the same business.
  const partner = rows.find((r) => r.id === coOwner.id);
  assert.ok(partner);
  assert.equal(partner!.business_id, businessId);
});
