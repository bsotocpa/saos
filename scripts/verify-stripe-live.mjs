// LIVE-key verification. Runs inside saos-api-1, called by install-stripe-live.sh.
//
// Same four questions as verify-stripe.mjs, with one answered a different way — because the
// test-mode version proves the payment path by CHARGING Stripe's 4242 card, and with a live key
// that is a real charge on a real account. Money must not move to prove that money can move.
//
//   1. the adapter our code actually uses reports mode 'live' (not stub)
//   2. Stripe is in LIVE mode — livemode=true, the mirror of the test check
//   3. the account can ACTUALLY take money — charges_enabled and payouts_enabled, read-only,
//      which is what the 4242 charge was really testing: not "does Stripe respond" but "is this
//      account able to accept a payment". An account with a live key and charges_enabled=false
//      looks configured and silently fails the first real client.
//   4. the webhook signing secret verifies a real signature AND rejects a forged one
//
// Check 4 is still the one worth staring at: an endpoint that accepts anything is worse than no
// endpoint, because it looks like it works.
//
// NOTHING HERE CREATES A CHARGE, A PAYMENT INTENT, A CUSTOMER OR ANY OTHER BILLABLE OBJECT.
// Every Stripe call below is a GET except the webhook signature, which is generated locally.
// No secret is printed.

const { loadConfig } = await import('/app/apps/api/src/config.ts');
const { makeStripeAdapter } = await import('/app/apps/api/src/modules/billing/stripe.ts');

const config = loadConfig();
let failed = 0;
const pass = (m) => console.log(`  \x1b[32mPASS\x1b[0m  ${m}`);
const fail = (m) => { console.log(`  \x1b[31mFAIL\x1b[0m  ${m}`); failed += 1; };
const info = (m) => console.log(`        ${m}`);

// ── 1. Our adapter ───────────────────────────────────────────────────────────
const adapter = makeStripeAdapter(config);
if (adapter.mode === 'live') pass("the adapter our code uses reports mode 'live' (not the stub)");
else fail(`the adapter reports mode '${adapter.mode}' — the app is not talking to Stripe`);

const { default: Stripe } = await import('stripe');
const stripe = new Stripe(config.STRIPE_SECRET_KEY);

// ── 2 & 3. Live mode, and an account that can actually accept a payment ──────
try {
  const account = await stripe.accounts.retrieve();

  if (account.charges_enabled === true) {
    pass('the account can accept charges (charges_enabled = true)');
  } else {
    fail(
      'charges_enabled = false — Stripe has the key but this account CANNOT take a payment yet. ' +
        'Usually onboarding or verification is incomplete; check the Stripe dashboard home page.'
    );
  }

  if (account.payouts_enabled === true) {
    pass('and it can pay out (payouts_enabled = true)');
  } else {
    // Not fatal for taking a client's money, but Brian should know before he finds out later.
    info('NOTE: payouts_enabled = false — charges would succeed but funds would not settle out.');
    info('      Not blocking a client paying, but worth clearing with Stripe.');
  }

  info(`account ${account.id}, country ${account.country ?? '?'}, ` +
       `default currency ${(account.default_currency ?? '?').toUpperCase()}`);
} catch (err) {
  fail(`could not read the Stripe account: ${err.message}`);
}

try {
  const balance = await stripe.balance.retrieve();
  if (balance.livemode === true) {
    pass('Stripe confirms LIVE mode (livemode = true on a real object)');
  } else {
    fail('livemode = false — this is a TEST key. install-stripe-test.sh is the script for that.');
  }
} catch (err) {
  fail(`could not read the Stripe balance: ${err.message}`);
}

// ── 4. The webhook signing secret ────────────────────────────────────────────
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
  // Stripe's own signing helper, not a hand-rolled HMAC — the test-mode script learned that
  // lesson (it stripped the `whsec_` prefix, which Stripe includes in the key).
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

  try {
    adapter.parseWebhookEvent(
      { 'stripe-signature': header.replace(/,v1=[0-9a-f]+/, ',v1=' + '0'.repeat(64)) },
      Buffer.from(payload),
      config.WEBHOOK_SECRET
    );
    fail('a FORGED signature was accepted — the endpoint would trust anyone');
  } catch {
    pass('and a forged signature is REFUSED');
  }

  // Through the real HTTPS endpoint too: this exercises Caddy, the raw-body parser and the
  // route together. A signature that verifies in-process but fails over HTTP means the body was
  // mangled in between — the kind of thing that only shows up after a client has paid.
  try {
    const res = await fetch('https://api.sotoaccounting.com/webhooks/stripe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': header },
      body: payload,
    });
    if (res.ok) pass(`the live HTTPS endpoint accepts it too (HTTP ${res.status})`);
    else fail(`the live HTTPS endpoint rejected a correctly signed event (HTTP ${res.status})`);
  } catch (err) {
    fail(`could not reach the live webhook endpoint: ${err.message}`);
  }
}

console.log(
  failed === 0
    ? '\n  Verified: real adapter, LIVE mode, account able to charge, signature accepted and forgery refused.' +
      '\n  No charge was created — nothing billable was touched.'
    : `\n  ${failed} check(s) failed.`
);
process.exit(failed === 0 ? 0 : 1);
