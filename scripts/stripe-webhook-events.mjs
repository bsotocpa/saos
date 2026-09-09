#!/usr/bin/env node
/*
 * Make the Stripe webhook endpoint for this deployment subscribe to every event SAOS
 * handles, and print what it subscribes to afterwards. Read-then-write on the ENDPOINT
 * only — no charge, no refund, no customer data is touched.
 *
 * Why (2026-09-09): the first live endpoint carried two events. Brian refunded the first
 * real payment in the Stripe dashboard and SAOS kept the invoice at Paid, because a
 * refund was not something it had asked to hear about. The list below is THE list; the
 * installers use it too, so a fresh install and a repaired one agree.
 *
 * Runs inside the api container (it has the stripe SDK and the key in its environment):
 *   docker cp scripts/stripe-webhook-events.mjs saos-api-1:/app/ && \
 *   docker exec saos-api-1 node /app/stripe-webhook-events.mjs && \
 *   docker exec saos-api-1 rm /app/stripe-webhook-events.mjs
 *
 * Never prints the key or the signing secret.
 */
import Stripe from 'stripe';

export const REQUIRED_EVENTS = [
  'checkout.session.completed',
  'payment_intent.payment_failed',
  'charge.refunded',
  'charge.dispute.created',
  'charge.dispute.closed',
];

const key = process.env.STRIPE_SECRET_KEY ?? '';
const url = process.env.STRIPE_WEBHOOK_URL ?? 'https://api.sotoaccounting.com/webhooks/stripe';
if (!key) { console.error('STRIPE_SECRET_KEY is not set in this environment'); process.exit(2); }
const mode = key.startsWith('sk_live_') ? 'live' : key.startsWith('sk_test_') ? 'test' : 'unknown';

const stripe = new Stripe(key);
const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
const mine = endpoints.data.filter((e) => e.url === url);
if (mine.length === 0) {
  console.error(`no ${mode} webhook endpoint exists for ${url} — run install-stripe-${mode}.sh first`);
  process.exit(1);
}
if (mine.length > 1) {
  console.error(`WARNING: ${mine.length} endpoints share ${url}; each would deliver every event once. Updating all.`);
}
for (const ep of mine) {
  const before = [...ep.enabled_events].sort();
  const wanted = [...new Set([...before, ...REQUIRED_EVENTS])].sort();
  const missing = REQUIRED_EVENTS.filter((e) => !before.includes(e));
  if (missing.length === 0) {
    console.log(`${mode} endpoint ${ep.id}: already subscribed to all ${REQUIRED_EVENTS.length} required events`);
  } else {
    await stripe.webhookEndpoints.update(ep.id, { enabled_events: wanted });
    console.log(`${mode} endpoint ${ep.id}: added ${missing.join(', ')}`);
  }
  const after = await stripe.webhookEndpoints.retrieve(ep.id);
  console.log(`${mode} endpoint ${ep.id} status=${after.status} now subscribes to:`);
  for (const e of [...after.enabled_events].sort()) console.log(`  - ${e}`);
  const stillMissing = REQUIRED_EVENTS.filter((e) => !after.enabled_events.includes(e));
  if (stillMissing.length > 0) {
    console.error(`FAIL: still missing ${stillMissing.join(', ')}`);
    process.exit(1);
  }
}
console.log('OK: every required event is subscribed (verified by reading the endpoint back)');
