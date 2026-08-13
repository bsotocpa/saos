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
// (the hand-rolled HMAC is gone — Stripe's own generateTestHeaderString does the signing)

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
  // Use STRIPE'S OWN signing helper rather than hand-rolling the HMAC.
  //
  // The first version of this check did roll its own and got it wrong: it stripped the
  // `whsec_` prefix before signing, but Stripe uses the WHOLE secret string as the HMAC
  // key. The result was a genuinely invalid signature, correctly rejected — a failing
  // check that said nothing about the product. Signing with the library that does the
  // verifying removes the whole class of mistake.
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });

  try {
    const event = adapter.parseWebhookEvent(
      { 'stripe-signature': header },
      Buffer.from(payload),
      config.WEBHOOK_SECRET
    );
    pass(`a correctly signed webhook is ACCEPTED (parsed as '${event.type}')`);
  } catch (err) {
    fail(`a correctly signed webhook was rejected: ${err.message}`);
  }

  // And prove it through the REAL endpoint, not just the adapter function: this
  // exercises Caddy, the raw-body content-type parser, and the route together. A
  // signature that verifies in-process but fails over HTTP means the body was mangled
  // somewhere in between, which is exactly the kind of thing that only shows up when a
  // client has already paid.
  try {
    const res = await fetch('https://api.sotoaccounting.com/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': header, 'content-type': 'application/json' },
      body: payload,
    });
    const body = await res.text();
    if (res.ok) pass(`the live endpoint accepts a signed event over HTTPS (${res.status} ${body.slice(0, 40)})`);
    else fail(`the live endpoint rejected a correctly signed event: ${res.status} ${body.slice(0, 120)}`);
  } catch (err) {
    fail(`could not reach the live webhook endpoint: ${err.message}`);
  }

  // FORGERY: take the REAL header and corrupt only its v1 digest, so the timestamp and
  // the header's shape stay valid. Anything else risks passing for the wrong reason.
  //
  // It already did once: this block used to interpolate a `ts` variable that a cleanup
  // had deleted, so it threw a ReferenceError, the bare `catch` swallowed it, and the
  // check reported "forged signature REJECTED" while testing nothing at all. A test
  // that passes for the wrong reason is worse than no test — so the catch below now
  // insists the rejection was a signature rejection.
  const forged = header.replace(/v1=[0-9a-f]+/, `v1=${'0'.repeat(64)}`);
  if (forged === header) {
    fail('could not build a forged header — the check would prove nothing');
  } else {
    try {
      adapter.parseWebhookEvent(
        { 'stripe-signature': forged },
        Buffer.from(payload),
        config.WEBHOOK_SECRET
      );
      fail('A FORGED SIGNATURE WAS ACCEPTED — anyone could mark invoices paid');
    } catch (err) {
      if (/signature/i.test(String(err?.message))) {
        pass('a forged signature is REJECTED (and rejected AS a signature failure)');
      } else {
        fail(`rejected, but for the wrong reason: ${err?.message}`);
      }
    }
  }
}

console.log(
  failed === 0
    ? '\n  Verified: real adapter, real test charge, signature accepted and forgery refused.'
    : `\n  ${failed} check(s) failed.`
);
process.exit(failed === 0 ? 0 : 1);
