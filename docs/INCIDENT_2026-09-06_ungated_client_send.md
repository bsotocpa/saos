# Ungated client send: `sos_fix_steps`

**Classification: LATENT DEFECT. Nothing sent. No client was contacted.**
Found 2026-09-06 while rewriting the ILSOS path. Written up because Brian asked the right
question — this is kill-switch integrity, not cleanup.

---

## The short answer to "what fired, and to whom"

**Nothing fired. Not today, not ever.** The email in question has never been sent to anybody, test
client or real. Evidence, queried from production rather than remembered:

| Check | Result |
|---|---|
| `messages` rows with `template_key = 'sos_fix_steps'` | **0** |
| `audit_log` rows with `action = 'sos.checked'` (ever) | **0** |
| Businesses with `il_sos_checked_at` set | **0 of 619** |
| Businesses at a status other than `unknown` | **0** |
| `email.sent` audit rows in the last 14 days | **0** |
| Last outbound email of ANY kind | **2026-08-17** |
| `email.sent` rows today | **0** |

Nothing client-facing has left the system in twenty days. Today's audit trail is entirely ops,
health checks and job records.

---

## What the defect was

`runSosCheck` sent the bilingual `sos_fix_steps` email to a client whenever an ILSOS lookup came
back `not_good_standing`. That send had:

- **no `isAutomationEnabled()` check**, and
- **no row in the `automations` table** — so there was no toggle to arm or disarm, and nothing in
  Admin → Automations that would have shown it existed.

CLAUDE.md is unambiguous: *"A client-facing send without a registered toggle + gate check is a
build failure."* It shipped as one and lived in the tree for weeks.

## Why it never fired

Two independent reasons, and neither was the gate:

1. **The candidate filter matched nobody.** `runSosRecheckJob` selected businesses whose primary
   contact was `active`. No business in this book has one — the book is 436 `lead` and 426
   `dormant`, and the two `active` contacts own no businesses. The job has run **207 times**,
   including today at 05:07 UTC, and its own record says `candidates: 0` every time.
2. **The lookup was refused anyway.** ILSOS's WAF returns 403 to every request, so even a matched
   candidate would not have reached the `not_good_standing` branch that contains the email.

So the email was unreachable behind two other defects. **That is luck, not a control** — remove
either one and an ungated client-facing send goes live. It is exactly the shape this codebase has
found repeatedly: two faults cancelling out, reported by nothing.

## Why the gate did not cover it

There was nothing to cover it with. Seven build guards ran on every commit —
prices, SOP hooks, env merge, role-guarded tasks, CSS classes, form conditionals, SOP/task
alignment — and **none of them looks for an ungated client send**. The rule existed only as a
sentence in CLAUDE.md.

The convention held everywhere else because whoever wired an automation usually remembered the
gate. `sos_fix_steps` was written as part of a *lookup* feature, and the email felt like a
consequence of the lookup rather than an automation in its own right. Convention holds until
someone's mental model of the feature differs — which is the argument for a guard rather than a
practice.

---

## The fix

**Registered and gated.** `sos_adverse_client_notice` is in `AUTOMATION_KEYS` and in the seed,
shipping **disabled**, and the send is wrapped in `isAutomationEnabled`. Suppression is logged
rather than silent. Both paths have tests: disarmed suppresses, armed sends.

Confirmed in production after deploy: the row exists and reads `enabled = f`.

**And the class is now enforced.** `scripts/check-client-send-gates.mjs` (wired into `npm test`)
finds every `sendTemplatedEmail` / `sendSms` call in the API and fails the build unless the
enclosing function checks the gate or is registered in
`apps/api/src/modules/comms/client-sends.ts` with a written reason.

### Confirmation that the guard would have caught this

Not argued — run. The pre-fix file was checked out of git (`461b7a0`) and the new guard run
against it:

```
✖ Client-facing sends that are neither gated nor registered.
  modules/entity/sos.ts:runSosCheck   (line 176)
    await sendTemplatedEmail(app, {
```

It names the file, the function and the line. The working tree was restored byte-identical
afterwards.

### What the guard found beyond this incident

Nine further client-facing sends were ungated. **All nine were examined individually and none is
an automation** — each is either transactional (a receipt for a payment the client just made, a
magic link they just requested) or human-initiated (a staff member pressing Send on a quote, an
invoice reminder, a document request, a finished close). Two are gated by something *stronger*
than a toggle: broadcasts require an approved status with a database CHECK enforcing a named
approver, and signature packets are gated by the PLACEHOLDER template check.

They are registered with those reasons rather than gated, because a toggle between a staff member
pressing Send and the message leaving is a silent failure waiting to happen — and an admin switch
over magic links is a kill switch on the front door.

---

## What this changes about arming

Nothing about the disarmed automations — 11 of 13 remain off, which is the designed state. What
changes is that **the count is now trustworthy**. Before today, "11 disarmed" described the rows
in a table, not the sends in the code; one send existed that the table did not know about. The
guard makes those two the same statement.
