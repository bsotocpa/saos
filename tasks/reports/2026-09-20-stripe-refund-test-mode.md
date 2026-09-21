# stripe-refund-test-mode (2026-09-20)

Generated 2026-09-21T02:14:21.771Z by scripts/report-table.mjs from the log stripe-refund-test-mode.log; 1 row(s).

The proof did not run: it needs a Stripe test-mode key and the test endpoint's signing secret, supplied by name as STRIPE_TEST_SECRET_KEY (sk_test_…) and STRIPE_TEST_WEBHOOK_SECRET. Until it runs, OPS_REFUND_CONTROL stays off in production.

```sql
cd apps/api && node --test test/stripe-refund-live.spec.ts  (Stripe TEST mode; the key and signing secret read by name from STRIPE_TEST_SECRET_KEY and STRIPE_TEST_WEBHOOK_SECRET, never STRIPE_SECRET_KEY)
```

| step | what | result |
|---|---|---|
| skipped: STRIPE_TEST_SECRET_KEY not set | the proof is blocked on a Stripe test-mode key and its webhook signing secret, set by name as STRIPE_TEST_SECRET_KEY and STRIPE_TEST_WEBHOOK_SECRET | not run |
