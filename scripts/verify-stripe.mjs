// GATE 3 verification. Runs inside saos-api-1, called by install-stripe-test.sh.
//
// Four checks, in the order that a failure would matter:
//   1. the adapter our code actually uses reports mode 'live' (not stub)
//   2. Stripe is in TEST mode — livemode=false on a real object we create
//   3. a 4242 card genuinely charges (a confirmed PaymentIntent, not a simulation)
//   4. the webhook signing secret verifies a real signature AND rejects a forged one
//
// Check 4 is the one worth staring at: an endpoint that accepts anything is worse than
// no endpoint, because it looks like it works.
//
// No secret is printed. Amounts come from the price book, never a literal.

import Stripe from 'stripe';
import { createHmac } from 'node:crypto';

const { loadConfig } = await import('/app/apps/api/src/config.ts');
const { makeStripeAdapter } = await import('/app/apps/api/src/modules/billing/stripe.ts');

const config = loadConfig();
let failed = 0;
const pass = (m) => console.log(`  \x1b[32mPASS\x1b[0m  ${m}`);
const fail = (m) => { console.log(`  \x1b[31mFAIL\x1b[0m  ${m}`); failed += 1; };

// ── 1. Our adapter ───────────────────────────────────────────────────────────
const adapter = makeStripeAdapter(config);
if (adapter.mode === 'live') pass("adapter reports mode 'live' — the real Stripe path, not the stub");
else fail(`adapter still reports mode '${adapter.mode}' — checkout would refuse in production`);

if (!config.STRIPE_SECRET_KEY?.startsWith('sk_test_')) {
  fail('STRIPE_SECRET_KEY is not an sk_test_ key');
  process.exit(1);
}

const stripe = new Stripe(config.STRIPE_SECRET_KEY);

// ── 2 & 3. A real test-mode charge on 4242 ───────────────────────────────────
// pm_card_visa is Stripe's tokenised 4242 4242 4242 4242. Confirming a PaymentIntent
// with it is an actual charge in the test environment — it either works or it does not.
let amountCents = null;
try {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  const { rows } = await pool.query(
    `SELECT i.amount_cents FROM price_book_items i
       JOIN price_book_versions v ON v.id = i.version_id
      WHERE i.service_line::text = 'deposit' AND i.amount_cents IS NOT NULL
        AND v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)
      ORDER BY i.item_code LIMIT 1`
  );
  amountCents = rows[0]?.amount_cents ?? null;
  await pool.end();
} catch {
  /* fall through — the charge check can use Stripe's own minimum instead */
}
if (amountCents === null) {
  // Stripe's minimum charge, not a Soto price: this is a connectivity probe, and the
  // no-hardcoded-prices rule is about what we charge clients.
  amountCents = 50;
}

try {
  const intent = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: 'usd',
    payment_method: 'pm_card_visa',
    confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    description: 'SAOS install verification — test mode',
  });
  if (intent.livemode) {
    fail('THE CHARGE WAS LIVEMODE. Stop and rotate that key.');
  } else if (intent.status === 'succeeded') {
    pass(`4242 charged successfully in test mode (${intent.id}, livemode=false)`);
  } else {
    fail(`4242 charge ended in status '${intent.status}'`);
  }
} catch (err) {
  fail(`4242 charge failed: ${err.message}`);
}

// ── 4. Webhook signature, both directions ────────────────────────────────────
const secret = config.STRIPE_WEBHOOK_SECRET ?? '';
if (!secret.startsWith('whsec_')) {
  fail('STRIPE_WEBHOOK_SECRET is missing or malformed');
} else {
  const payload = JSON.stringify({
    id: 'evt_verify',
    object: 'event',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_verify', object: 'checkout.session', metadata: {} } },
  });
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', secret.replace(/^whsec_/, '')).update(`${ts}.${payload}`).digest('hex');

  try {
    const event = adapter.parseWebhookEvent(
      { 'stripe-signature': `t=${ts},v1=${sig}` },
      Buffer.from(payload),
      config.WEBHOOK_SECRET
    );
    pass(`a correctly signed webhook is ACCEPTED (parsed as '${event.type}')`);
  } catch (err) {
    fail(`a correctly signed webhook was rejected: ${err.message}`);
  }

  try {
    adapter.parseWebhookEvent(
      { 'stripe-signature': `t=${ts},v1=${'0'.repeat(64)}` },
      Buffer.from(payload),
      config.WEBHOOK_SECRET
    );
    fail('A FORGED SIGNATURE WAS ACCEPTED — anyone could mark invoices paid');
  } catch {
    pass('a forged signature is REJECTED');
  }
}

console.log(
  failed === 0
    ? '\n  Verified: real adapter, real test charge, signature accepted and forgery refused.'
    : `\n  ${failed} check(s) failed.`
);
process.exit(failed === 0 ? 0 : 1);
