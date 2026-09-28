# stripe-refund-test-mode (2026-09-20)

Generated 2026-09-28T09:01:16.548Z by scripts/report-table.mjs from the log stripe-refund-test-mode.log; 16 row(s).

The Ops refund door against Stripe's real test-mode API: two test-card payments, one full refund and one partial-then-remainder through the adapter, Stripe's own charge.refunded events signed and posted to the webhook, each reconciled to the door's row and counted once on the money line; a replay is a duplicate and a forgery is refused.

```sql
cd apps/api && node --test test/stripe-refund-live.spec.ts  (Stripe TEST mode; the key and signing secret read by name from STRIPE_TEST_SECRET_KEY and STRIPE_TEST_WEBHOOK_SECRET, never STRIPE_SECRET_KEY)
```

| step | what | result |
|---|---|---|
| adapter | makeStripeAdapter with STRIPE_MODE=live and the key from STRIPE_TEST_SECRET_KEY | mode=live, keyMode=test |
| payment | PaymentIntent pi_3UKaQpITVkZx9n3n0xODfcqd for 2000 cents with pm_card_visa, linked to invoice ST-2026-A | succeeded |
| payment | PaymentIntent pi_3UKaQqITVkZx9n3n1vfzVQA5 for 2000 cents with pm_card_visa, linked to invoice ST-2026-B | succeeded |
| refund | ST-2026-A: 2000 cents through POST /invoices/:id/refund → adapter createRefund → re_3UKaQpITVkZx9n3n0A7psEEv | refunded; Stripe says succeeded for 2000 |
| refund | ST-2026-B: 750 cents through POST /invoices/:id/refund → adapter createRefund → re_3UKaQqITVkZx9n3n1xVrwo8L | partially_refunded; Stripe says succeeded for 750 |
| refund | ST-2026-B: 1250 cents through POST /invoices/:id/refund → adapter createRefund → re_3UKaQqITVkZx9n3n1K7hDErV | refunded; Stripe says succeeded for 1250 |
| charge | retrieveCharge for A and B after the refunds | A refunded=true 2000; B refunds=2 2000 |
| events | Stripe Events API listed charge.refunded for the two payments | 3 event(s): evt_3UKaQpITVkZx9n3n0UHvjgeK, evt_3UKaQqITVkZx9n3n17DfPMbN, evt_3UKaQqITVkZx9n3n1vUG5RTj |
| webhook | evt_3UKaQpITVkZx9n3n0UHvjgeK (ST-2026-A) signed with STRIPE_TEST_WEBHOOK_SECRET, POST /webhooks/stripe | refunded; recorded 0, reconciled 1, reconciledToTheDoor true |
| webhook | evt_3UKaQqITVkZx9n3n17DfPMbN (ST-2026-B) signed with STRIPE_TEST_WEBHOOK_SECRET, POST /webhooks/stripe | refunded; recorded 0, reconciled 1, reconciledToTheDoor true |
| webhook | evt_3UKaQqITVkZx9n3n1vUG5RTj (ST-2026-B) signed with STRIPE_TEST_WEBHOOK_SECRET, POST /webhooks/stripe | refunded; recorded 0, reconciled 2, reconciledToTheDoor true |
| row | ST-2026-A after the webhook | refunded, 2000 cents, 1 refund row(s) with actor and event, 1 receipt(s), audit invoice.refund_issued+invoice.refund_reconciled |
| row | ST-2026-B after the webhook | refunded, 2000 cents, 2 refund row(s) with actor and event, 2 receipt(s), audit invoice.refund_issued+invoice.refund_issued+invoice.refund_reconciled+invoice.refund_reconciled |
| money line | moneyLineToday after the webhook | byStaff A=1 B=2, outsideTheDoor 0 |
| replay | evt_3UKaQqITVkZx9n3n1vUG5RTj posted a second time | duplicate; rows, amount and receipts unchanged |
| forgery | evt_3UKaQpITVkZx9n3n0UHvjgeK signed with a wrong secret | 401 Stripe signature verification failed: No signatures found matching the expected signature for payload. Are you passing the raw request body you received from Stripe? If a webhook request is being forwarded by a third-party tool, ensure that the exact request body, including JSON formatting and new line style, is preserved. Learn more about webhook signing and explore webhook integration examples for various frameworks at https://docs.stripe.com/webhooks/signature . |
