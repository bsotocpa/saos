// Does the signing secret on this box verify? Runs inside saos-api-1, called by
// install-stripe-live.sh (decision 2, 2026-09-10) to decide whether the webhook endpoint must be
// recreated (a new secret) or only updated in place (the secret is fine).
//
// Stripe never reveals a secret twice, so the only local proof is the one verify-stripe-live.mjs
// already used: sign a synthetic event with the stored secret exactly the way Stripe does, post
// it to the running API's webhook, and expect the signature to be ACCEPTED — then forge one and
// expect it REJECTED. Exit 0 when both hold. No secret is printed; nothing is charged.
import { createHmac } from 'node:crypto';

const secret = process.env.STRIPE_WEBHOOK_SECRET ?? '';
const url = process.env.WEBHOOK_LOCAL_URL ?? 'http://127.0.0.1:3001/webhooks/stripe';
if (!secret) { console.log('no STRIPE_WEBHOOK_SECRET on this box'); process.exit(2); }

const payload = JSON.stringify({ id: 'evt_verify_local', object: 'event', type: 'ping.local_verification', livemode: true, data: { object: {} } });
const t = Math.floor(Date.now() / 1000);
const sign = (s) => createHmac('sha256', s).update(`${t}.${payload}`).digest('hex');

async function post(sig) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` }, body: payload });
  return res.status;
}

const genuine = await post(sign(secret));
const forged = await post(sign('whsec_not_the_secret'));
// A genuine signature is accepted (the unknown event type is answered "ignored", 200); a forged one is 401.
const ok = genuine === 200 && forged === 401;
console.log(ok ? `verified: genuine ${genuine}, forged ${forged}` : `NOT verified: genuine ${genuine}, forged ${forged}`);
process.exit(ok ? 0 : 1);
