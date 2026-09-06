/*
 * DELETE the five superseded per-service-line engagement letters. Not deactivate — delete.
 *
 * Brian's ruling 2026-09-06: "Retire the five orphans — delete, not deactivate. They're
 * unreferenced residue that already produced one false launch blocker, and their body text is a
 * warning sign that fooled the person who wrote the gate."
 *
 *   engagement_letter_tax
 *   engagement_letter_bookkeeping
 *   engagement_letter_advisory
 *   engagement_letter_coo
 *   engagement_letter_entity
 *
 * ── WHY THEY EXISTED ──
 *
 * A v1 design gave each service line its own letter. The attorney-reviewed legal package v3
 * replaced that with ONE Master Engagement Agreement plus Schedules A–F, and `seedLegalV3` marked
 * these five `is_active = false` with the reason "Superseded by the Master Engagement Agreement +
 * Schedules A–E". They were kept deliberately, on the stated grounds that they were "the terms any
 * historical engagement was signed under".
 *
 * ── WHY THAT REASON DOES NOT HOLD, WHICH IS WHAT MAKES DELETING SAFE ──
 *
 * Nothing was ever signed under them. Checked before writing this:
 *
 *   SELECT template_key, count(*) FROM signature_envelopes
 *    WHERE template_key LIKE 'engagement_letter%' GROUP BY 1;   ->  0 rows
 *
 * They are also unreachable in code: `templateKeyFor('engagement_letter')` returns
 * 'engagement_master' and ignores its service-line argument, so nothing resolves to them; they
 * carry no `has_late_fee_disclosure` (the Master carries it, and that is what the late-fee gate
 * reads); and `is_active = false` means they could not send even if something tried.
 *
 * ── WHAT THEY COST ──
 *
 * On 2026-09-06 they produced a false launch blocker. A readiness sweep queried
 * `body_en ILIKE '%PLACEHOLDER%'`, matched these five, and reported that no engagement letter
 * could be sent to a client — the headline blocker for client #1. The gate reads the
 * `is_placeholder` COLUMN, not the body. Their body matched because their body IS the warning
 * text: "⚠ PLACEHOLDER TEMPLATE — NOT FOR CLIENT USE." The search found the sign and reported the
 * hazard it warns about. The withdrawal, with the evidence, is kept in tasks/launch-readiness.md
 * rather than quietly deleted.
 *
 * A row whose only remaining function is to be mistaken for a problem is worth removing.
 *
 * ── SAFETY ──
 *
 * The delete is CONDITIONAL: if any EXECUTED envelope references one of these keys, the migration
 * raises instead of deleting, because then they really would be the terms somebody signed under
 * and the seed's original reasoning would apply after all.
 *
 * "Executed" means past draft — sent, viewed, completed. The first version of this guard refused
 * on ANY reference and immediately fired on a developer machine, against two demo-seed rows that
 * were `status = 'draft'`, `completed_at IS NULL`. It was right to make me look and wrong about
 * the condition: a queued draft that was never sent is not terms anybody agreed to. Production has
 * no envelopes referencing these keys at all, in any state.
 *
 * Remaining DRAFT envelopes are repointed to `engagement_master` rather than deleted — that is
 * what a real engagement-letter envelope points at now, so the row stays meaningful instead of
 * dangling at a template that no longer exists.
 */

const ORPHANS = [
  'engagement_letter_tax',
  'engagement_letter_bookkeeping',
  'engagement_letter_advisory',
  'engagement_letter_coo',
  'engagement_letter_entity',
];

exports.up = (pgm) => {
  pgm.sql(`
    DO $orphans$
    DECLARE
      executed int;
      repointed int;
      gone int;
    BEGIN
      -- Past draft = somebody was actually asked to sign it. That is the line.
      SELECT count(*) INTO executed
        FROM signature_envelopes
       WHERE template_key = ANY(ARRAY[${ORPHANS.map((k) => `'${k}'`).join(', ')}])
         AND (status::text <> 'draft' OR completed_at IS NOT NULL);

      IF executed > 0 THEN
        RAISE EXCEPTION
          'REFUSING to delete: % executed signature envelope(s) reference the superseded engagement letters. They are the terms somebody was actually asked to sign, so they stay. Deactivate them instead.', executed;
      END IF;

      UPDATE signature_envelopes
         SET template_key = 'engagement_master'
       WHERE template_key = ANY(ARRAY[${ORPHANS.map((k) => `'${k}'`).join(', ')}]);
      GET DIAGNOSTICS repointed = ROW_COUNT;

      DELETE FROM templates
       WHERE key = ANY(ARRAY[${ORPHANS.map((k) => `'${k}'`).join(', ')}]);
      GET DIAGNOSTICS gone = ROW_COUNT;

      RAISE WARNING '0079: deleted % superseded engagement-letter template(s); repointed % draft envelope(s) to engagement_master; 0 executed envelopes referenced them', gone, repointed;
    END
    $orphans$;
  `);
};

exports.down = () => {
  /*
   * Empty on purpose.
   *
   * What would be restored is five rows of placeholder warning text — no legal content, nothing
   * anyone signed, and the exact thing that caused a false blocker. Recreating them would be
   * restoring a tripwire. If they are ever genuinely needed the seed history has their shape, and
   * they were never anything but "⚠ PLACEHOLDER TEMPLATE — NOT FOR CLIENT USE." plus a scope and
   * fee stub.
   */
};
