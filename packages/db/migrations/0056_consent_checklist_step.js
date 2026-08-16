/*
 * §7216 consent becomes checklist step 3 (Brian, 2026-08-16, finding #34).
 *
 * The screen has existed since #12 and RC2 was signed on it — but nothing in the portal
 * ever LINKED to it. The dashboard knew a consent was outstanding (it used the offer
 * count to suppress "you're all caught up") and gave the client no way to reach it. So a
 * client could walk the whole checklist to the end and never be asked, which is the seam
 * #34 exists to close.
 *
 * ORDERING IS ALREADY ENFORCED, and not by this column. `consentsToPresent` withholds
 * every offer until the Master Engagement Agreement is signed — "a consent presented
 * alongside the document a client must sign to be served is the conditioning §7216
 * prohibits". So the step cannot appear before step 2 is done, which is exactly the
 * "immediately after signing" the ruling asks for. Nothing here re-implements that.
 *
 * ANSWERED, NOT GRANTED. This column stamps when the client ANSWERED — signed or
 * declined. A checklist step that only completes on "yes" would pressure a client toward
 * consenting to finish their setup, which is the same conditioning the rule above exists
 * to prevent. Declining completes the step.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE portal_onboarding
      ADD COLUMN IF NOT EXISTS step_consent_at timestamptz;

    COMMENT ON COLUMN portal_onboarding.step_consent_at IS
      'Step 3 of the canonical journey: the client ANSWERED the Section 7216 consent — signed or declined, both complete the step. Self-completing; a step that only completed on consent would condition setup on consenting, which Section 7216 prohibits.';
  `);

  /*
   * Backfill from the consents table, which is the record. Uses the earliest ANSWER of
   * either kind, and deliberately counts 'declined' — a client who said no has answered
   * and is never re-asked, so leaving their step open would ask them again forever.
   * 'requested' is not an answer and is excluded, matching consentsToPresent.
   */
  pgm.sql(`
    UPDATE portal_onboarding po
       SET step_consent_at = c.answered_at
      FROM (
        SELECT contact_id,
               min(COALESCE(signed_at, revoked_at, created_at)) AS answered_at
          FROM consents
         WHERE type IN ('7216_use', '7216_disclose')
           AND status IN ('signed', 'declined')
         GROUP BY contact_id
      ) c
     WHERE po.contact_id = c.contact_id AND po.step_consent_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE portal_onboarding DROP COLUMN IF EXISTS step_consent_at;`);
};
