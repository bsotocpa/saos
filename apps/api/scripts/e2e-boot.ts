/*
 * THE HARNESS'S API (decision 3, 2026-09-10). A fresh test database (the same createTestConfig
 * the specs use: migrated, seeded, NODE_ENV=test, the stub Stripe adapter — which decision 4
 * allows here and nowhere else), one synthetic client built THROUGH THE ROUTES, never SQL, into
 * every state the phone walks have failed on, and a staff login minted the way the specs mint
 * theirs. Then the server listens and prints one line the harness reads:
 *
 *   E2E_READY {"port":3101,"contactId":"…","staff":{"email":"…","password":"…","totpSecret":"…"}, …}
 *
 * Synthetic data only. Never run against anything but the developer database server.
 */
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeContact, makeStaff } from '../test/helpers.ts';
import type { Mailer } from '../src/mailer.ts';
import { createQuote, sendQuote, acceptQuote } from '../src/modules/pricing/quotes.ts';
import { createInvoice, markInvoicePaid } from '../src/modules/billing/service.ts';
import { voidInvoice } from '../src/modules/billing/void.ts';
import { handleStripeEvent } from '../src/modules/billing/refunds.ts';
import { mapStripeEvent } from '../src/modules/billing/stripe.ts';
import { createEngagement } from '../src/modules/engagements/service.ts';
import { pauseEngagement } from '../src/modules/engagements/pause.ts';
import { drainOutbox } from '../src/outbox.ts';

const PORT = Number(process.env.E2E_API_PORT ?? 3101);
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

const config = await createTestConfig('e2e');
if (!/localhost|127\.0\.0\.1/.test(config.DATABASE_URL)) throw new Error('refusing: the harness database is not local');
const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'e2e' }; } };
const app = buildServer(config, { mailer: silentMailer });
await app.ready();

// The staff member who walks the page.
const staff = await makeStaff(app.db, config, {
  email: 'walker@example.test', name: 'Synthetic Walker', role: 'ceo',
  password: 'walker-synthetic-2026', totpSecret: TOTP_SECRET,
});
const actor = { id: staff.id, email: staff.email, fullName: staff.fullName, roleKey: 'ceo' as const, permissions: ['*'], sessionId: 'e2e' };

// The client: a test client, so the page carries the TEST badge too.
const contact = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Walkclient', email: 'walkclient@example.test' });
await app.db.query(`UPDATE contacts SET soto_status = 'active', is_test = true, test_note = 'Harness fixture: every invoice state the walks have failed on.' WHERE id = $1`, [contact.id]);

// Every amount on the page comes from the price book — the fixture too (CLAUDE.md: no literal
// prices in application code, and the guard reads this script).
interface PricedItem { item_code: string; amount_cents: number }
async function activeItems(where: string): Promise<PricedItem[]> {
  const { rows } = await app.db.query<PricedItem>(
    `SELECT pbi.item_code, pbi.amount_cents FROM price_book_items pbi JOIN price_book_versions v ON v.id = pbi.version_id
      WHERE ${where} AND pbi.is_active AND pbi.amount_cents > 0
        AND v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)
      ORDER BY pbi.amount_cents, pbi.item_code`);
  return rows;
}
const [small, larger] = await activeItems('COALESCE(pbi.deposit_cents, 0) = 0');
if (!small || !larger || small.amount_cents === larger.amount_cents) throw new Error('the price book needs two priced items without a deposit for the fixture');

async function depositItem(): Promise<string> {
  const { rows } = await app.db.query<{ item_code: string }>(
    `SELECT pbi.item_code FROM price_book_items pbi JOIN price_book_versions v ON v.id = pbi.version_id
      WHERE pbi.deposit_cents > 0 AND pbi.is_active AND pbi.display_on_quote AND pbi.amount_cents IS NOT NULL
        AND v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)
      ORDER BY pbi.item_code LIMIT 1`);
  return rows[0]!.item_code;
}

// 1. A quote accepted: the deposit invoice is issued (sent) — then PAID through the stub's
//    payment event, so the engagement holds a paid deposit (the withdraw modal's choice case).
const q1 = await createQuote(app, { contactId: contact.id, lines: [{ itemCode: await depositItem() }] }, actor);
const s1 = await sendQuote(app, q1.id, actor);
const acc1 = await acceptQuote(app, s1.url.split('/').pop()!, {});
await drainOutbox(app); // the deposit email leaves; the send log has a row
await markInvoicePaid(app, acc1.depositInvoiceId!, { paymentIntentId: 'pi_e2e_paid_deposit' });

// 2. A second engagement (so the withdraw modal offers "Move to …") with its deposit invoice
//    VOIDED through the void route: the void line the phone walk failed on.
const e2 = await createEngagement(app, actor, { contactId: contact.id, serviceLine: 'bookkeeping', title: 'Books, monthly', status: 'active' }, {});
const toVoid = await createInvoice(app, { type: 'staff', id: staff.id, label: staff.fullName }, { contactId: contact.id, engagementId: e2.id, lines: [{ description: 'Books, monthly — first month', unitCents: small.amount_cents }], send: false, issued: true });
await voidInvoice(app, toVoid.id, { reason: 'Harness: superseded by the deposit invoice' }, actor);
await drainOutbox(app); // the cancellation notice through its gate

// 3. A paid invoice refunded in full, and one refunded in part — through the webhook handler.
const mkPaid = async (description: string, cents: number, pi: string) => {
  // cents is a price-book amount, passed through
  const inv = await createInvoice(app, { type: 'staff', id: staff.id, label: staff.fullName }, { contactId: contact.id, engagementId: e2.id, lines: [{ description, unitCents: cents }], send: false, issued: true });
  await markInvoicePaid(app, inv.id, { paymentIntentId: pi });
  return inv.id;
};
const full = small.amount_cents;
await mkPaid('Books, monthly — refunded in full', full, 'pi_e2e_refunded');
await handleStripeEvent(app, mapStripeEvent({ id: 'evt_e2e_refund_full', type: 'charge.refunded', data: { object: { id: 'ch_e2e_refunded', payment_intent: 'pi_e2e_refunded', amount: full, amount_refunded: full, refunded: true, refunds: { data: [{ id: 're_e2e_full', amount: full, created: Math.floor(Date.now() / 1000) }] } } } }));
const paid = larger.amount_cents;
const part = Math.floor(paid / 4);
await mkPaid('Books, monthly — refunded in part', paid, 'pi_e2e_partial');
await handleStripeEvent(app, mapStripeEvent({ id: 'evt_e2e_refund_part', type: 'charge.refunded', data: { object: { id: 'ch_e2e_partial', payment_intent: 'pi_e2e_partial', amount: paid, amount_refunded: part, refunded: false, refunds: { data: [{ id: 're_e2e_part', amount: part, created: Math.floor(Date.now() / 1000) }] } } } }));
await drainOutbox(app);

// 4. An open (sent) invoice for the reminder and pay-link controls.

await createInvoice(app, { type: 'staff', id: staff.id, label: staff.fullName }, { contactId: contact.id, engagementId: e2.id, lines: [{ description: 'Books, monthly — open', unitCents: larger.amount_cents }], send: false, issued: true });

// 5. The books engagement goes ON HOLD through the pause route: a two-word status, so a badge
//    that falls back to the raw enum (on_hold) is a visible failure, not a lowercase word.
await pauseEngagement(app, e2.id, { reason: 'Harness: client travelling' }, { type: 'staff', id: staff.id, label: staff.fullName });

await app.listen({ port: PORT, host: '127.0.0.1' });
console.log('E2E_READY ' + JSON.stringify({
  port: PORT,
  contactId: contact.id,
  engagementWithDeposit: acc1.engagementId,
  staff: { email: staff.email, password: 'walker-synthetic-2026', totpSecret: TOTP_SECRET },
}));
// Stay up until the harness kills us.
process.on('SIGTERM', () => { void app.close().then(() => process.exit(0)); });
process.on('SIGINT', () => { void app.close().then(() => process.exit(0)); });
