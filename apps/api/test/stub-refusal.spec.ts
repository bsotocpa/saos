// DECISION 4 (2026-09-10, Brian's ruling): the stub Stripe adapter loads under NODE_ENV=test and
// nowhere else, and never beside a live key. Boot refuses and names the reason. This is also
// the sabotage Brian asked for, kept as a test: force-load the stub under production config →
// boot fails with the reason named.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.ts';
import { loadConfig } from '../src/config.ts';
import { makeStripeAdapter, stubRefusalReason } from '../src/modules/billing/stripe.ts';

const base = loadConfig({ NODE_ENV: 'test' });

test('production config with the stub: boot fails, and the failure says why', () => {
  const production = { ...base, NODE_ENV: 'production' as const, STRIPE_MODE: 'stub' as const, STRIPE_SECRET_KEY: undefined };
  assert.throws(() => buildServer(production, {}), /refusing to load the STUB Stripe adapter under NODE_ENV=production/);
  assert.throws(() => makeStripeAdapter(production), /allowed only under NODE_ENV=test/);
});

test('a live key beside the stub is refused even under test', () => {
  const liveKey = { ...base, STRIPE_MODE: 'stub' as const, STRIPE_SECRET_KEY: 'sk_live_synthetic_not_a_real_key' };
  assert.match(stubRefusalReason(liveKey) ?? '', /LIVE Stripe key is present/);
  assert.throws(() => makeStripeAdapter(liveKey), /sk_live_/);
});

test('development is not test: the stub is refused there too', () => {
  const dev = { ...base, NODE_ENV: 'development' as const, STRIPE_MODE: 'stub' as const, STRIPE_SECRET_KEY: undefined };
  assert.match(stubRefusalReason(dev) ?? '', /NODE_ENV=development/);
});

test('under test with no live key the stub loads, and the live adapter is untouched by the rule', () => {
  assert.equal(stubRefusalReason({ ...base, STRIPE_MODE: 'stub', STRIPE_SECRET_KEY: undefined }), null);
  assert.equal(makeStripeAdapter({ ...base, STRIPE_MODE: 'stub', STRIPE_SECRET_KEY: undefined }).mode, 'stub');
  assert.equal(stubRefusalReason({ NODE_ENV: 'production', STRIPE_MODE: 'live', STRIPE_SECRET_KEY: 'sk_live_x' }), null, 'the rule is about the stub only');
});
