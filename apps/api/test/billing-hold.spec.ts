/*
 * THE BILLING HOLD ON AN IMPORTED ENGAGEMENT (Brian, 2026-09-26, R68).
 *
 *   "Trello-sourced ongoing engagements carry a billing-hold flag checked by every invoice factory,
 *    so no imported sales-tax, payroll or bookkeeping engagement can invoice until Brian lifts the
 *    hold per engagement through an Ops control with a reason."
 *
 * What is proven here, in order:
 *
 *   · the importer's own function (applyRecurringServiceFact) holds every ongoing engagement it
 *     CREATES, with its one sentence, audited; an engagement a person opened in SAOS that the import
 *     merely finds is not held;
 *   · every invoice factory refuses a held engagement: the manual invoice route (POST /invoices), the
 *     deposit path (createInvoice as quote acceptance calls it), the consolidated group invoice, and
 *     the filed-return automation — which COUNTS the refusal (audit row + a task) and lets the filing
 *     through rather than failing the stage move;
 *   · the lift is engagements.billing_hold.lift, explicit-only, seeded to the CEO alone; comms_billing
 *     is refused 403 in the server's words; the reason is reasonText(10, 1000); the lift lands the
 *     moment, the person and the reason together, audited, and the same factory then invoices.
 *
 * Synthetic data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeContact, makeStaff, businessFor, auditRows, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import type { AuthedStaff } from '../src/types.ts';
import { EXPLICIT_ONLY_PERMISSIONS } from '../src/plugins/auth.ts';
import { applyRecurringServiceFact } from '../src/modules/engagements/import-facts.ts';
import { createEngagement } from '../src/modules/engagements/service.ts';
import { createInvoice, invoiceForFiledEngagement } from '../src/modules/billing/service.ts';
import { IMPORT_BILLING_HOLD_REASON, placeBillingHold } from '../src/modules/billing/billing-hold.ts';

let app: FastifyInstance;
let config: Config;
let ceo: TestStaff & { token: string };
let rene: TestStaff & { token: string };
let importer: AuthedStaff;

const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });
const LIFT_REASON = 'Old-system billing reconciled with the client; SAOS bills from October.';

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name: `Synthetic ${role}`, role, password: `${role}-password-123456`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

before(async () => {
  config = await createTestConfig('billing_hold');
  app = buildServer(config, {});
  await app.ready();
  ceo = await staffWithToken('ceo-hold@example.test', 'ceo');
  rene = await staffWithToken('rene-hold@example.test', 'comms_billing');
  importer = { id: ceo.id, email: ceo.email, fullName: `${ceo.fullName} (trello import rehearsal, synthetic)`, roleKey: 'ceo', permissions: [], sessionId: 'synthetic' };
});

after(async () => {
  await app.close();
});

let seq = 0;
/** A client with a business, the shape a matched 04b row resolves to. */
async function client(): Promise<{ contactId: string; businessId: string }> {
  seq++;
  const c = await makeContact(app.db, { firstName: 'Held', lastName: `Client${seq}`, email: `held.client${seq}@example.test` });
  await app.db.query(`UPDATE contacts SET soto_status = 'active' WHERE id = $1`, [c.id]);
  return { contactId: c.id, businessId: await businessFor(app.db, c.id) };
}
/** The importer's own door: a live sales-tax fact on a client with no such engagement. */
async function importedSalesTax(): Promise<{ contactId: string; businessId: string; engagementId: string }> {
  const { contactId, businessId } = await client();
  const r = await applyRecurringServiceFact(app, importer, {
    factType: 'sales_tax', sourceId: `st-hold-${seq}`, matchKey: 'HELD CLIENT', asOf: '2026-09-19', appliedBy: importer.fullName,
    sourceTag: 'trello_2026-09-19', contactId, businessId, values: { frequency: 'monthly', closed_or_not_client: false },
  });
  assert.equal(r.outcome, 'applied');
  assert.equal(r.engagementCreated, true);
  return { contactId, businessId, engagementId: r.engagementId! };
}
async function hold(engagementId: string): Promise<{ billing_hold: boolean; billing_hold_reason: string | null; billing_hold_lifted_at: Date | null; billing_hold_lifted_by: string | null; billing_hold_lift_reason: string | null }> {
  const { rows } = await app.db.query<{ billing_hold: boolean; billing_hold_reason: string | null; billing_hold_lifted_at: Date | null; billing_hold_lifted_by: string | null; billing_hold_lift_reason: string | null }>(
    `SELECT billing_hold, billing_hold_reason, billing_hold_lifted_at, billing_hold_lifted_by, billing_hold_lift_reason FROM engagements WHERE id = $1`, [engagementId]);
  return rows[0]!;
}
async function invoicesFor(contactId: string): Promise<number> {
  const { rows } = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM invoices WHERE contact_id = $1`, [contactId]);
  return rows[0]!.n;
}
async function refusalsFor(engagementId: string): Promise<Array<{ via: string }>> {
  const { rows } = await app.db.query<{ via: string }>(
    `SELECT details->>'via' AS via FROM audit_log WHERE action = 'invoice.refused_billing_hold' AND object_id = $1 ORDER BY occurred_at`, [engagementId]);
  return rows;
}
/** A price-book line the manual route accepts: the first active flat-priced, quotable, non-pass-through item. */
async function anyLineCode(): Promise<string> {
  const { rows } = await app.db.query<{ item_code: string }>(
    `SELECT pbi.item_code FROM price_book_items pbi JOIN price_book_versions v ON v.id = pbi.version_id
      WHERE pbi.is_active AND pbi.amount_cents IS NOT NULL AND NOT pbi.is_pass_through AND pbi.display_on_quote
        AND v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)
      ORDER BY pbi.item_code LIMIT 1`);
  return rows[0]!.item_code;
}

// ── THE HOLD IS PLACED BY THE IMPORT, ON WHAT IT CREATES ───────────────────

test('R68: an ongoing engagement the import creates is held for billing with the importer’s sentence, audited; one a person opened is found, not held', async () => {
  const made = await importedSalesTax();
  const h = await hold(made.engagementId);
  assert.equal(h.billing_hold, true, 'held');
  assert.equal(h.billing_hold_reason, IMPORT_BILLING_HOLD_REASON);
  assert.equal(h.billing_hold_reason, 'Imported from Trello; billing starts when the CEO lifts the hold.', 'the sentence Brian ruled, verbatim');
  assert.equal(h.billing_hold_lifted_at, null);
  const placed = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'engagement.billing_hold_placed' AND object_id = $1`, [made.engagementId]);
  assert.equal(placed.rows[0]!.n, 1, 'one audit row for the placing');

  // A payroll fact holds its payroll engagement the same way.
  const { contactId, businessId } = await client();
  const payroll = await applyRecurringServiceFact(app, importer, {
    factType: 'payroll', sourceId: `pr-hold-${seq}`, matchKey: 'HELD CLIENT', asOf: '2026-09-19', appliedBy: importer.fullName,
    sourceTag: 'trello_2026-09-19', contactId, businessId, values: { provider: 'Gusto', closed_or_none: false },
  });
  assert.equal((await hold(payroll.engagementId!)).billing_hold, true, 'payroll held too');

  // FOUND, NOT CREATED: a person opened this sales_tax engagement in SAOS; the import uses it and holds nothing.
  const own = await client();
  const opened = await createEngagement(app, importer, {
    contactId: own.contactId, businessId: own.businessId, serviceLine: 'sales_tax', title: 'Sales tax filings', status: 'active', periodKey: 'ongoing',
    origin: { via: 'staff', reason: 'Opened by hand for the spec: the client engaged sales-tax filings by phone' },
  }, { ip: null, userAgent: 'spec' });
  const found = await applyRecurringServiceFact(app, importer, {
    factType: 'sales_tax', sourceId: `st-found-${seq}`, matchKey: 'OWN CLIENT', asOf: '2026-09-19', appliedBy: importer.fullName,
    sourceTag: 'trello_2026-09-19', contactId: own.contactId, businessId: own.businessId, values: { frequency: 'quarterly', closed_or_not_client: false },
  });
  assert.equal(found.engagementId, opened.id, 'the import used the engagement the person made');
  assert.equal(found.engagementCreated, false);
  assert.equal((await hold(opened.id)).billing_hold, false, 'a person’s engagement is never held by the import');
});

// ── EVERY FACTORY REFUSES A HELD ENGAGEMENT ────────────────────────────────

test('R68: the manual invoice route refuses a held engagement 409 billing_hold, naming the engagement, audited; nothing is written', async () => {
  const made = await importedSalesTax();
  const res = await app.inject({
    method: 'POST', url: '/invoices', headers: auth(rene),
    payload: { contactId: made.contactId, engagementId: made.engagementId, lines: [{ code: await anyLineCode() }], send: false },
  });
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().error, 'billing_hold');
  assert.match(res.json().message, /Billing is on hold for "Sales tax filings" \(sales_tax\): Imported from Trello; billing starts when the CEO lifts the hold\./);
  assert.match(res.json().message, /Lift the hold on the client page before invoicing it\./);
  assert.equal(await invoicesFor(made.contactId), 0, 'no invoice row');
  assert.deepEqual((await refusalsFor(made.engagementId)).map((r) => r.via), ['createInvoice']);
  // The refusal names the engagement, never the client.
  const audit = await app.db.query<{ details: Record<string, unknown> }>(`SELECT details FROM audit_log WHERE action = 'invoice.refused_billing_hold' AND object_id = $1`, [made.engagementId]);
  assert.equal(JSON.stringify(audit.rows[0]!.details).includes('Held'), false, 'no client name in the audit row');
});

test('R68: the deposit path (createInvoice as quote acceptance calls it) refuses a held engagement', async () => {
  const made = await importedSalesTax();
  await assert.rejects(
    createInvoice(app, { type: 'system', label: 'quote acceptance' }, {
      contactId: made.contactId, engagementId: made.engagementId, isDepositInvoice: true, send: false,
      lines: [{ description: 'Deposit', unitCents: 100, qty: 1 }],
    }),
    (err: unknown) => (err as { code?: string; statusCode?: number }).code === 'billing_hold' && (err as { statusCode?: number }).statusCode === 409
  );
  assert.equal(await invoicesFor(made.contactId), 0);
});

/** A business return at filed with a final fee and no invoice, the shape the two return factories bill. */
async function filedReturn(): Promise<{ contactId: string; businessId: string; engagementId: string; teId: string }> {
  const { contactId, businessId } = await client();
  const eng = await createEngagement(app, importer, {
    contactId, businessId, serviceLine: 'tax', title: 'Business return', status: 'active', periodKey: '2025',
    origin: { via: 'staff', reason: 'Opened by hand for the spec: the return arrived by referral' },
  }, { ip: null, userAgent: 'spec' });
  const fee = await app.db.query<{ amount_cents: number }>(
    `SELECT pbi.amount_cents FROM price_book_items pbi JOIN price_book_versions v ON v.id = pbi.version_id
      WHERE pbi.is_active AND pbi.amount_cents IS NOT NULL AND v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)
        AND pbi.item_code = 'BIZ_1120S' LIMIT 1`);
  const te = await app.db.query<{ id: string }>(
    `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, client_type, stage, final_fee_cents, discount_cents)
     VALUES ($1, 2025, '1120s', 'business', 'filed', $2, 0) RETURNING id`, [eng.id, fee.rows[0]!.amount_cents]);
  return { contactId, businessId, engagementId: eng.id, teId: te.rows[0]!.id };
}

test('R68: the filed-return factory COUNTS a held engagement — audited, a task for billing, the filing not failed — and invoices once the hold is lifted', async () => {
  const r = await filedReturn();
  await placeBillingHold(app, r.engagementId, IMPORT_BILLING_HOLD_REASON, { type: 'staff', id: ceo.id, label: 'spec' });

  const held = await invoiceForFiledEngagement(app, { staffId: null, label: 'filed automation (spec)' }, r.teId);
  assert.deepEqual(held, { invoiced: false, refused: 'billing_hold' }, 'a counted suppression, not a throw');
  assert.equal(await invoicesFor(r.contactId), 0, 'no invoice row');
  assert.deepEqual((await refusalsFor(r.engagementId)).map((x) => x.via), ['invoiceForFiledEngagement']);
  const task = await app.db.query<{ title: string; status: string; engagement_id: string | null }>(
    `SELECT title, status::text AS status, engagement_id FROM tasks WHERE source_type = 'invoice_billing_hold' AND source_id = $1`, [r.teId]);
  assert.equal(task.rows.length, 1, 'one task for the person who lifts and invoices');
  assert.match(task.rows[0]!.title, /^Filed under a billing hold: .* \(2025 1120S\) — lift the hold, then invoice$/);
  assert.equal(task.rows[0]!.engagement_id, r.engagementId);
  const te = await app.db.query<{ invoice_number: string | null; payment_status: string | null }>(`SELECT invoice_number, payment_status::text AS payment_status FROM tax_engagements WHERE id = $1`, [r.teId]);
  assert.equal(te.rows[0]!.invoice_number, null, 'the return is not stamped invoiced');

  // A second pass while held: the same task, not a second one.
  await invoiceForFiledEngagement(app, { staffId: null, label: 'filed automation (spec)' }, r.teId);
  assert.equal((await app.db.query(`SELECT 1 FROM tasks WHERE source_type = 'invoice_billing_hold' AND source_id = $1`, [r.teId])).rowCount, 1);

  // Lifted: the same factory invoices.
  const lift = await app.inject({ method: 'POST', url: `/engagements/${r.engagementId}/billing-hold/lift`, headers: auth(ceo), payload: { reason: LIFT_REASON } });
  assert.equal(lift.statusCode, 200, lift.body);
  const after = await invoiceForFiledEngagement(app, { staffId: null, label: 'filed automation (spec)' }, r.teId);
  assert.deepEqual(after, { invoiced: true });
  assert.equal(await invoicesFor(r.contactId), 1);
});

test('R68: the consolidated group invoice refuses when any member return’s engagement is held', async () => {
  const r = await filedReturn();
  const group = await app.db.query<{ id: string }>(`INSERT INTO entity_groups (name, billing_mode) VALUES ('Synthetic Held Group', 'consolidated') RETURNING id`);
  await app.db.query(`INSERT INTO entity_group_members (group_id, business_id) VALUES ($1, $2)`, [group.rows[0]!.id, r.businessId]);
  await placeBillingHold(app, r.engagementId, IMPORT_BILLING_HOLD_REASON, { type: 'staff', id: ceo.id, label: 'spec' });

  const res = await app.inject({ method: 'POST', url: `/entity-groups/${group.rows[0]!.id}/invoice`, headers: auth(ceo), payload: { taxYear: 2025 } });
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().error, 'billing_hold');
  assert.match(res.json().message, /Billing is on hold for "Business return" \(tax\)/);
  assert.equal(await invoicesFor(r.contactId), 0);
  assert.deepEqual((await refusalsFor(r.engagementId)).map((x) => x.via), ['entity_group.invoice']);

  const lift = await app.inject({ method: 'POST', url: `/engagements/${r.engagementId}/billing-hold/lift`, headers: auth(ceo), payload: { reason: LIFT_REASON } });
  assert.equal(lift.statusCode, 200, lift.body);
  const ok = await app.inject({ method: 'POST', url: `/entity-groups/${group.rows[0]!.id}/invoice`, headers: auth(ceo), payload: { taxYear: 2025 } });
  assert.equal(ok.statusCode, 201, ok.body);
});

// ── THE LIFT: THE CEO, WITH A REASON ───────────────────────────────────────

test('R68: the lift is engagements.billing_hold.lift, explicit-only, seeded to the CEO alone; comms_billing is refused 403 in the server’s words', async () => {
  assert.ok(EXPLICIT_ONLY_PERMISSIONS.has('engagements.billing_hold.lift'), 'the wildcard does not reach it');
  const holders = await app.db.query<{ key: string }>(
    `SELECT r.key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE rp.permission = 'engagements.billing_hold.lift' ORDER BY 1`);
  assert.deepEqual(holders.rows.map((h) => h.key), ['ceo'], 'seeded to the CEO role and to no other');
  const writes = await app.db.query<{ key: string }>(
    `SELECT r.key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE rp.permission = 'engagements.write' ORDER BY 1`);
  assert.deepEqual(writes.rows.map((h) => h.key), [], 'engagements.write is held by nobody by name (the wildcard only), which is why the lift has its own permission');

  const made = await importedSalesTax();
  const refused = await app.inject({ method: 'POST', url: `/engagements/${made.engagementId}/billing-hold/lift`, headers: auth(rene), payload: { reason: LIFT_REASON } });
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.json().error, 'forbidden');
  assert.equal(refused.json().permission, 'engagements.billing_hold.lift');
  assert.equal(refused.json().message, 'This session does not hold engagements.billing_hold.lift.');
  assert.equal((await hold(made.engagementId)).billing_hold, true, 'still held');
});

test('R68: the CEO lifts with a standalone reason; the moment, the person and the reason land together, audited; the factory then invoices; a second lift is refused', async () => {
  const made = await importedSalesTax();

  const short = await app.inject({ method: 'POST', url: `/engagements/${made.engagementId}/billing-hold/lift`, headers: auth(ceo), payload: { reason: 'ok' } });
  assert.equal(short.statusCode, 400, 'reasonText(10, 1000): too short');
  const artifact = await app.inject({ method: 'POST', url: `/engagements/${made.engagementId}/billing-hold/lift`, headers: auth(ceo), payload: { reason: 'Lifting per ruling 68 as discussed' } });
  assert.equal(artifact.statusCode, 400, 'a pointer into a conversation is not a reason');
  assert.equal((await hold(made.engagementId)).billing_hold, true, 'both refusals wrote nothing');

  const before = await auditRows(app.db, 'engagement.billing_hold_lifted');
  const lift = await app.inject({ method: 'POST', url: `/engagements/${made.engagementId}/billing-hold/lift`, headers: auth(ceo), payload: { reason: LIFT_REASON } });
  assert.equal(lift.statusCode, 200, lift.body);
  assert.equal(lift.json().engagementId, made.engagementId);
  assert.equal(lift.json().contactId, made.contactId);
  const h = await hold(made.engagementId);
  assert.equal(h.billing_hold, false);
  assert.ok(h.billing_hold_lifted_at, 'the moment');
  assert.equal(h.billing_hold_lifted_by, ceo.id, 'the person');
  assert.equal(h.billing_hold_lift_reason, LIFT_REASON, 'the reason');
  assert.equal(h.billing_hold_reason, IMPORT_BILLING_HOLD_REASON, 'why it was held stays on the row');
  assert.equal(await auditRows(app.db, 'engagement.billing_hold_lifted'), before + 1);
  const audit = await app.db.query<{ actor_id: string; details: Record<string, unknown> }>(`SELECT actor_id, details FROM audit_log WHERE action = 'engagement.billing_hold_lifted' AND object_id = $1`, [made.engagementId]);
  assert.equal(audit.rows[0]!.actor_id, ceo.id);
  assert.equal(audit.rows[0]!.details.reason, LIFT_REASON);

  // The list the client page reads carries the flag both ways.
  const listed = await app.inject({ method: 'GET', url: `/engagements?contactId=${made.contactId}`, headers: auth(ceo) });
  const row = (listed.json().engagements as Array<{ id: string; billing_hold: boolean; billing_hold_reason: string | null }>).find((e) => e.id === made.engagementId)!;
  assert.equal(row.billing_hold, false);
  assert.equal(row.billing_hold_reason, IMPORT_BILLING_HOLD_REASON);

  // Lifted: the manual route invoices it.
  const inv = await app.inject({
    method: 'POST', url: '/invoices', headers: auth(rene),
    payload: { contactId: made.contactId, engagementId: made.engagementId, lines: [{ code: await anyLineCode() }], send: false },
  });
  assert.equal(inv.statusCode, 201, inv.body);
  assert.equal(await invoicesFor(made.contactId), 1);

  const again = await app.inject({ method: 'POST', url: `/engagements/${made.engagementId}/billing-hold/lift`, headers: auth(ceo), payload: { reason: LIFT_REASON } });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error, 'not_on_billing_hold');
});

test('R68: GET /engagements carries the hold and its reason for the client page', async () => {
  const made = await importedSalesTax();
  const listed = await app.inject({ method: 'GET', url: `/engagements?contactId=${made.contactId}`, headers: auth(ceo) });
  assert.equal(listed.statusCode, 200);
  const row = (listed.json().engagements as Array<{ id: string; billing_hold: boolean; billing_hold_reason: string | null; status: string }>).find((e) => e.id === made.engagementId)!;
  assert.equal(row.billing_hold, true);
  assert.equal(row.billing_hold_reason, IMPORT_BILLING_HOLD_REASON);
  assert.equal(row.status, 'active', 'a billing hold is not a work hold: the engagement stays active');
});
