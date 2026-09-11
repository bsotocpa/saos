// DECISION 1 (2026-09-09, Brian's evening ruling): a withdrawal never leaves a payable invoice
// behind. Sent/overdue invoices on the engagement are voided in the same transaction (reason
// "Engagement withdrawn: <reason>", cancellation notice through its gate); drafts are deleted.
// The database holds the invariant from both sides (migration 0085), and item 7d's query is the
// guard: no payable invoice on a withdrawn engagement, ever. Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { createQuote, sendQuote, acceptQuote } from '../src/modules/pricing/quotes.ts';
import { closeEngagement } from '../src/modules/engagements/close.ts';
import { createEngagement } from '../src/modules/engagements/service.ts';
import { invoicesOnNonActiveEngagements } from '../src/modules/engagements/deposits.ts';

let app: FastifyInstance;
let config: Config;
let ceoId = '';
const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };
const actor = () => ({ id: ceoId, email: 'ceo-wv@example.test', fullName: 'Synthetic CEO', roleKey: 'ceo' as const, permissions: ['*'], sessionId: 'test' });

async function depositItem(): Promise<string> {
  const { rows } = await app.db.query<{ item_code: string }>(
    `SELECT pbi.item_code FROM price_book_items pbi JOIN price_book_versions v ON v.id = pbi.version_id
      WHERE pbi.deposit_cents > 0 AND pbi.is_active AND pbi.display_on_quote AND pbi.amount_cents IS NOT NULL
        AND v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)
      ORDER BY pbi.item_code LIMIT 1`);
  return rows[0]!.item_code;
}

let seq = 0;
/** An accepted quote: the deposit invoice is issued (sent) and unpaid — the SA-2026-0004 shape. */
async function acceptedUnpaid() {
  seq += 1;
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: `Withdrawvoid${seq}`, email: `withdrawvoid-${seq}@example.test` });
  await app.db.query(`UPDATE contacts SET soto_status = 'active' WHERE id = $1`, [c.id]);
  const q = await createQuote(app, { contactId: c.id, lines: [{ itemCode: await depositItem() }] }, actor());
  const s = await sendQuote(app, q.id, actor());
  const acc = await acceptQuote(app, s.url.split('/').pop()!, {});
  return { contactId: c.id, engagementId: acc.engagementId, depositInvoiceId: acc.depositInvoiceId! };
}

before(async () => {
  config = await createTestConfig('withdrawvoid');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  ceoId = (await makeStaff(app.db, config, { email: 'ceo-wv@example.test', name: 'Synthetic CEO', role: 'ceo', password: 'ceo-password-1234567' })).id;
  await app.db.query(`UPDATE automations SET enabled = false WHERE key = 'void_notice'`);
});

after(async () => {
  await app.close();
});

test('withdrawing voids the attached sent invoice with the withdrawal reason, deletes drafts, and audits both on the engagement', async () => {
  const x = await acceptedUnpaid();
  const { rows: draft } = await app.db.query<{ id: string }>(
    `INSERT INTO invoices (invoice_number, contact_id, engagement_id, status, subtotal_cents, total_cents, amount_paid_cents)
     VALUES ($1, $2, $3, 'draft', 5000, 5000, 0) RETURNING id`, [`SYN-WV-D${seq}`, x.contactId, x.engagementId]);

  const r = await closeEngagement(app, x.engagementId, { outcome: 'withdrawn', reason: 'duplicate of the real engagement' }, { type: 'staff', id: ceoId, label: 'Synthetic CEO' });
  assert.equal(r.outcome, 'withdrawn');
  assert.equal(r.invoicesVoided.length, 1, 'the sent deposit invoice was voided');
  assert.deepEqual(r.draftsDeleted.length, 1, 'the draft was deleted');

  const inv = (await app.db.query<{ status: string; void_reason: string; voided_by_staff_id: string | null }>(
    `SELECT status::text AS status, void_reason, voided_by_staff_id FROM invoices WHERE id = $1`, [x.depositInvoiceId])).rows[0]!;
  assert.equal(inv.status, 'void');
  assert.equal(inv.void_reason, 'Engagement withdrawn: duplicate of the real engagement');
  assert.equal(inv.voided_by_staff_id, ceoId, 'voided by the person who withdrew');
  assert.equal((await app.db.query(`SELECT 1 FROM invoices WHERE id = $1`, [draft[0]!.id])).rows.length, 0, 'the draft is gone');

  // The cancellation notice went through its gate (OFF here): held, recorded, not sent.
  const held = await app.db.query(`SELECT 1 FROM outbox WHERE object_id = $1 AND effect = 'invoice.void_notice'`, [x.depositInvoiceId]);
  assert.equal(held.rows.length, 1, 'the notice is an intent through the gate');

  const audit = (await app.db.query<{ details: { invoices_voided: string[]; drafts_deleted: string[] } }>(
    `SELECT details FROM audit_log WHERE action = 'engagement.closed' AND object_id = $1`, [x.engagementId])).rows[0]!;
  assert.equal(audit.details.invoices_voided.length, 1);
  assert.equal(audit.details.drafts_deleted.length, 1);
});

test('the invariant is the database\'s: a raw status change to withdrawn with a sent invoice attached is refused, and a payable invoice cannot land on withdrawn work', async () => {
  const x = await acceptedUnpaid();
  await assert.rejects(
    app.db.query(`UPDATE engagements SET status = 'withdrawn' WHERE id = $1`, [x.engagementId]),
    (err: { constraint?: string; message: string }) => err.constraint === 'engagements_withdrawn_no_payable' && /payable invoices point at it/.test(err.message)
  );
  // Through the route it succeeds, because the route retires the invoice first.
  await closeEngagement(app, x.engagementId, { outcome: 'withdrawn', reason: 'invariant test' }, { type: 'system', label: 'test' });
  await assert.rejects(
    app.db.query(
      `INSERT INTO invoices (invoice_number, contact_id, engagement_id, status, subtotal_cents, total_cents, amount_paid_cents)
       VALUES ($1, $2, $3, 'sent', 1000, 1000, 0)`, [`SYN-WV-X${seq}`, x.contactId, x.engagementId]),
    (err: { constraint?: string }) => err.constraint === 'invoices_engagement_open'
  );
  // Paid history may stay attached: moving a paid invoice onto withdrawn work is not the rule's concern.
  const paid = await app.db.query(`SELECT 1 FROM invoices WHERE engagement_id = $1 AND status = 'void'`, [x.engagementId]);
  assert.equal(paid.rows.length, 1, 'the voided invoice stays attached as history');
});

test('7d is the guard: after withdrawals, no payable invoice sits on any non-active engagement', async () => {
  const x = await acceptedUnpaid();
  await closeEngagement(app, x.engagementId, { outcome: 'withdrawn', reason: 'guard test' }, { type: 'system', label: 'test' });
  const rows = await invoicesOnNonActiveEngagements(app);
  const payable = rows.filter((r) => r.status === 'draft' || r.status === 'sent' || r.status === 'overdue');
  assert.deepEqual(payable, [], `payable invoices on non-active engagements: ${JSON.stringify(payable)}`);
});

test('completing an engagement with an unpaid invoice is still allowed (DECISION-PENDING: the collection tail)', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Completetail', email: 'completetail@example.test' });
  const e = await createEngagement(app, actor(), { contactId: c.id, serviceLine: 'bookkeeping', title: 'Done, unpaid', status: 'active' }, {});
  await app.db.query(
    `INSERT INTO invoices (invoice_number, contact_id, engagement_id, status, subtotal_cents, total_cents, amount_paid_cents, sent_at)
     VALUES ('SYN-WV-TAIL', $1, $2, 'sent', 1000, 1000, 0, now())`, [c.id, e.id]);
  const r = await closeEngagement(app, e.id, { outcome: 'completed' }, { type: 'system', label: 'test' });
  assert.equal(r.outcome, 'completed');
  assert.deepEqual(r.invoicesVoided, [], 'completion does not void: the invoice is collected after the work');
});

/*
 * NO MONEY RECORD READS "UNKNOWN" (2026-09-10, Brian's ruling from the phone walk).
 *
 * SA-2026-0004 was voided by the withdrawal cascade under a system actor with no staff id, so
 * the invoice row on the client page said "(actor unknown)" about money. The cascade knew who
 * started it the whole time. A cascade is not anonymous: it records the mechanism AND the person.
 */
test('a cascade names itself and the person behind it — never "unknown"', async () => {
  const x = await acceptedUnpaid();
  await app.db.query(
    `UPDATE invoices SET status = 'sent', sent_at = now() WHERE id = $1`, [x.depositInvoiceId]);

  // A system actor: no staff id, the way the overnight batch and the change-order path run.
  await closeEngagement(
    app, x.engagementId,
    { outcome: 'withdrawn', reason: 'superseded by the engagement that remains open' },
    { type: 'system', label: 'Brian Soto' }
  );

  const inv = (await app.db.query<{ voided_by_staff_id: string | null; voided_by_label: string | null; void_reason: string }>(
    `SELECT voided_by_staff_id, voided_by_label, void_reason FROM invoices WHERE id = $1`, [x.depositInvoiceId])).rows[0]!;

  assert.equal(inv.voided_by_staff_id, null, 'no person pressed Void — this was the cascade');
  assert.equal(
    inv.voided_by_label,
    'system — engagement withdrawal by Brian Soto',
    'the mechanism and the person who started it, both on the record'
  );
  assert.match(inv.void_reason, /^Engagement withdrawn: /, 'the reason says what happened, in a sentence');
  assert.doesNotMatch(inv.voided_by_label ?? '', /unknown/i);
});
