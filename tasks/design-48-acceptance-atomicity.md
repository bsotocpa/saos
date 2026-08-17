# #48 — Quote acceptance as one atomic unit

**Status: design note, not built. Awaiting Brian's sign-off.**

Logged 2026-08-16 at Brian's instruction, queued after #44 (now complete). His framing:
*"acceptQuote creating engagements → invoices → packets in sequence with no transaction
means a mid-sequence failure leaves a client with an engagement and no invoice, or an
invoice and no packet, silently… this is the single most important write path in the
system."*

Correct on every count, and worse than that in one specific way I did not know when I wrote
#47's note. **This path has already failed in production — #41 is its fingerprint.**

---

## 1. What the path actually does

`acceptQuote()` runs from `POST /public/quote/:token/accept` — an **unauthenticated public
route**, called when the client clicks Accept. Eighteen steps, no transaction anywhere:

| # | Step | Kind |
|---|---|---|
| 1 | `quoteByToken` — reads status, throws if already accepted | read (**the guard**) |
| 2 | `expireQuote` if past expiry | write |
| 3 | `UPDATE quote_line_items SET chosen` for ticked add-ons | write |
| 4–6 | recount subtotal, read quote row, group lines by service line | read |
| 7 | `createEngagement` **× N** (one per service line) + audit each | write |
| 8 | `captureEngagementScope` **× N** (#47) | write |
| 9 | `resolveDeposit` | read |
| 10 | `createInvoice` for the deposit | write **+ outbound client email** |
| 11 | `UPDATE engagements SET deposit_treatment…` | write |
| 12 | **`UPDATE quotes SET status = 'accepted'`** | write (**the latch**) |
| 13 | `refreshContactStatus` | write |
| 14 | `setLeadStage` | write |
| 15 | read owner + implied schedules | read |
| 16 | `createTask` (the onboarding task, #17) | write |
| 17 | `notifyOnce` | write |
| 18 | `writeAudit` | write |

## 2. The failure that already happened

**The guard is at step 1 and the latch is at step 12.** Between them sit every engagement,
every scope row, and an invoice with an email attached. The latch is unconditional —
`WHERE id = $1`, no `AND status = 'sent'`, no rowCount check.

So two acceptances that overlap in that window **both pass the guard**. A double-tap on a
phone, a retried request, a client refreshing a slow page: two full sets of engagements,
two deposit invoices, two emails. Nothing anywhere detects it.

That is exactly what Brian found in #41 — two indistinguishable `tax`/`active` engagements
on `brian3712+rehearsal` plus a third already marked *"Withdrawn — duplicate accept
(rehearsal)"*. I called it "duplicate quote acceptance" at the time without a mechanism.
**This is the mechanism.** #41's fix withdrew the duplicates; it did not close the door.

The partial-failure modes Brian named are real too, and they are ranked by where the
failure lands:

- **Fails at step 7–8** (mid-loop): the client has *some* of their engagements. The quote is
  still `sent`, so they can accept again — and get a second copy of the ones that succeeded.
- **Fails at step 10**: engagements exist, no invoice, no deposit asked for. Quote still
  `sent`.
- **Fails at 13–18**: the client is charged and engaged, but no onboarding task exists, the
  contact still reads `lead`, and nobody at Soto knows to start. Silent — this is the one
  that looks like nothing happened.

## 3. Why a transaction alone is not the answer

Step 10 sends an email. Wrapping 1–18 in `BEGIN…COMMIT` would roll back the database and
**not** roll back the message already in the client's inbox — a client holding an invoice
for an engagement that no longer exists is worse than the current failure.

So the real shape is: **durable state commits atomically; outward effects happen after the
commit and are separately retryable.** That is the standard transactional-outbox split, and
it is the reason this is a design note rather than a one-line change.

There is no outbox table today, and no idempotency mechanism on any write path — I checked.
The daily jobs are idempotent per calendar date, which is a different pattern that does not
transfer to a client-triggered action.

## 4. Options

### A. Latch first, transaction around the rest (recommended)

Two changes, in this order, because the first one alone closes the production hole:

1. **Claim the quote before doing any work.** Move the latch to the top as a conditional
   update:
   ```sql
   UPDATE quotes SET status = 'accepted', accepted_at = now()
    WHERE id = $1 AND status = 'sent'
   ```
   Zero rows affected → someone else already claimed it → return the existing result
   instead of building a second one. This is a single statement, atomic by definition,
   needs no schema change, and makes the double-accept impossible.

2. **Wrap steps 3–14 in one transaction** on a dedicated client, with the deposit email and
   the notification moved *after* the commit. `createEngagement`, `createInvoice`,
   `createTask`, `writeAudit` etc. all take `app.db` today, so they need a client parameter
   threaded through — mechanical, but it touches shared billing and task code that other
   paths use. That is the bulk of the work and where the risk sits.

3. **A post-commit effects step** that sends the invoice email and fires notifications, so a
   send failure cannot roll back an acceptance that legitimately happened. Minimal version:
   do them after the commit and log failures loudly. Full version: an `outbox` table drained
   by the existing job runner, which also gives retries.

**Cost:** roughly a day. Step 1 is an hour and could ship on its own.

### B. Idempotency key on the route

Client sends a key; the server stores the first result and replays it. Solves double-submit
but not partial failure, and needs a new table plus portal changes. Weaker than A.1 for more
work.

### C. Make acceptance resumable rather than atomic

Record a `quote_acceptance_progress` marker and have a retry pick up where it stopped.
Honest for a long multi-step process, considerably more machinery, and every step has to
become individually idempotent. Over-engineered for eighteen steps that take under a second.

## 5. What I need from Brian

1. **Ship A.1 immediately, ahead of the rest?** It is one statement, it closes the hole that
   already produced duplicates in production, and it is independently testable. I recommend
   yes — the full transaction work is worth doing carefully rather than quickly, and the
   client-facing damage is all in the double-accept.
2. **How far on effects?** Post-commit send with loud logging (simple, no schema), or the
   outbox table with retries (correct, more work)? I lean post-commit-with-logging now and
   an outbox when a second path needs one, rather than building the general mechanism for a
   single caller.
3. **Scope of the client threading.** Making `createInvoice`/`createTask`/`writeAudit` accept
   a transaction client changes signatures used across billing, tasks and audit. Fine to
   touch those in #48, or would you rather that be its own piece of work?

## 6. Related, deliberately not folded in

`recordEfileResult`, packet assembly and quote *creation* have the same non-transactional
shape. Acceptance is the one that takes money and creates commitments, so it goes first —
but whatever pattern is settled here is the one the others should follow, which is another
argument for getting the shape right rather than fast.
