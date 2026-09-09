// Production must be on a LIVE Stripe key, and something must keep checking.
//
// 2026-09-09: the live key was installed and verified at 01:25, and a deploy at 02:29
// merged the laptop's stale test key back over it. Nothing noticed until a real card hit
// a Stripe sandbox three hours later. The rule is a pure function of config so it can be
// proved here without a server; the every-tick dependency probe applies it in production.
//
// Synthetic values only — these are not keys, they are prefixes with a label.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripeKeyModeProblem } from '../src/modules/admin/container-health.ts';

test('production on a live key is fine', () => {
  assert.equal(stripeKeyModeProblem({ NODE_ENV: 'production', STRIPE_MODE: 'live', STRIPE_SECRET_KEY: 'sk_live_synthetic' }), null);
  assert.equal(stripeKeyModeProblem({ NODE_ENV: 'production', STRIPE_MODE: 'live', STRIPE_SECRET_KEY: 'rk_live_synthetic' }), null);
});

test('production on a TEST key is the 2026-09-09 failure, named as such', () => {
  const problem = stripeKeyModeProblem({ NODE_ENV: 'production', STRIPE_MODE: 'live', STRIPE_SECRET_KEY: 'sk_test_synthetic' });
  assert.ok(problem, 'a test key in production is a problem');
  assert.match(problem, /TEST key/);
  assert.match(problem, /sandbox/);
});

test('production in stub mode is the August failure (Pay returns 503), also named', () => {
  const problem = stripeKeyModeProblem({ NODE_ENV: 'production', STRIPE_MODE: 'stub', STRIPE_SECRET_KEY: 'sk_live_synthetic' });
  assert.ok(problem);
  assert.match(problem, /503/);
});

test('a missing or unrecognisable key in production is a problem, not a pass', () => {
  assert.ok(stripeKeyModeProblem({ NODE_ENV: 'production', STRIPE_MODE: 'live' }));
  assert.ok(stripeKeyModeProblem({ NODE_ENV: 'production', STRIPE_MODE: 'live', STRIPE_SECRET_KEY: 'not-a-key' }));
});

test('outside production the key is nobody\u2019s business — dev and test run sandboxes on purpose', () => {
  assert.equal(stripeKeyModeProblem({ NODE_ENV: 'development', STRIPE_MODE: 'live', STRIPE_SECRET_KEY: 'sk_test_synthetic' }), null);
  assert.equal(stripeKeyModeProblem({ NODE_ENV: 'test', STRIPE_MODE: 'stub' }), null);
});
