/*
 * Brian's stop-point ruling into the PLLC SOP text (2026-08-17).
 *
 * WHY A MIGRATION AND NOT JUST THE SEED. The SOP seeder is `ON CONFLICT (slug) DO NOTHING`, so
 * that Brian's edits always win over a re-seed. Correct — and it means editing the seed alone
 * would leave production on the text that shipped an hour earlier. The ruling was "put that
 * reason IN the SOP text, so the rule survives the person who knew why", and a reason that only
 * reaches fresh databases does not survive anything.
 *
 * SCOPED TO version = 1, WHICH IS THE UN-EDITED SEED. Editing a published SOP through the app
 * bumps `version` (sops/service.ts: `sop.version + 1`). So `version = 1` means nobody has
 * touched it since seeding, and updating it cannot overwrite anyone's work. If Brian has already
 * edited this page by the time the migration runs, it correctly does nothing and the seed text
 * is the thing that has diverged — which is the outcome the DO NOTHING rule exists to produce.
 *
 * WHAT CHANGED, all three within existing sections — no heading moved, so
 * scripts/check-sop-task-alignment.mjs is unaffected:
 *
 *   1. A profession not on the IDFPR list now says WHY it stops: the client likely belongs at
 *      the SOS as an ordinary LLC, which changes what we are engaged to do, so it is a scope
 *      conversation and Brian's to have.
 *   2. An entity already correctly formed now says to TELL THE CLIENT, and frames "nothing
 *      needed" as a completed outcome rather than a failure.
 *   3. The EIN line was hedged ("usually survives... ask if unsure"). It is now definite with
 *      its reason: an Illinois statutory conversion CONTINUES THE SAME LEGAL ENTITY, so the EIN
 *      follows it — plus the one condition under which that reasoning stops holding
 *      (a dissolve-and-reform rather than a conversion), which is what makes the rule portable.
 *
 * The body text is duplicated here rather than imported from the seed, because a migration must
 * mean the same thing forever: it applies the text as it read on 2026-08-17, not whatever the
 * seed file says on the day someone rebuilds a database. The seed and this migration agree today
 * and are allowed to diverge later — that is the point of a migration.
 */

const BODY = `## Why this exists
Illinois requires a licensed professional to organise as a **PLLC**, not a plain LLC. A
licensed client operating through an LLC is improperly formed — often for years, usually
because whoever set it up did not ask about the licence.

This is a real service line, not a cleanup favour. Quote it from the price book.

**This page has one section per checklist item on the task, in the same order.** The task
names the step; this explains it. Work down the task, read the matching section here.

## What to say before anything else
The client is about to learn their entity has been wrong for years. Lead with the fix, not the
error: "Illinois wants licensed professionals in a PLLC rather than an LLC — we can convert
you, here is what it takes." Do not speculate about consequences of the years already elapsed;
that is Brian's call if the client asks.

---

### 1. Verify professional license (IDFPR)
Look the client up on the **IDFPR** licence-lookup site yourself. Do not take the licence
number from the intake form as proof — a lapsed or differently-named licence changes the
answer completely.

Record what you found: licence type, number, status, expiry. If the licence is **lapsed or
inactive**, stop here and tell Brian. A conversion for someone not currently licensed is a
different conversation, and possibly the wrong one.

**If the profession is not on the IDFPR list at all: STOP and bring it to Brian.** Not because
it is complicated, but because the likely answer is that the client belongs at the Secretary of
State as an ordinary LLC and needs no conversion — and deciding that changes what we are
engaged to do. That is a scope conversation with the client, so it is Brian's to have, not
yours. Say nothing to the client until he has had it.

### 2. Confirm current entity is improperly formed for a licensed professional
Pull the entity's actual filing from the **IL Secretary of State**, not the client's
description of it. You are confirming two things:

- the entity type on file really is an LLC (not already a PLLC someone mislabelled)
- the entity is in **good standing** — if it is not, that is a separate problem and it blocks
  the conversion. Run the SOS restoration first (see \`laura-sos-restore\`).

**If it turns out to be correctly formed already: tell the client, then close the conversion as
dismissed.** Both halves matter. They were flagged for a problem they do not have, so they hear
that from us — "we checked your filing against the licence and it is correctly formed, nothing
needed" — rather than never hearing anything.

Closing with "nothing needed" is a **completed outcome, not a failure**. We were asked whether
the entity was wrong; the answer was no; that is the work finished. Note what you checked and
close it.

### 3. Advisory session scheduled with client
Brian takes this session — it is advisory work, not admin. Your job is to get it on the
calendar with the findings from steps 1 and 2 attached, so he is not discovering the licence
type on the call.

**Check for an existing recurring session with this client before creating anything.** If they
already have a standing session, attach this to it rather than booking a second meeting.

The session is where scope and price are agreed. Nothing gets filed before it.

### 4. Articles of amendment / conversion prepared
Prepare the amendment for the client's signature. Two things that are easy to get wrong:

- the **name** must carry the PLLC designator exactly as Illinois requires; a name that reads
  fine but is not compliant comes back rejected
- the **purpose clause** has to state the professional service. A generic clause is the most
  common rejection reason

The client signs — never sign on their behalf. Send it through the portal, not as an email
attachment.

### 5. Filed with IL Secretary of State
File it, pay the fee, and **record the confirmation on the conversion record**. Keep the
stamped copy in their documents.

Filing is not the end of the step: re-check the entity on the SOS site afterwards and confirm
it now reads PLLC. A submitted filing that was quietly rejected looks identical to a successful
one from our side until someone looks.

### 6. EIN, bank, and insurance records updated
The part that gets forgotten, and the part that actually bites the client. The entity is
converted; everything pointing at it still says LLC.

- **IRS/EIN — no new EIN. Update the name on file, keep the number.** The reason, because the
  rule is useless without it: an Illinois statutory conversion **continues the same legal
  entity**. The LLC does not dissolve and a PLLC does not come into existence — one entity
  changes its organisational form, so its EIN follows it. Applying for a new one would split the
  client's tax history in two across a single continuous business.

  That reasoning is also the limit of the rule. It holds because the filing is a **statutory
  conversion**. If this client's situation is instead a dissolve-and-reform — a new entity
  formed and the old one wound up — it is a different filing and the EIN question reopens. Stop
  and ask Ana-Maria in that case, and only that case.
- **Bank** — the account name must match the new entity name or deposits start bouncing
- **Insurance** — the malpractice or professional-liability policy must name the PLLC. A policy
  naming a dissolved LLC is the worst outcome on this list
- Anything else in their own records: contracts, licences, letterhead, invoicing

When all six are ticked, set the conversion to **completed**. If a step turns out not to apply,
tick it with a note saying why — a skipped step and a done step must not look the same.

---
**⚠ Skeleton.** These steps come from what the system enforces, not from Brian dictating the procedure. Add the judgement calls, the phone wording, and the exceptions before treating this as complete.`;

exports.up = (pgm) => {
  pgm.sql(
    `UPDATE sops SET body_md = $$${BODY}$$, updated_at = now()
      WHERE slug = 'laura-pllc-conversion' AND version = 1`
  );

  /*
   * Say out loud whether it applied. A migration whose whole job is to change text is exactly
   * the kind that can no-op silently — if Brian had edited the page first, the WHERE clause
   * matches nothing and that is correct, but nobody should have to guess which happened.
   */
  pgm.sql(`
    DO $report$
    DECLARE
      v int;
    BEGIN
      SELECT version INTO v FROM sops WHERE slug = 'laura-pllc-conversion';
      IF v IS NULL THEN
        RAISE WARNING '0070: laura-pllc-conversion is not present — a fresh database will seed the new text directly.';
      ELSIF v = 1 THEN
        RAISE WARNING '0070: stop-point ruling applied to laura-pllc-conversion (still at seed version 1).';
      ELSE
        RAISE WARNING '0070: laura-pllc-conversion is at version % — hand-edited, so it was LEFT ALONE. Brian''s edit wins; re-apply the stop-point wording by hand if it is missing.', v;
      END IF;
    END
    $report$;
  `);
};

exports.down = () => {
  /*
   * Deliberately empty. The previous text hedged the EIN rule ("usually survives... ask if
   * unsure") and told nobody to inform a client whose entity was already correct. Restoring that
   * on a rollback would put a worse procedure in front of the person doing the work, to undo a
   * change that is only words. Rolling back the schema should not roll back the firm's rules.
   */
};
