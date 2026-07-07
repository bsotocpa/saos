// Live Stripe test-mode check (parked at M13, unblocked by Brian's sk_test
// keys). Exercises the REAL SDK through our adapter:
//   1. checkout.sessions.create with an amount from the PRICE BOOK (no
//      dollar literals in app code — CLAUDE.md)
//   2. webhook signature verification via stripe.webhooks.constructEvent —
//      a correctly signed payload parses, a tampered one is refused.
// Rerunnable against staging/production later (it reads .env.production).
//
//   node scripts/live-stripe-check.ts

import { createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';
import { loadConfig } from '../src/config.ts';
import { makeStripeAdapter } from '../src/modules/billing/stripe.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const prodEnv = dotenv.parse(await readFile(path.resolve(here, '../../../.env.production'), 'utf8'));
const secretKey = prodEnv['STRIPE_SECRET_KEY'];
if (!secretKey?.startsWith('sk_')) {
  console.error('live-stripe-check: no STRIPE_SECRET_KEY in .env.production.');
  process.exit(1);
}
if (secretKey.startsWith('sk_live_')) {
  console.error('live-stripe-check: refusing to run against LIVE-mode keys — this check creates checkout sessions.');
  process.exit(1);
}

const whsec = `whsec_${randomBytes(24).toString('hex')}`; // self-signed verification below
const config = loadConfig({
  STRIPE_MODE: 'live',
  STRIPE_SECRET_KEY: secretKey,
  STRIPE_WEBHOOK_SECRET: whsec,
});
const adapter = makeStripeAdapter(config);

// Amount from the price book in force (dev DB) — never a literal.
const db = new pg.Pool({ connectionString: config.DATABASE_URL });
const { rows } = await db.query<{ amount_cents: number; name_en: string }>(
  `SELECT i.amount_cents, i.name_en
   FROM price_book_items i
   JOIN price_book_versions v ON v.id = i.version_id
   WHERE i.item_code = 'DEPOSIT_1040'
     AND v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)`
);
await db.end();
const item = rows[0];
if (!item?.amount_cents) {
  console.error('live-stripe-check: DEPOSIT_1040 not found in the current price book.');
  process.exit(1);
}

console.log(`check: [1/3] creating a REAL test-mode checkout session (${item.name_en}, from the price book)...`);
const session = await adapter.createCheckoutSession({
  invoiceId: 'live-check-synthetic',
  invoiceNumber: 'SA-LIVE-CHECK',
  amountCents: item.amount_cents,
  description: `SAOS live-wire check — ${item.name_en}`,
  customerEmail: 'live-check@sotoaccounting.com',
  successUrl: 'https://portal.sotoaccounting.com/invoices?paid=1',
  cancelUrl: 'https://portal.sotoaccounting.com/invoices',
});
console.log(`check:   session ${session.sessionId}`);
console.log(`check:   url host ${new URL(session.url).host}`);

console.log('check: [2/3] webhook signature — correctly signed payload must parse...');
const payload = Buffer.from(
  JSON.stringify({
    id: 'evt_live_check',
    object: 'event',
    type: 'checkout.session.completed',
    data: { object: { id: session.sessionId, object: 'checkout.session', payment_intent: 'pi_live_check', metadata: { invoice_id: 'live-check-synthetic' } } },
  })
);
const t = Math.floor(Date.now() / 1000);
const sign = (body: Buffer) => `t=${t},v1=${createHmac('sha256', whsec).update(`${t}.${body.toString('utf8')}`).digest('hex')}`;
const parsed = adapter.parseWebhookEvent({ 'stripe-signature': sign(payload) }, payload, config.WEBHOOK_SECRET);
if (parsed.type !== 'payment_completed' || parsed.invoiceId !== 'live-check-synthetic') {
  console.error(`check: FAIL — signed event did not parse as payment_completed: ${JSON.stringify(parsed)}`);
  process.exit(1);
}
console.log('check:   parsed as payment_completed with the right invoice id');

console.log('check: [3/3] webhook signature — tampered payload must be REFUSED...');
const tampered = Buffer.from(payload.toString('utf8').replace('live-check-synthetic', 'attacker-invoice'));
try {
  adapter.parseWebhookEvent({ 'stripe-signature': sign(payload) }, tampered, config.WEBHOOK_SECRET);
  console.error('check: FAIL — tampered payload was accepted.');
  process.exit(1);
} catch {
  console.log('check:   refused (signature mismatch) — exactly right');
}

console.log('check: LIVE STRIPE TEST-MODE CHECK PASSED.');
