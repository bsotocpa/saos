/*
 * CONTACT LIFECYCLE STATUS (Brian, 2026-08-16, finding #42).
 *
 * RC2's ops header read "lead · from native" for a client who had signed the Master,
 * answered §7216, paid an invoice and was using the portal. A signed paying client
 * displaying as a lead misleads triage, and the badge was also two unrelated facts wearing
 * one string — provenance and lifecycle are different questions.
 *
 * THE RULED MODEL — exactly five states, and they are EVENT-DRIVEN, never hand-set:
 *
 *   lead        contact exists, no accepted quote
 *   onboarding  quote accepted, journey incomplete
 *   active      Master signed AND at least one open engagement
 *   dormant     no open engagements, relationship intact — may return
 *   archived    deliberately closed out; the ONLY manually-set state, and needs a reason
 *
 * Transitions: acceptance advances lead→onboarding; Master signature plus an engagement
 * advances onboarding→active; the last engagement closing moves active→dormant; a new
 * accepted quote takes dormant back through onboarding→active.
 *
 * WHY soto_status SURVIVES. It is read in 111 places — broadcast audiences, health
 * scoring, reports, the migration importer — and ripping those out in the same change as
 * introducing a new lifecycle is how audience filters break silently. It stays as a
 * LEGACY MIRROR with exactly one writer: `setContactStatus()` writes both, so the two
 * cannot drift apart while readers migrate. is_test and hilo_status stay orthogonal, per
 * the ruling — they answer different questions and are not part of this ladder.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE contact_lifecycle AS ENUM ('lead', 'onboarding', 'active', 'dormant', 'archived');

    ALTER TABLE contacts
      ADD COLUMN contact_status contact_lifecycle NOT NULL DEFAULT 'lead',
      ADD COLUMN contact_status_at timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN archived_reason text;

    COMMENT ON COLUMN contacts.contact_status IS
      'Lifecycle: lead → onboarding → active → dormant, with archived as the only manually-set state. Event-driven — set by setContactStatus() from what happened, never typed in. Provenance lives in contacts.source and is a different question.';
    COMMENT ON COLUMN contacts.archived_reason IS
      'Why this relationship was closed out. Required for archived, because "archived" with no reason is indistinguishable from a mistake.';

    -- Archived is deliberate, so it must carry its reason. Enforced rather than promised.
    ALTER TABLE contacts
      ADD CONSTRAINT contacts_archived_has_reason CHECK (
        contact_status <> 'archived' OR archived_reason IS NOT NULL
      ) NOT VALID;
  `);

  /*
   * BACKFILL FROM WHAT ACTUALLY HAPPENED, most-advanced state first. Brian's requirement
   * was that RC2 reads `active` the moment this ships — so the backfill asks the same
   * questions the live transitions ask, rather than translating the old enum across.
   */
  pgm.sql(`
    -- active: a signed Master AND at least one open engagement.
    UPDATE contacts c SET contact_status = 'active'
     WHERE EXISTS (SELECT 1 FROM engagement_packets p WHERE p.contact_id = c.id AND p.status = 'signed')
       AND EXISTS (SELECT 1 FROM engagements e WHERE e.contact_id = c.id AND e.status = 'active');

    -- dormant: engagements existed and none are open now.
    UPDATE contacts c SET contact_status = 'dormant'
     WHERE contact_status = 'lead'
       AND EXISTS (SELECT 1 FROM engagements e WHERE e.contact_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM engagements e WHERE e.contact_id = c.id AND e.status = 'active');

    -- onboarding: a quote was accepted but the ladder above did not apply.
    UPDATE contacts c SET contact_status = 'onboarding'
     WHERE contact_status = 'lead'
       AND EXISTS (SELECT 1 FROM quotes q WHERE q.contact_id = c.id AND q.status = 'accepted');

    /*
     * The legacy enum's 'former' was the only value carrying a deliberate close-out, so it
     * is the only one that becomes archived. 'inactive' becomes dormant — it meant "not
     * working together right now", which is what dormant means. A reason is supplied
     * because the constraint requires one and inventing a specific one would be worse.
     */
    UPDATE contacts SET contact_status = 'archived',
                        archived_reason = 'Migrated from soto_status = former (2026-08-16); original reason not recorded.'
     WHERE soto_status = 'former';
    UPDATE contacts SET contact_status = 'dormant'
     WHERE soto_status = 'inactive' AND contact_status = 'lead';

    UPDATE contacts SET contact_status_at = now();
  `);

  pgm.sql(`ALTER TABLE contacts VALIDATE CONSTRAINT contacts_archived_has_reason;`);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE contacts
      DROP CONSTRAINT IF EXISTS contacts_archived_has_reason,
      DROP COLUMN IF EXISTS archived_reason,
      DROP COLUMN IF EXISTS contact_status_at,
      DROP COLUMN IF EXISTS contact_status;
    DROP TYPE IF EXISTS contact_lifecycle;
  `);
};
